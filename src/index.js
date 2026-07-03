import http from "http";
import cron from "node-cron";
import { config } from "../config/config.js";
import { log, logAction, setLogBroadcaster } from "./utils/logger.js";
import { initDb, getDb, closeDb } from "./db/index.js";
import { makeTxMiningHandler } from "./discovery/tx-mining.js";
import { discoverPools } from "./screener/pool-screener.js";
import { collectPoolSnapshot } from "./collector/snapshots.js";
import { enrichTokenInfo } from "./collector/token-info.js";
import { listStaleMints } from "./db/token-info.js";
import { runRankingCycle } from "./wallets/wallet-filter.js";
import { getTopWallets } from "./wallets/wallet-ranker.js";
import { processWalletEntry } from "./signals/validator.js";
import { buildRecord } from "./dataset/record-builder.js";
import { exportDataset } from "./dataset/exporter.js";
import { exportWalletInsights } from "./dataset/insights.js";
import { exportLaminarTrainingOutputs } from "./dataset/laminar-export.js";
import { startWebhookServer, onActivity } from "./collector/helius-stream.js";
import { fetchWalletPortfolio } from "./screener/metrics-fetcher.js";
import { mountWebui, startWebuiServer } from "./webui-server.js";
import { broadcastState, broadcastCycle, broadcastLog } from "./webui/ws-broadcaster.js";
import { touchCycle } from "./webui/state-cache.js";
import { startPolling, notifyError, notifyPerformance, notifyPoolStudy, notifyPoolWalletDiscovery, notifyPosition, isEnabled as telegramEnabled } from "./notifier/telegram.js";
import { syncPositionEvents, decodePositionBinRange } from "./collector/position-history.js";
import { getPositionEvents, getPnlFromEvents } from "./db/position-events.js";
import { runPerPoolDiscoveryEval } from "./discovery/per-pool-pipeline.js";
import { handleBotCommand, sendDailySummary } from "./notifier/bot-commands.js";
import { recalculateWeights } from "./signals/weights.js";
import { writeSmartWalletFeed } from "./laminar-feed/smart-wallet-feed.js";

// ─── cycles ────────────────────────────────────────────────────────────────────

/** Canonical discovery→evaluation flow: always sequential per-pool → per-wallet. Pacing
 *  (evalPacingMs) + the per-cycle budget (maxWalletEvalsPerCycle) live inside
 *  runPerPoolDiscoveryEval. Per-pool Telegram reports are opt-in via
 *  config.discovery.perPoolTelegramReport; otherwise the flow runs silently (state still
 *  visible on the dashboard + /status). */
async function cycleDiscoveryEval({ poolLimit = 10, followTopLimit = 20 } = {}) {
  const report = config.discovery.perPoolTelegramReport;
  const noop = async () => {};
  await runPerPoolDiscoveryEval(
    {
      notifyPool: report ? (r) => notifyPoolStudy(r) : noop,
      notifyWalletDiscovery: report ? (r) => notifyPoolWalletDiscovery(r) : noop,
      notifyPerformance: report ? (r) => notifyPerformance({ pool: r.pool, name: r.name, details: r.details }) : noop,
    },
    { poolLimit, ownerLimit: 20, evalLimitPerPool: 20, followTopLimit },
  );
}

/** Refresh the screened-pools cache (used by the signal validator's on-demand checks). */
function cycleScreening() {
  return discoverPools({ page_size: 50 });
}

/** Snapshot pools with open positions AND top-wallet current pools, so any entry gets rich context. */
async function cycleSnapshots({ poolLimit = 100, topLimit = 20 } = {}) {
  const pools = new Set();
  for (const r of getDb().prepare("SELECT DISTINCT pool_address FROM positions WHERE status = 'open'").all()) {
    pools.add(r.pool_address);
  }
  for (const w of getTopWallets({ limit: topLimit })) {
    try {
      for (const p of (await fetchWalletPortfolio(w.address)).pools) pools.add(p.poolAddress);
    } catch { /* skip unreachable wallet */ }
  }
  const targets = [...pools].slice(0, poolLimit);
  let n = 0;
  for (const p of targets) {
    if (await collectPoolSnapshot(p)) n++;
  }
  log("snapshot", `cycle: ${n}/${targets.length} pool(s) snapshotted`);
}

