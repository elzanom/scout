import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { discoverPools } from "../screener/pool-screener.js";
import { studyTopLPers, runConcurrent } from "./pool-discovery.js";
import { evaluateWallet } from "./wallet-evaluator.js";
import { upsertWallet, logDiscovery } from "../db/wallets.js";
import { runFollowWinners } from "./follow-winners.js";
import { runEvaluatorBatch } from "./wallet-evaluator.js";
import { buildRecord } from "../dataset/record-builder.js";
import { exportDataset } from "../dataset/exporter.js";
import { runRankingCycle } from "../wallets/wallet-filter.js";
import { getDb } from "../db/index.js";

// Dependencies injected to avoid circular imports. Caller must provide these from index.js.
/**
 * Run a sequential, per-pool discovery + evaluation pipeline.
 *
 * For each pool that passes screening:
 *   1. Study top LPers via Agent Meridian.
 *   2. Insert new candidates.
 *   3. Evaluate each candidate wallet (sequential, max 20 per pool).
 *   4. Telegram report for the pool (wallets found + performance).
 *
 * This is intentionally slower than the batched pipeline but gives the operator a
 * clear pool-by-pool view in Telegram.
 *
 * @param {object} deps
 * @param {(opts: object) => Promise<void>} deps.notifyPool - pool report sender
 * @param {(opts: object) => Promise<void>} deps.notifyWalletDiscovery - wallet discovery sender
 * @param {(opts: object) => Promise<void>} deps.notifyPerformance - performance report sender
 * @param {{ poolLimit?: number, ownerLimit?: number, evalLimitPerPool?: number, followTopLimit?: number }} opts
 */
