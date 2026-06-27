import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { studyTopLPers, runConcurrent } from "./pool-discovery.js";
import { fetchWalletPortfolio } from "../screener/metrics-fetcher.js";
import { backfillWalletActivity } from "../collector/helius-history.js";
import { upsertPosition, positionStats, getPositionsByWallet } from "../db/positions.js";
import { getWallet, listWallets, updateWalletMetrics, setWalletTier, bumpEvaluation, updateWalletStrategy } from "../db/wallets.js";
import { calculateWalletScore } from "../wallets/scoring.js";
import { deriveWalletExtras } from "../wallets/tag-computer.js";

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Cap breadth pools per wallet (portfolio/open footprint) to bound LPAgent cost.
const MAX_BREADTH_POOLS = 6;

// Concurrency for LPAgent studyTopLPers calls per wallet. Lower than pool-discovery
// to reduce load on LPAgent and cut 500 retries under parallel evaluation.
const STUDY_CONCURRENCY = 2;

/**
 * Core evaluation: given a wallet's LPAgent aggregate + positions for a pool, compute metrics,
 * score, and tier (tracked/rejected). Writes positions + metrics + tier to DB.
 * Win-rate prefers position-level outcomes (closed positions); falls back to the (unreliable)
 * LPAgent aggregate win_rate_pct only when position-level has too few closed samples.
 *
 * @param {string} address
 * @param {object|null} aggregate owner aggregate from studyTopLPers (may be null if wallet not in top list)
 * @param {object[]} positions scout-shaped position rows
 */
export function applyEvaluation(address, aggregate, positions = []) {
  // Persist position-level data (serves the dataset + win-rate). Idempotent via position id.
  for (const p of positions) {
    try {
      upsertPosition(p);
    } catch (err) {
      log("eval_warn", `upsertPosition ${p.id} failed: ${err.message}`);
    }
  }

  const stats = positionStats(address);
  const closedDecided = stats.won + stats.lost;
  const winRate = closedDecided >= 3
    ? stats.won / closedDecided
    : (aggregate && num(aggregate.win_rate_pct) > 0 ? num(aggregate.win_rate_pct) / 100 : 0);

  // total_positions: prefer aggregate totalLp (full count in pool); fall back to DB count.
  const totalPositions = num(aggregate?.total_positions, stats.total) || stats.total;

  const metrics = {
    total_positions: totalPositions,
    win_count: stats.won,
    loss_count: stats.lost,
    win_rate: winRate,
    total_pnl_usd: num(aggregate?.total_pnl_usd, stats.total_pnl_usd),
    total_fees_usd: num(aggregate?.total_fees_usd, stats.total_fees_usd),
    avg_fee_yield: num(aggregate?.fee_percent, stats.avg_fee_yield),
    avg_duration_hours: num(aggregate?.avg_age_hours, stats.avg_duration_hours),
  };

  const minPos = config.discovery.minPositionsToEvaluate;
  if (metrics.total_positions < minPos) {
    bumpEvaluation(address);
    log("eval", `${address.slice(0, 8)}… insufficient data (${metrics.total_positions}<${minPos}) → stays candidate`);
    return { address, status: "candidate", reason: "insufficient_data", metrics };
  }

  const score = calculateWalletScore(metrics);
  const t = config.tiers;
  const reasons = [];
  if (score < t.minWalletScore) reasons.push(`score ${score} < ${t.minWalletScore}`);
  if (metrics.win_rate < t.minWinRate) reasons.push(`win_rate ${metrics.win_rate.toFixed(3)} < ${t.minWinRate}`);
  if (metrics.total_positions < t.minTotalPositions) reasons.push(`positions ${metrics.total_positions} < ${t.minTotalPositions}`);
  if (metrics.avg_fee_yield < t.minFeeYield) reasons.push(`fee_yield ${metrics.avg_fee_yield.toFixed(2)} < ${t.minFeeYield}`);
  const passes = reasons.length === 0;

  const extras = deriveWalletExtras(metrics, getPositionsByWallet(address));
  updateWalletMetrics(address, { ...metrics, score, ...extras });
  if (passes) {
    setWalletTier(address, { status: "tracked", is_tracked: true });
  } else {
    setWalletTier(address, { status: "rejected", reject_reason: reasons.join("; ") });
  }
  bumpEvaluation(address);

  log("eval", `${address.slice(0, 8)}… → ${passes ? "TRACKED" : "rejected"} | score=${score} wr=${metrics.win_rate.toFixed(2)} pos=${metrics.total_positions} feeYield=${metrics.avg_fee_yield.toFixed(2)} pnl=$${metrics.total_pnl_usd.toFixed(0)}${passes ? "" : ` | ${reasons.join("; ")}`}`);
  return { address, status: passes ? "tracked" : "rejected", score, metrics, reject_reason: passes ? null : reasons.join("; ") };
}