/** Refresh token_info (launchpad/graduated/audit/security) for stale mints — mostly-static, daily. */
async function cycleTokenInfo({ limit = 50, maxAgeSec = 86400 } = {}) {
  const mints = listStaleMints({ maxAgeSec, limit });
  let n = 0;
  for (const m of mints) {
    try {
      if (await enrichTokenInfo(m)) n++;
    } catch (err) {
      log("tokeninfo_warn", `enrich ${m?.slice(0, 8)}: ${err.message}`);
    }
  }
  log("tokeninfo", `cycle: ${n}/${mints.length} mint(s) enriched`);
}

/** Re-rank + promote/demote tiers + re-queue stale rejected wallets. */
function cycleRanking() {
  runRankingCycle();
}

/**
 * Polling signal trigger: for each top wallet, look at its current open pools and emit a signal
 * for any (wallet, pool) pair not already signaled. This makes scout produce signals without the
 * webhook (Phase 3b wires the real-time webhook path; this is the daemon's polling fallback).
 */
async function cycleSignalScan({ topLimit = 50 } = {}) {
  const tops = getTopWallets({ limit: topLimit });
  let emitted = 0;
  let scanned = 0;
  for (const w of tops) {
    let pools = [];
    try {
      pools = (await fetchWalletPortfolio(w.address)).pools;
    } catch {
      continue;
    }
    for (const p of pools) {
      scanned++;
      // Cooldown dedup lives in emitSignal (config.signals.expiryMinutes) and is shared with
      // the webhook path, so no separate permanent dedup is needed here.
      const r = await processWalletEntry(w.address, p.poolAddress);
      if (r.emitted) emitted++;
    }
  }
  log("signal", `scan: ${emitted} emitted across ${scanned} (wallet,pool) checks on ${tops.length} top wallet(s)`);
}

/**
 * Proactive Telegram alert on tracked-position closes. Each cycle picks recently-closed positions
 * that haven't been notified yet (bounded by positionNotifyWindowHours + positionNotifyBatch to
 * avoid backfill spam), sends a Metlex-style PnL card, and marks them notified.
 */
