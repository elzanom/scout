import http from "http";
import cron from "node-cron";
import { config } from "../config/config.js";
import { log, logAction, setLogBroadcaster } from "./utils/logger.js";
import { initDb, getDb, closeDb } from "./db/index.js";
import { runPoolDiscovery } from "./discovery/pool-discovery.js";
import { runEvaluatorBatch } from "./discovery/wallet-evaluator.js";
import { runFollowWinners } from "./discovery/follow-winners.js";
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
import { startPolling, notifyError, notifyPools, notifyWallets, notifyPerformance, notifyPoolStudy, notifyPoolWalletDiscovery } from "./notifier/telegram.js";
import { runPerPoolDiscoveryEval } from "./discovery/per-pool-pipeline.js";
import { handleBotCommand, sendDailySummary } from "./notifier/bot-commands.js";
import { recalculateWeights } from "./signals/weights.js";
import { writeSmartWalletFeed } from "./laminar-feed/smart-wallet-feed.js";

// ─── cycles ────────────────────────────────────────────────────────────────────

const PER_POOL_MODE = process.env.PER_POOL_TELEGRAM_REPORT === "1" || config.discovery.perPoolTelegramReport;

/** Discovery → follow-winners → evaluate → build dataset records for newly-closed positions → promote top.
 *  Telegram reports are sent after each milestone so the operator sees pool → wallet → performance. */
async function cycleDiscoveryEval({ poolLimit = 10, evalLimit, followTopLimit = 20 } = {}) {
  if (PER_POOL_MODE) {
    await runPerPoolDiscoveryEval(
      {
        notifyPool: (r) => notifyPoolStudy(r),
        notifyWalletDiscovery: (r) => notifyPoolWalletDiscovery(r),
        notifyPerformance: (r) => notifyPerformance({ pool: r.pool, name: r.name, details: r.details }),
      },
      { poolLimit, ownerLimit: 20, evalLimitPerPool: 20, followTopLimit },
    );
    return;
  }

  const discovery = await runPoolDiscovery({ poolLimit });
  notifyPools({
    pass: discovery.passed_pools,
    studied: discovery.studied_pools?.length,
    newCandidates: discovery.new_candidates,
    errors: discovery.errors,
  }).catch((e) => log("telegram_warn", `pool report failed: ${e.message}`));
  if (discovery.new_wallets?.length) {
    notifyWallets({ newWallets: discovery.new_wallets, source: "pool_discovery" }).catch((e) =>
      log("telegram_warn", `wallet discovery report failed: ${e.message}`));
  }

  await runFollowWinners({ topLimit: followTopLimit });
  const evalResult = await runEvaluatorBatch({ limit: evalLimit });
  if (evalResult.performanceDetails?.length) {
    notifyPerformance({ summary: evalResult.summary, details: evalResult.performanceDetails }).catch((e) =>
      log("telegram_warn", `performance report failed: ${e.message}`));
  }

  buildMissingRecords();
  runRankingCycle();
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
      const already = getDb()
        .prepare("SELECT 1 FROM signals WHERE triggered_by = ? AND pool_address = ? LIMIT 1")
        .get(w.address, p.poolAddress);
      if (already) continue;
      const r = await processWalletEntry(w.address, p.poolAddress);
      if (r.emitted) emitted++;
    }
  }
  log("signal", `scan: ${emitted} emitted across ${scanned} (wallet,pool) checks on ${tops.length} top wallet(s)`);
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

async function runSafe(name, fn) {
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
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  initDb();
  log("startup", `laminar-scout booted | discovery=${config.discovery.intervalMinutes}m screening=${config.collection.screeningIntervalMinutes}m snapshot=${config.collection.snapshotIntervalMinutes}m rank=${config.collection.walletRankUpdateIntervalMinutes}m | top=${getTopWallets().length}`);

  // SCOUT_RUN_ONCE: run every cycle once (bounded) then exit — used for verification/smoke.
  if (process.env.SCOUT_RUN_ONCE === "1") {
    log("startup", "SCOUT_RUN_ONCE: running all cycles once (bounded), then exiting");
    await runSafe("discovery_eval", () => cycleDiscoveryEval({ poolLimit: 3, evalLimit: 5, followTopLimit: 3 }));
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
}

boot();