/**
 * Build a stub position row from a Helius WalletActivity event. We lack bins/capital/PnL
 * from Helius, so this is intentionally sparse — it adds to position count, pool breadth,
 * and last-active timing, while leaving financial fields for LPAgent / portfolio to fill.
 */
function positionFromActivity(ev) {
  const entry = ev.timestamp ? Math.floor(ev.timestamp) : null;
  const id = `${ev.wallet}_${ev.pools[0] || "unknown"}_${entry || ev.signature?.slice(0, 8) || 0}`;
  return {
    id,
    wallet_address: ev.wallet,
    pool_address: ev.pools[0] || null,
    token_pair: null,
    entry_timestamp: entry,
    bin_lower: null,
    bin_upper: null,
    bin_range_width: null,
    capital_usd: null,
    exit_timestamp: null,
    fees_earned_usd: null,
    pnl_usd: null,
    pnl_pct: null,
    fee_yield: null,
    duration_hours: null,
    is_profitable: null,
    status: "open",
  };
}

/**
 * Fetch historical Meteora DLMM activity from Helius for this wallet. Adds discovered
 * pools to the breadth set, persists sparse position stubs for pool-count / timing, and
 * returns summary metrics to merge into the aggregate.
 */
async function fetchHeliusHistory(address) {
  if (!config.env.heliusApiKey) {
    log("eval", `no HELIUS_API_KEY; skipping history backfill for ${address.slice(0, 8)}`);
    return { extraPools: [], histPositions: [], histPoolCount: 0, lastActiveAt: null };
  }

  const days = config.discovery.evaluationBackfillDays;
  try {
    const events = await backfillWalletActivity(address, {
      days,
      maxTx: 500,
      sleepMs: 200,
    });

    const extraPools = new Set();
    const histPositions = [];
    let lastActiveAt = null;
    for (const ev of events) {
      if (!ev.pools?.length) continue;
      for (const pool of ev.pools) {
        extraPools.add(pool);
      }
      histPositions.push(positionFromActivity(ev));
      if (ev.timestamp && ev.timestamp > (lastActiveAt || 0)) lastActiveAt = ev.timestamp;
    }

    log("eval", `history ${address.slice(0, 8)}…: ${days}d → ${events.length} Meteora events, ${extraPools.size} pools, ${histPositions.length} stubs`);
    return {
      extraPools: [...extraPools],
      histPositions,
      histPoolCount: extraPools.size,
      lastActiveAt,
    };
  } catch (err) {
    log("eval_warn", `history backfill ${address.slice(0, 8)} failed: ${err.message}`);
    return { extraPools: [], histPositions: [], histPoolCount: 0, lastActiveAt: null };
  }
}

/**
 * Evaluate a single wallet by merging THREE data sources:
 *  1. Helius history backfill: historical Meteora DLMM activity (position opens) to boost
 *     position count and pool breadth for wallets LPAgent does not rank as top-20.
 *  2. portfolio/open (reliable, always present): the wallet's OWN open positions — count,
 *     current PnL/fees per pool, and open win-rate (fraction of pools with positive PnL).
 *  3. LPAgent studyTopLPers across discovered_from + a cap of open pools + history pools:
 *     historical closed positions (for win-rate on realized outcomes) + aggregates.
 * portfolio/open + Helius history fix the coverage gap (LPAgent alone is too sparse).
 */