async function cyclePositionNotifications() {
  if (!telegramEnabled()) return;
  const windowHours = Number(config.signals.positionNotifyWindowHours) || 2;
  const batch = Number(config.signals.positionNotifyBatch) || 5;
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;

  const rows = getDb().prepare(
    `SELECT * FROM positions
     WHERE status = 'closed' AND close_notified_at IS NULL
       AND exit_timestamp IS NOT NULL AND exit_timestamp >= ?
     ORDER BY exit_timestamp DESC LIMIT ?`,
  ).all(cutoff, batch);
  if (!rows.length) return;

  let sent = 0;
  for (const p of rows) {
    try {
      // Best-effort: fresh event ledger + on-chain bin range. Degrade gracefully on API failure.
      try { await syncPositionEvents(p.id); } catch (err) { log("position_notify_warn", `sync ${p.id?.slice(0, 8)}: ${err.message}`); }
      const events = getPositionEvents(p.id);
      const summary = getPnlFromEvents(p.id);
      let binRange = null;
      try { binRange = (await decodePositionBinRange({ events, positionId: p.id }))?.binRange || null; } catch {}
      await notifyPosition({ positionId: p.id, position: p, summary, binRange, events });
      sent++;
    } catch (err) {
      log("position_notify_warn", `${p.id?.slice(0, 8)}: ${err.message}`);
    } finally {
      // Mark notified regardless of send outcome to avoid retry storms (window+batch bound the load).
      getDb().prepare("UPDATE positions SET close_notified_at = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000), p.id);
    }
  }
  log("position_notify", `cycle: ${sent}/${rows.length} closed position(s) notified`);
}

/**
 * Background backfill of position-event timelines: sync /positions/{addr}/historical for tracked/top
 * wallets' CLOSED positions that have no event ledger yet (most recent first). Bounded + paced so
 * position_events populates over time without on-demand clicks. (syncPositionEvents bypasses the
 * discovery breaker + is one Meteora call per position, so this is gentle on rate limits.)
 */
async function cyclePositionEventBackfill() {
  const batch = Number(config.signals.positionEventBackfillBatch) || 5;
  if (batch <= 0) return;
  const rows = getDb().prepare(
    `SELECT p.id FROM positions p
     WHERE p.status = 'closed'
       AND p.wallet_address IN (SELECT address FROM wallets WHERE is_top_wallet = 1 OR status = 'tracked')
       AND NOT EXISTS (SELECT 1 FROM position_events pe WHERE pe.position_id = p.id)
     ORDER BY p.exit_timestamp DESC
     LIMIT ?`,
  ).all(batch);
  if (!rows.length) return;
  let synced = 0;
  for (const r of rows) {
    try {
      await syncPositionEvents(r.id);
      synced++;
    } catch (err) {
      log("position_events_warn", `backfill ${r.id?.slice(0, 8)}: ${err.message}`);
    }
  }
  log("position_events", `backfill cycle: ${synced}/${rows.length} timeline(s) synced`);
}

/** Build training records for closed positions that don't have one yet; auto-export if configured. */
function buildMissingRecords() {
  const closed = getDb()
    .prepare("SELECT id FROM positions WHERE status = 'closed' AND id NOT IN (SELECT position_id FROM training_records)")
    .all();
  for (const c of closed) buildRecord(c.id);
  if (closed.length && config.dataset.autoExportOnClose) exportDataset();
  return closed.length;
}

/** Export rich wallet insights (JSON + CSV + JSONL) for tracked/top wallets. */
async function cycleInsights({ statuses = ["tracked", "top"], limit = 50 } = {}) {
  const result = await exportWalletInsights({ statuses, limit });
  log("insights", `insight export: ${result.json.length} JSON, ${result.csv.length} CSV, ${result.jsonl.length} JSONL, ${result.errors.length} error(s)`);
  return result;
}

/** Export Laminar-compatible lessons.json + OpenAI messages JSONL for manual training. */
async function cycleLaminarExport() {
  const result = await exportLaminarTrainingOutputs();
  log(
    "laminar_export",
    `Laminar training export: ${result.performanceCount} records, ${result.lessonCount} lessons, ${result.messageCount} messages, ${result.poolMemoryCount} pools, ${result.tracesCount} decision traces`,
  );
  return result;
}

// ─── scheduling helpers ─────────────────────────────────────────────────────────
const everyNMin = (n) => `*/${Math.max(1, Math.floor(n))} * * * *`;

// Per-cycle reentrancy guard: the paced discovery flow can run longer than its 15m cron interval,
// so a second tick must skip an already-running cycle instead of overlapping (concurrent DB writes,
// double API load). Each cycle name is independent.
const runningCycles = new Set();

async function runSafe(name, fn) {
  if (runningCycles.has(name)) {
    log("cron_skip", `${name} already running — skipping this tick`);
    return;
  }
  runningCycles.add(name);
  const t0 = Date.now();
  const startedAt = Math.floor(t0 / 1000);
  touchCycle(name);
  broadcastCycle(name, startedAt, null, false);
  try {
    await fn();
    const durationMs = Date.now() - t0;
    logAction({ tool: name, success: true, duration_ms: durationMs });
    touchCycle(name);
    broadcastCycle(name, startedAt, durationMs, true);
  } catch (err) {
    const durationMs = Date.now() - t0;
    log("cron_error", `${name} failed: ${err.message}`);
    logAction({ tool: name, success: false, duration_ms: durationMs, result: { error: err.message } });
    broadcastCycle(name, startedAt, durationMs, false);
    notifyError(`cycle ${name}`, err).catch((e) => log("telegram_warn", `alert failed: ${e.message}`));
  } finally {
    runningCycles.delete(name);
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  initDb();
  log("startup", `laminar-scout booted | discovery=${config.discovery.intervalMinutes}m screening=${config.collection.screeningIntervalMinutes}m snapshot=${config.collection.snapshotIntervalMinutes}m rank=${config.collection.walletRankUpdateIntervalMinutes}m | top=${getTopWallets().length}`);

  // SCOUT_RUN_ONCE: run every cycle once (bounded) then exit — used for verification/smoke.
  if (process.env.SCOUT_RUN_ONCE === "1") {
    log("startup", "SCOUT_RUN_ONCE: running all cycles once (bounded), then exiting");
    await runSafe("discovery_eval", () => cycleDiscoveryEval({ poolLimit: 3, followTopLimit: 3 }));
    await runSafe("screening", () => cycleScreening());
    await runSafe("snapshots", () => cycleSnapshots({ poolLimit: 10 }));
    await runSafe("token_info", () => cycleTokenInfo({ limit: 5 }));
    await runSafe("ranking", () => cycleRanking());
    await runSafe("signal_scan", () => cycleSignalScan({ topLimit: 5 }));
    log("startup", "SCOUT_RUN_ONCE complete");
    closeDb();
    return;
  }

  // Daemon mode: optional webhook receiver + tx-mining/signal dispatch (Phase 3b) + cron + webui + telegram.
  setLogBroadcaster(broadcastLog);
  let server;
  if (config.signals.heliusWebhookEnabled) {
    onActivity(makeTxMiningHandler());
    server = startWebhookServer();
    log("startup", "Helius webhook receiver enabled");
  } else {
    log("startup", "Helius webhook receiver disabled — Helius used only for historical backfill");
    // Minimal HTTP server for dashboard only (no webhook mounted).
    server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.listen(config.env.webhookPort, () => {
      log("startup", `dashboard server on :${config.env.webhookPort} (webhook disabled)`);
    });
  }
  server.on("error", (e) => log("fatal_error", `HTTP server error: ${e.message}`));
  mountWebui(server);
  // Dashboard is served on the default webhook server port (3001); no dedicated UI port.
  startPolling(async (msg) => {
    try { await handleBotCommand(msg.text); } catch (err) { log("telegram_error", `command handler: ${err.message}`); }
  });
  cron.schedule(everyNMin(config.discovery.intervalMinutes), () => runSafe("discovery_eval", cycleDiscoveryEval));
  cron.schedule(everyNMin(config.collection.screeningIntervalMinutes), () => runSafe("screening", cycleScreening));
  cron.schedule(everyNMin(config.collection.snapshotIntervalMinutes), () => runSafe("snapshots", cycleSnapshots));
  cron.schedule(everyNMin(60), () => runSafe("token_info", cycleTokenInfo)); // token metadata: mostly static, hourly
  cron.schedule(everyNMin(config.collection.walletRankUpdateIntervalMinutes), () => runSafe("ranking", cycleRanking));
  if (config.signals.signalScanEnabled) {
    cron.schedule(everyNMin(Math.min(15, config.collection.screeningIntervalMinutes)), () => runSafe("signal_scan", cycleSignalScan));
  } else {
    log("startup", "Polling signal scan disabled");
  }
  if (config.signals.positionNotifyEnabled) {
    cron.schedule(everyNMin(10), () => runSafe("position_notify", cyclePositionNotifications));
    log("startup", `Position-close alerts enabled (window=${config.signals.positionNotifyWindowHours}h, batch=${config.signals.positionNotifyBatch})`);
  } else {
    log("startup", "Position-close notifications disabled");
  }
  if (config.signals.positionEventBackfillEnabled) {
    cron.schedule(everyNMin(10), () => runSafe("position_events", cyclePositionEventBackfill));
    log("startup", `Position-event backfill enabled (batch=${config.signals.positionEventBackfillBatch}/cycle)`);
  } else {
    log("startup", "Position-event backfill disabled");
  }
  cron.schedule("0 0 * * *", () => runSafe("signal_weights", () => recalculateWeights(config.signalWeights || {}))); // daily Darwinian recalc
  cron.schedule("0 9 * * *", () => runSafe("daily_summary", sendDailySummary)); // daily Telegram summary at 09:00
  cron.schedule("0 2 * * *", () => runSafe("insights", cycleInsights)); // daily wallet insights export at 02:00
  cron.schedule("0 3 * * *", () => runSafe("laminar_export", cycleLaminarExport)); // daily Laminar training export at 03:00
  cron.schedule("*/10 * * * *", () => runSafe("laminar_feed", writeSmartWalletFeed)); // refresh Laminar smart-wallet feed every 10 min
  log("startup", "cron scheduled + webhook listening — daemon mode");

  const shutdown = (sig) => {
    log("startup", `${sig} received — shutting down`);
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Global safety nets: log and survive rejected promises (default Node exits the daemon),
  // and log+exit on truly uncaught synchronous exceptions so PM2 restarts cleanly.
  process.on("unhandledRejection", (reason) => {
    log("fatal_error", `unhandledRejection: ${reason?.stack || reason}`);
  });
  process.on("uncaughtException", (err) => {
    log("fatal_error", `uncaughtException: ${err?.stack || err?.message || err}`);
  });
}

boot();