export async function runPerPoolDiscoveryEval(deps, { poolLimit = 10, ownerLimit = 20, evalLimitPerPool = 20, followTopLimit = 20 } = {}) {
  const { notifyPool, notifyWalletDiscovery, notifyPerformance } = deps;
  const allPassedPools = [];
  const allNewWallets = new Set();
  const allEvalResults = [];

  // Deduplication state for this cycle.
  const evaluatedThisCycle = new Set();
  const seenDataSignatures = new Map(); // signature -> first wallet address with this fingerprint

  const passes = [{ name: "trending", screening: undefined, limit: poolLimit }];
  if (config.discovery.establishedEnabled) {
    passes.push({
      name: "established",
      screening: {
        minTvl: config.discovery.establishedMinTvl,
        maxTvl: config.discovery.establishedMaxTvl,
        maxMcap: config.discovery.establishedMaxMcap,
      },
      limit: poolLimit,
    });
  }

  for (const pass of passes) {
    let pools = [];
    try {
      const r = await discoverPools({ page_size: Math.max(pass.limit, 20), screening: pass.screening });
      pools = r.pools.slice(0, pass.limit);
      allPassedPools.push(...pools);
    } catch (err) {
      log("discovery_warn", `${pass.name} discoverPools failed: ${err.message}`);
      continue;
    }
    log("discovery", `${pass.name} pass: ${pools.length} pool(s) to study sequentially`);

    for (const pool of pools) {
      const poolReport = {
        pool: pool.pool,
        name: pool.name,
        tvl: pool.tvl,
        volume: pool.volume_window,
        feeApr: pool.fee_apr,
        owners: 0,
        newWallets: [],
        errors: [],
      };

      let studied;
      try {
        studied = await studyTopLPers({ pool_address: pool.pool, limit: ownerLimit, bypassCache: false });
        poolReport.owners = studied.owners.length;
      } catch (err) {
        poolReport.errors.push(err.message);
        log("discovery_warn", `per-pool study ${pool.pool?.slice(0, 8)} failed: ${err.message}`);
        if (notifyPool) await notifyPool(poolReport).catch(() => {});
        continue;
      }

      // Insert candidates. Skip wallets whose raw on-chain footprint is identical to one
      // already processed in this cycle (same aggregate = same data). They provide no new
      // signal and repeatedly hammer Agent Meridian / Meteora endpoints.
      for (const owner of studied.owners) {
        if (!owner.address) continue;
        const sig = ownerDataSignature(owner);
        if (seenDataSignatures.has(sig)) {
          const first = seenDataSignatures.get(sig);
          log("discovery", `dedup ${owner.address.slice(0, 8)}… → identical data to ${first.slice(0, 8)}…`);
          continue;
        }
        seenDataSignatures.set(sig, owner.address);
        const { isNew } = upsertWallet({
          address: owner.address,
          source: "pool_discovery",
          discovered_from: pool.pool,
        });
        if (isNew) {
          logDiscovery({ wallet_address: owner.address, discovery_source: "pool_discovery", source_detail: pool.pool });
          poolReport.newWallets.push(owner.address);
          allNewWallets.add(owner.address);
        }
      }

      if (notifyPool) {
        await notifyPool(poolReport).catch((e) => log("telegram_warn", `pool report failed: ${e.message}`));
      }
      if (poolReport.newWallets.length && notifyWalletDiscovery) {
        await notifyWalletDiscovery({
          pool: pool.pool,
          name: pool.name,
          newWallets: poolReport.newWallets,
        }).catch((e) => log("telegram_warn", `wallet discovery report failed: ${e.message}`));
      }

      // Evaluate wallets sequentially (max evalLimitPerPool). Skip wallets already evaluated
      // in this cycle (can appear across multiple pools) and those with duplicate fingerprints.
      const toEvaluate = studied.owners
        .map((o) => o.address)
        .filter(Boolean)
        .filter((addr) => {
          if (evaluatedThisCycle.has(addr)) {
            log("discovery", `skip ${addr.slice(0, 8)}… already evaluated in this cycle`);
            return false;
          }
          evaluatedThisCycle.add(addr);
          return true;
        })
        .slice(0, evalLimitPerPool);
      const performanceDetails = [];
      for (const address of toEvaluate) {
        try {
          const result = await evaluateWallet(address);
          allEvalResults.push(result);
          if (result?.metrics) {
            performanceDetails.push({
              address,
              status: result.status,
              score: result.score ?? result.metrics?.score ?? 0,
              win_rate: result.metrics?.win_rate ?? 0,
              positions: result.metrics?.total_positions ?? 0,
              fee_yield: result.metrics?.avg_fee_yield ?? 0,
              pnl_usd: result.metrics?.total_pnl_usd ?? 0,
              reject_reason: result.reject_reason || null,
            });
          }
        } catch (err) {
          log("eval_error", `per-pool evaluate ${address?.slice(0, 8)}: ${err.message}`);
          performanceDetails.push({ address, status: "error", error: err.message });
        }
      }

      if (performanceDetails.length && notifyPerformance) {
        await notifyPerformance({
          pool: pool.pool,
          name: pool.name,
          details: performanceDetails,
        }).catch((e) => log("telegram_warn", `performance report failed: ${e.message}`));
      }
    }
  }

  // Follow winners + ranking still run once at the end.
  await runFollowWinners({ topLimit: followTopLimit });

  // Evaluate the queued candidate backlog so newly inserted wallets are promoted/rejected
  // instead of accumulating forever. This keeps performance reports varying cycle-to-cycle.
  const evalLimit = config.discovery.maxWalletCandidatesPerCycle ?? 100;
  const batch = await runEvaluatorBatch({ limit: evalLimit });
  if (batch?.summary) {
    log("eval", `per-pool pipeline candidate batch: ${batch.evaluated} → ${JSON.stringify(batch.summary)}`);
  }

  buildMissingRecords();
  runRankingCycle();

  return {
    passed_pools: allPassedPools,
    new_wallets: [...allNewWallets],
    evaluated: allEvalResults.length + (batch?.evaluated || 0),
  };
}

/**
 * Fingerprint a studied owner by its raw aggregate data. Two wallets with identical
 * aggregate values are highly likely to be duplicates / shared-custody wallets with
 * no additive signal, so we skip re-inserting/evaluating them in the same cycle.
 */
function ownerDataSignature(owner) {
  const a = owner.aggregate || {};
  return [
    owner.address,
    a.total_positions ?? a.totalPositions ?? -1,
    a.win_rate_pct ?? a.winRatePct ?? -1,
    a.total_pnl_usd ?? a.totalPnlUsd ?? -1,
    a.total_fees_usd ?? a.totalFeesUsd ?? -1,
    a.fee_percent ?? a.feePercent ?? -1,
    a.avg_age_hours ?? a.avgAgeHours ?? -1,
    (a.preferred_strategy ?? a.preferredStrategy ?? ""),
    (a.preferred_range_style ?? a.preferredRangeStyle ?? ""),
    (owner.positions || []).length,
  ].join("|");
}

/** Local copy of buildMissingRecords to avoid circular import with index.js. */
function buildMissingRecords() {
  const closed = getDb()
    .prepare("SELECT id FROM positions WHERE status = 'closed' AND id NOT IN (SELECT position_id FROM training_records)")
    .all();
  for (const c of closed) buildRecord(c.id);
  if (closed.length && config.dataset.autoExportOnClose) exportDataset();
  return closed.length;
}
