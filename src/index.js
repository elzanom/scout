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
import { startWebhookServer, onActivity } from "./collector/helius-stream.js";
import { fetchWalletPortfolio } from "./screener/metrics-fetcher.js";
import { mountWebui } from "./webui-server.js";
import { broadcastState, broadcastCycle, broadcastLog } from "./webui/ws-broadcaster.js";
import { touchCycle } from "./webui/state-cache.js";
import { startPolling, notifyError } from "./notifier/telegram.js";
import { handleBotCommand, sendDailySummary } from "./notifier/bot-commands.js";
import { recalculateWeights } from "./signals/weights.js";

// ─── cycles ────────────────────────────────────────────────────────────────────

/** Discovery → follow-winners → evaluate → build dataset records for newly-closed positions → promote top. */
async function cycleDiscoveryEval({ poolLimit = 10, evalLimit, followTopLimit = 20 } = {}) {
  await runPoolDiscovery({ poolLimit });
  await runFollowWinners({ topLimit: followTopLimit });
  await runEvaluatorBatch({ limit: evalLimit });
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

  // Daemon mode: webhook receiver + tx-mining/signal dispatch (Phase 3b) + cron + webui + telegram.
  setLogBroadcaster(broadcastLog);
  onActivity(makeTxMiningHandler());
  const server = startWebhookServer();
  mountWebui(server);
  startPolling(async (msg) => {
    try { await handleBotCommand(msg.text); } catch (err) { log("telegram_error", `command handler: ${err.message}`); }
  });
  cron.schedule(everyNMin(config.discovery.intervalMinutes), () => runSafe("discovery_eval", cycleDiscoveryEval));
  cron.schedule(everyNMin(config.collection.screeningIntervalMinutes), () => runSafe("screening", cycleScreening));
  cron.schedule(everyNMin(config.collection.snapshotIntervalMinutes), () => runSafe("snapshots", cycleSnapshots));
  cron.schedule(everyNMin(60), () => runSafe("token_info", cycleTokenInfo)); // token metadata: mostly static, hourly
  cron.schedule(everyNMin(config.collection.walletRankUpdateIntervalMinutes), () => runSafe("ranking", cycleRanking));
  cron.schedule(everyNMin(Math.min(30, config.collection.screeningIntervalMinutes)), () => runSafe("signal_scan", cycleSignalScan));
  cron.schedule("0 0 * * *", () => runSafe("signal_weights", () => recalculateWeights(config.signalWeights || {}))); // daily Darwinian recalc
  cron.schedule("0 9 * * *", () => runSafe("daily_summary", sendDailySummary)); // daily Telegram summary at 09:00
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
