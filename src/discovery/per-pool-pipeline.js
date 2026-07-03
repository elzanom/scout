import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { sleep } from "../utils/retry.js";
import { discoverPools } from "../screener/pool-screener.js";
import { studyTopLPers } from "./pool-discovery.js";
import { evaluateWallet } from "./wallet-evaluator.js";
import { upsertWallet, logDiscovery, getWallet, listWallets } from "../db/wallets.js";
import { runFollowWinners } from "./follow-winners.js";
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

  // ── Rate-limit bounds: pace between wallets + cap the total per cycle ──
  const maxEvals = Number(config.discovery.maxWalletEvalsPerCycle) || 30;
  const pacingMs = Number(config.discovery.evalPacingMs) || 0;
  const reevalCutoff = Math.floor(Date.now() / 1000)
    - (Number(config.discovery.reEvaluateIntervalHours) || 168) * 3600;
  let evalsThisCycle = 0;
  let budgetHit = false;

  // Per-cycle deduplication state.
  const evaluatedThisCycle = new Set();
  const seenDataSignatures = new Map(); // signature -> first wallet address with this fingerprint

  /** Whether a wallet should be (re)evaluated: candidates always; tracked/top only if stale. */
  const shouldEvaluate = (address) => {
    const w = getWallet(address);
    if (!w) return true; // unknown → treat as fresh
    if (w.status === "candidate") return true;
    if ((w.status === "tracked" || w.status === "top")
      && (w.last_evaluated == null || w.last_evaluated < reevalCutoff)) return true;
    return false;
  };

  /** Evaluate one wallet with budget check, dedup, pacing. Returns result|null (null = skipped/budget). */
  const evalOne = async (address) => {
    if (budgetHit || evalsThisCycle >= maxEvals) { budgetHit = true; return null; }
    if (evaluatedThisCycle.has(address)) return null;
    evaluatedThisCycle.add(address);
    let result;
    try {
      result = await evaluateWallet(address);
      allEvalResults.push(result);
    } catch (err) {
      log("eval_error", `evaluate ${address?.slice(0, 8)}: ${err.message}`);
      return { address, status: "error", error: err.message };
    }
    evalsThisCycle++;
    if (pacingMs > 0) await sleep(pacingMs);
    return result;
  };

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
    if (budgetHit) break;
    let pools = [];
    try {
      const r = await discoverPools({ page_size: Math.max(pass.limit, 20), screening: pass.screening });
      pools = r.pools.slice(0, pass.limit);
      allPassedPools.push(...pools);
    } catch (err) {
      log("discovery_warn", `${pass.name} discoverPools failed: ${err.message}`);
      continue;
    }
    log("discovery", `${pass.name} pass: ${pools.length} pool(s) to process sequentially (budget ${maxEvals}, pace ${pacingMs}ms)`);

    for (const pool of pools) {
      if (budgetHit) break;
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
      // already processed in this cycle (same aggregate = same data).
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

      // Evaluate this pool's wallets sequentially, candidates-first. Decided wallets are skipped
      // unless stale, so each pool only does the heavy eval on wallets that need deciding.
      const performanceDetails = [];
      let evaluatedInPool = 0;
      for (const owner of studied.owners) {
        if (!owner.address || budgetHit) break;
        if (evaluatedInPool >= evalLimitPerPool) break;
        if (!shouldEvaluate(owner.address)) continue;
        const result = await evalOne(owner.address);
        if (!result) { if (budgetHit) break; continue; }
        evaluatedInPool++;
        if (result.metrics) {
          performanceDetails.push({
            address: owner.address,
            status: result.status,
            score: result.score ?? result.metrics?.score ?? 0,
            win_rate: result.metrics?.win_rate ?? 0,
            positions: result.metrics?.total_positions ?? 0,
            fee_yield: result.metrics?.avg_fee_yield ?? 0,
            pnl_usd: result.metrics?.total_pnl_usd ?? 0,
            reject_reason: result.reject_reason || null,
          });
        } else if (result.status === "error") {
          performanceDetails.push({ address: owner.address, status: "error", error: result.error });
        }
      }

      if (budgetHit) log("discovery", `budget hit (${evalsThisCycle}/${maxEvals}) — pausing after pool ${pool.name || pool.pool?.slice(0, 8)}`);
      if (performanceDetails.length && notifyPerformance) {
        await notifyPerformance({
          pool: pool.pool,
          name: pool.name,
          details: performanceDetails,
        }).catch((e) => log("telegram_warn", `performance report failed: ${e.message}`));
      }
    }
  }

  log("discovery", `pool pass complete: ${evalsThisCycle} wallet(s) evaluated${budgetHit ? " (budget-capped)" : ""}`);

  // Follow winners still runs once at the end.
  await runFollowWinners({ topLimit: followTopLimit });

  // Small paced candidate-backlog drain (replaces the old flat runEvaluatorBatch(100) tail).
  // Covers candidates from follow-winners/tx-mining that aren't in this cycle's pools.
  const backlogBatch = Number(config.discovery.backlogBatchPerCycle) ?? 10;
  if (backlogBatch > 0 && !budgetHit) {
    const backlog = listWallets({ status: "candidate", limit: backlogBatch })
      .map((w) => w.address)
      .filter((a) => a && !evaluatedThisCycle.has(a));
    let drained = 0;
    for (const address of backlog) {
      const r = await evalOne(address);
      if (r) drained++;
      else if (budgetHit) break;
    }
    if (drained) log("eval", `backlog drain: ${drained} candidate(s) (paced, ${evalsThisCycle}/${maxEvals} total)`);
  }

  buildMissingRecords();
  runRankingCycle();

  return {
    passed_pools: allPassedPools,
    new_wallets: [...allNewWallets],
    evaluated: allEvalResults.length,
    evals_this_cycle: evalsThisCycle,
    budget_hit: budgetHit,
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