export async function evaluateWallet(address) {
  const wallet = getWallet(address);
  if (!wallet) {
    log("eval_warn", `unknown wallet ${address?.slice(0, 8)}`);
    return null;
  }

  // 1) Helius history backfill (bounded by evaluationBackfillDays, default 90).
  const { extraPools, histPositions, histPoolCount, lastActiveAt } = await fetchHeliusHistory(address);

  // 2) Reliable current portfolio.
  let portfolio = { totalPositions: 0, pools: [] };
  try {
    portfolio = await fetchWalletPortfolio(address);
  } catch (err) {
    log("eval_warn", `portfolio/open ${address?.slice(0, 8)} failed: ${err.message}`);
  }

  // 3) LPAgent breadth: discovered_from + open pools + pools discovered via Helius history.
  const pools = new Set();
  if (wallet.discovered_from) pools.add(wallet.discovered_from);
  for (const p of portfolio.pools.slice(0, MAX_BREADTH_POOLS)) pools.add(p.poolAddress);
  for (const pool of extraPools) pools.add(pool);

  let lpPnl = 0;
  let lpFees = 0;
  const lpFeeYields = [];
  const lpAges = [];
  const allPositions = [];
  let strategy = null;
  if (pools.size) {
    await runConcurrent([...pools], STUDY_CONCURRENCY, async (poolAddr) => {
      try {
        const studied = await studyTopLPers({ pool_address: poolAddr, limit: 20 });
        const owner = studied.owners.find((o) => o.address === address);
        if (!owner) return; // not a top-20 LPer here — no LPAgent data for this pool
        const a = owner.aggregate || {};
        lpPnl += num(a.total_pnl_usd);
        lpFees += num(a.total_fees_usd);
        if (Number.isFinite(Number(a.fee_percent))) lpFeeYields.push(Number(a.fee_percent));
        if (Number.isFinite(Number(a.avg_age_hours))) lpAges.push(Number(a.avg_age_hours));
        if (!strategy && (a.preferred_strategy || a.preferred_range_style)) {
          strategy = { preferred_strategy: a.preferred_strategy, preferred_range_style: a.preferred_range_style };
        }
        for (const p of owner.positions) allPositions.push(p);
      } catch (err) {
        log("eval_warn", `study ${poolAddr?.slice(0, 8)} for ${address?.slice(0, 8)}: ${err.message}`);
      }
    });
  }
  if (strategy) updateWalletStrategy(address, strategy);

  // Merge history stubs behind LPAgent positions so LPAgent data wins on conflict.
  for (const p of histPositions) allPositions.push(p);

  // Open win-rate: fraction of the wallet's pools that are NET positive (fees earned > IL).
  // LP success = fees outweigh impermanent loss, so "win" = (pnl + unclaimedFees) > 0 — NOT
  // price PnL alone, which understates LPs (most open positions carry unrealized IL).
  const netOf = (p) => p.pnl + p.unclaimedFees;
  const decided = portfolio.pools.filter((p) => netOf(p) !== 0);
  const openWinRate = decided.length ? decided.filter((p) => netOf(p) > 0).length / decided.length : 0;
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

  const aggregate = {
    total_pnl_usd: portfolio.pools.reduce((s, p) => s + p.pnl, 0) + lpPnl,
    total_fees_usd: portfolio.pools.reduce((s, p) => s + p.unclaimedFees, 0) + lpFees,
    // open (portfolio) + closed (LPAgent) + historical stubs (Helius)
    total_positions: portfolio.totalPositions + allPositions.length,
    fee_percent: portfolio.pools.length ? mean(portfolio.pools.map((p) => p.feePerTvl24h)) : mean(lpFeeYields),
    avg_age_hours: mean(lpAges),
    hist_pool_count: histPoolCount,
    last_active_position_at: lastActiveAt,
    win_rate_pct: openWinRate * 100, // reliable open WR; applyEvaluation uses closed-position WR if ≥3 closed exist
  };
  return applyEvaluation(address, aggregate, allPositions);
}

/**
 * Process the candidate queue: evaluate each wallet (with its own breadth). Bounded by
 * maxWalletCandidatesPerCycle. Sequential per wallet to stay gentle on LPAgent rate limits.
 */
export async function runEvaluatorBatch({ limit = config.discovery.maxWalletCandidatesPerCycle } = {}) {
  const candidates = listWallets({ status: "candidate", limit });
  log("eval", `evaluator batch: ${candidates.length} candidate(s)`);

  const results = [];
  for (const w of candidates) {
    try {
      results.push(await evaluateWallet(w.address));
    } catch (err) {
      log("eval_error", `evaluateWallet ${w.address?.slice(0, 8)}: ${err.message}`);
      results.push({ address: w.address, status: "error", error: err.message });
    }
  }

  const summary = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  log("eval", `evaluator batch done: ${results.length} evaluated → ${JSON.stringify(summary)}`);
  return { evaluated: results.length, summary, results };
}
