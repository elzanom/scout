import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { studyTopLPers, runConcurrent } from "./pool-discovery.js";
import { fetchWalletPortfolio, fetchWalletPortfolioTotal, fetchWalletPositionHistory } from "../screener/metrics-fetcher.js";
import { backfillWalletActivity } from "../collector/helius-history.js";
import { upsertPosition, positionStats, getPositionsByWallet } from "../db/positions.js";
import { getWallet, listWallets, updateWalletMetrics, setWalletTier, bumpEvaluation, updateWalletStrategy } from "../db/wallets.js";
import { calculateWalletScore } from "../wallets/scoring.js";
import { deriveWalletExtras } from "../wallets/tag-computer.js";
import { patchStagedSignals } from "../signals/stage-signals.js";

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_SYMBOLS = new Set(["sol", "wsol"]);

// Solana addresses are base58-encoded 32-byte public keys (43-44 chars). Same rules apply to
// wallets and pools, so we use a simple length/base58 check to avoid treating arbitrary strings
// (e.g. tx signatures, wallet addresses stored in discovered_from) as pool addresses.
function isPoolAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr.length < 32 || addr.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) return false;
  return true;
}

function isSolToken(token) {
  if (!token) return false;
  const mint = String(token?.address || "").toLowerCase();
  const symbol = String(token?.symbol || "").toLowerCase();
  return mint === SOL_MINT.toLowerCase() || SOL_SYMBOLS.has(symbol);
}

function isSolPair(tokenPair) {
  if (!tokenPair) return false;
  const raw = String(tokenPair);
  const lower = raw.toLowerCase();
  const parts = lower.split("/");
  // token_pair can be symbol/SOL-mint (e.g. "pump/So111111..."); accept SOL mint as the quote side too.
  if (parts.some((p) => SOL_SYMBOLS.has(p.trim()))) return true;
  if (parts.length === 2 && parts[1] === SOL_MINT.toLowerCase()) return true;
  // Also accept the raw mint appearing anywhere in the pair string as a safety net.
  if (lower.includes(SOL_MINT.toLowerCase())) return true;
  return false;
}

// Cap breadth pools per wallet (portfolio/open footprint) to bound Agent Meridian cost.
// Keep this small: Agent Meridian is flaky, and Meteora portfolio/history already gives us
// the bulk of position-level data. We only study the discovered-from pool plus the top 3
// open pools by deposit value.
const MAX_BREADTH_POOLS = 3;

// Concurrency for Agent Meridian studyTopLPers calls per wallet. Serial (1) to avoid bursts.
const STUDY_CONCURRENCY = 1;

// If Agent Meridian fails for every studied pool, we still evaluate using Meteora data only.
const AM_FALLBACK_OK = true;

/**
 * Core evaluation: given a wallet's Agent Meridian aggregate + positions for a pool, compute metrics,
 * score, and tier (tracked/rejected). Writes positions + metrics + tier to DB.
 * Win-rate prefers position-level outcomes (closed positions); falls back to the (unreliable)
 * Agent Meridian aggregate win_rate_pct only when position-level has too few closed samples.
 *
 * @param {string} address
 * @param {object|null} aggregate owner aggregate from studyTopLPers (may be null if wallet not in top list)
 * @param {object[]} positions scout-shaped position rows
 */
export function applyEvaluation(address, aggregate, positions = [], { amUnavailable = false } = {}) {
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

  // total_positions: when requireSolPair is on, only count SOL-pair positions.
  const totalPositions = config.screening.requireSolPair
    ? stats.total
    : (num(aggregate?.total_positions, stats.total) || stats.total);

  const metrics = {
    total_positions: totalPositions,
    win_count: stats.won,
    loss_count: stats.lost,
    win_rate: winRate,
    // When filtering to SOL pairs, prefer DB-derived aggregates from positionStats.
    total_pnl_usd: config.screening.requireSolPair
      ? stats.total_pnl_usd
      : num(aggregate?.total_pnl_usd, stats.total_pnl_usd),
    total_fees_usd: config.screening.requireSolPair
      ? stats.total_fees_usd
      : num(aggregate?.total_fees_usd, stats.total_fees_usd),
    avg_fee_yield: config.screening.requireSolPair
      ? stats.avg_fee_yield
      : num(aggregate?.fee_percent, stats.avg_fee_yield),
    avg_duration_hours: num(aggregate?.avg_age_hours, stats.avg_duration_hours),
  };

  const minPos = config.discovery.minPositionsToEvaluate;
  if (metrics.total_positions < minPos) {
    bumpEvaluation(address);
    log("eval", `${address.slice(0, 8)}… insufficient data (${metrics.total_positions}<${minPos}) → stays candidate`);
    return { address, status: "candidate", reason: "insufficient_data", metrics };
  }

  // Enrich staged signal snapshots for this wallet's positions with study_win_rate.
  if (Number.isFinite(winRate)) {
    for (const p of positions) {
      if (p.pool_address) patchStagedSignals(p.pool_address, { study_win_rate: winRate });
    }
  }

  const score = calculateWalletScore(metrics);
  const t = config.tiers;
  const reasons = [];
  if (score < t.minWalletScore) reasons.push(`score ${score} < ${t.minWalletScore}`);
  if (metrics.win_rate < t.minWinRate) reasons.push(`win_rate ${metrics.win_rate.toFixed(3)} < ${t.minWinRate}`);
  if (metrics.total_positions < t.minTotalPositions) reasons.push(`positions ${metrics.total_positions} < ${t.minTotalPositions}`);
  if (metrics.avg_fee_yield < t.minFeeYield) reasons.push(`fee_yield ${metrics.avg_fee_yield.toFixed(2)} < ${t.minFeeYield}`);
  let passes = reasons.length === 0;

  const extras = deriveWalletExtras(metrics, getPositionsByWallet(address));
  updateWalletMetrics(address, { ...metrics, score, ...extras });

  // Fallback: if Agent Meridian was entirely down for this wallet but Meteora-only score passes,
  // promote to tracked anyway. We know the wallet is a real LP from on-chain/portfolio data.
  if (!passes && amUnavailable && score >= t.minWalletScore) {
    passes = true;
    reasons.push("agent_meridian_unavailable_fallback");
  }

  if (passes) {
    setWalletTier(address, { status: "tracked", is_tracked: true });
  } else {
    setWalletTier(address, { status: "rejected", reject_reason: reasons.join("; ") });
  }
  bumpEvaluation(address);

  log("eval", `${address.slice(0, 8)}… → ${passes ? "TRACKED" : "rejected"} | score=${score} wr=${metrics.win_rate.toFixed(2)} pos=${metrics.total_positions} feeYield=${metrics.avg_fee_yield.toFixed(2)} pnl=$${metrics.total_pnl_usd.toFixed(0)}${passes && !amUnavailable ? "" : ` | ${reasons.join("; ")}`}`);
  return { address, status: passes ? "tracked" : "rejected", score, metrics, reject_reason: passes ? null : reasons.join("; ") };
}

/**
 * Map a Meteora position/pnl row (from fetchPoolPositionPnl) to the scout position schema.
 */
function positionFromMeteora(p) {
  const entry = p.createdAt ? Math.floor(p.createdAt) : null;
  const exit = p.closedAt ? Math.floor(p.closedAt) : null;
  // tokenPair from Meteora is often "mintX/mintY" (mint addresses). Keep the raw string for
  // backwards compatibility but also store the mints so the UI/API can render readable tickers.
  const [rawX, rawY] = String(p.tokenPair || "").split("/");
  const tokenXMint = p.tokenXSymbol || rawX || null;
  const tokenYMint = p.tokenYSymbol || rawY || null;
  return {
    id: p.positionAddress,
    wallet_address: null, // filled by caller
    pool_address: p.poolAddress,
    token_pair: p.tokenPair || null,
    token_x_mint: tokenXMint,
    token_y_mint: tokenYMint,
    entry_timestamp: entry,
    bin_lower: p.lowerBinId ?? null,
    bin_upper: p.upperBinId ?? null,
    bin_range_width: (p.upperBinId != null && p.lowerBinId != null) ? p.upperBinId - p.lowerBinId : null,
    capital_usd: p.depositsUsd || null,
    exit_timestamp: exit,
    fees_earned_usd: p.feesUsd || null,
    pnl_usd: p.pnlUsd,
    pnl_pct: p.pnlPctChange,
    fee_yield: p.feePerTvl24h,
    duration_hours: entry && exit ? (exit - entry) / 3600 : null,
    is_profitable: p.pnlUsd != null ? (p.pnlUsd > 0 ? 1 : 0) : null,
    status: p.isClosed ? "closed" : "open",
  };
}

/**
 * Build a stub position row from a Helius WalletActivity event. We lack bins/capital/PnL
 * from Helius, so this is intentionally sparse — it adds to position count, pool breadth,
 * and last-active timing, while leaving financial fields for Agent Meridian / portfolio to fill.
 */
function positionFromActivity(ev) {
  const entry = ev.timestamp ? Math.floor(ev.timestamp) : null;
  const id = `${ev.wallet}_${ev.pools[0] || "unknown"}_${entry || ev.signature?.slice(0, 8) || 0}`;
  return {
    id,
    wallet_address: ev.wallet,
    pool_address: ev.pools[0] || null,
    token_pair: null,
    token_x_mint: null,
    token_y_mint: null,
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
 * Evaluate a single wallet by merging FOUR data sources:
 *  1. Helius history backfill: historical Meteora DLMM activity (position opens) to boost
 *     position count and pool breadth for wallets Agent Meridian does not rank as top-20.
 *  2. portfolio/open (reliable, always present): the wallet's OWN open positions — count,
 *     current PnL/fees per pool, and open win-rate.
 *  3. Meteora position PnL history: per-pool closed positions with bin range, deposits,
 *     withdrawals, fees, and durations — independent of Agent Meridian coverage.
 *  4. Agent Meridian studyTopLPers across discovered_from + open pools + history pools:
 *     preferred strategy/range and supplementary aggregates.
 * Meteora portfolio history is now the primary source for realized outcomes, reducing
 * dependence on Agent Meridian's sparse top-3 historical coverage.
 */
export async function evaluateWallet(address) {
  const wallet = getWallet(address);
  if (!wallet) {
    log("eval_warn", `unknown wallet ${address?.slice(0, 8)}`);
    return null;
  }

  // 1) Helius history backfill (bounded by evaluationBackfillDays, default 30).
  const { extraPools, histPositions, histPoolCount, lastActiveAt } = await fetchHeliusHistory(address);

  // 2) Reliable current portfolio.
  let portfolio = { totalPositions: 0, pools: [] };
  try {
    portfolio = await fetchWalletPortfolio(address);
  } catch (err) {
    log("eval_warn", `portfolio/open ${address?.slice(0, 8)} failed: ${err.message}`);
  }

  // 2b) When requireSolPair is enabled, drop non-SOL pools from the open portfolio.
  if (config.screening.requireSolPair) {
    portfolio.pools = portfolio.pools.filter((p) => isSolPair(`${p.tokenXSymbol}/${p.tokenYSymbol}`));
  }

  // 3) Meteora position PnL history — independent, rich, covers all closed positions.
  let meteoraPositions = [];
  let meteoraTotalClosed = 0;
  try {
    const history = await fetchWalletPositionHistory(address, {
      status: "all",
      daysBack: config.discovery.evaluationBackfillDays,
      pageSize: 100,
    });
    meteoraPositions = history.positions
      .map((p) => ({ ...positionFromMeteora(p), wallet_address: address }))
      .filter((p) => !config.screening.requireSolPair || isSolPair(p.token_pair));
    meteoraTotalClosed = history.totalClosedPositions;
    log("eval", `meteora history ${address.slice(0, 8)}…: ${meteoraPositions.length} positions, ${meteoraTotalClosed} closed`);
  } catch (err) {
    log("eval_warn", `meteora position history ${address.slice(0, 8)} failed: ${err.message}`);
  }

  // 4) Agent Meridian breadth: discovered_from (must look like a pool address) + top open pools.
  // History/meteora pools are intentionally NOT studied here — they massively multiply
  // Agent Meridian calls and 500s, while Meteora positions already give us closed-position data.
  const pools = new Set();
  if (wallet.discovered_from && isPoolAddress(wallet.discovered_from)) {
    pools.add(wallet.discovered_from);
  } else if (wallet.discovered_from) {
    log("eval_warn", `${address.slice(0, 8)}… discovered_from ${wallet.discovered_from.slice(0, 8)}… is not a pool address; skipping Agent Meridian study`);
  }
  const topOpenPools = [...portfolio.pools]
    .filter((p) => p.poolAddress)
    .sort((a, b) => (b.totalDeposit || 0) - (a.totalDeposit || 0))
    .slice(0, MAX_BREADTH_POOLS)
    .map((p) => p.poolAddress);
  for (const poolAddr of topOpenPools) pools.add(poolAddr);

  let lpPnl = 0;
  let lpFees = 0;
  const lpFeeYields = [];
  const lpAges = [];
  const allPositions = [];
  let strategy = null;
  let studySuccessCount = 0;
  if (pools.size) {
    await runConcurrent([...pools], STUDY_CONCURRENCY, async (poolAddr) => {
      try {
        const studied = await studyTopLPers({ pool_address: poolAddr, limit: 20 });
        studySuccessCount += 1;
        const owner = studied.owners.find((o) => o.address === address);
        if (!owner) return; // not a top-20 LPer here — no Agent Meridian data for this pool
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

  if (studySuccessCount === 0 && pools.size > 0) {
    log("eval_warn", `Agent Meridian unavailable for ${address.slice(0, 8)}…; using Meteora-only fallback`);
  }

  // Merge Meteora positions (primary) and Helius stubs. Meteora data wins because it has
  // full financials; Agent Meridian positions are already in allPositions.
  const positionMap = new Map(allPositions.map((p) => [p.id, p]));
  for (const p of meteoraPositions) positionMap.set(p.id, p);
  for (const p of histPositions) if (!positionMap.has(p.id)) positionMap.set(p.id, p);
  let mergedPositions = [...positionMap.values()];
  if (config.screening.requireSolPair) {
    mergedPositions = mergedPositions.filter((p) => isSolPair(p.token_pair));
  }

  // Open win-rate: fraction of the wallet's pools that are NET positive (fees earned > IL).
  const netOf = (p) => p.pnl + p.unclaimedFees;
  const decided = portfolio.pools.filter((p) => netOf(p) !== 0);
  const openWinRate = decided.length ? decided.filter((p) => netOf(p) > 0).length / decided.length : 0;
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

  // Fallback fee yield from closed Meteora positions when Agent Meridian data is absent.
  const closedMeteora = meteoraPositions.filter((p) => p.status === "closed" && Number.isFinite(p.fee_yield));
  const meteoraFeeYield = closedMeteora.length
    ? mean(closedMeteora.map((p) => p.fee_yield))
    : null;

  // Total realized PnL from Meteora if available; otherwise fall back to portfolio + Agent Meridian sum.
  let totalPnlUsd = portfolio.pools.reduce((s, p) => s + p.pnl, 0) + lpPnl;
  let totalFeesUsd = portfolio.pools.reduce((s, p) => s + p.unclaimedFees, 0) + lpFees;
  try {
    const totals = await fetchWalletPortfolioTotal(address);
    if (totals.totalPnlUsd !== 0 || totals.totalClosedPositions > 0) {
      totalPnlUsd = totals.totalPnlUsd;
      // Keep unclaimed fees from portfolio/open; Meteora /portfolio/total is realized-only.
      totalFeesUsd = portfolio.pools.reduce((s, p) => s + p.unclaimedFees, 0) + lpFees;
    }
  } catch (err) {
    log("eval_warn", `portfolio/total ${address.slice(0, 8)} failed: ${err.message}`);
  }

  const aggregate = {
    total_pnl_usd: totalPnlUsd,
    total_fees_usd: totalFeesUsd,
    // open (portfolio) + closed (Meteora + Agent Meridian) + historical stubs (Helius)
    total_positions: portfolio.totalPositions + mergedPositions.length,
    fee_percent: portfolio.pools.length
      ? mean(portfolio.pools.map((p) => p.feePerTvl24h))
      : (mean(lpFeeYields) || meteoraFeeYield || 0),
    avg_age_hours: mean(lpAges),
    hist_pool_count: histPoolCount,
    last_active_position_at: lastActiveAt,
    win_rate_pct: openWinRate * 100,
    meteora_total_closed: meteoraTotalClosed,
  };
  const amUnavailable = AM_FALLBACK_OK && pools.size > 0 && studySuccessCount === 0;
  return applyEvaluation(address, aggregate, mergedPositions, { amUnavailable });
}

/**
 * Process the candidate queue: evaluate each wallet (with its own breadth). Bounded by
 * maxWalletCandidatesPerCycle. Sequential per wallet to stay gentle on Agent Meridian rate limits.
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

  const performanceDetails = results
    .filter((r) => r && r.metrics)
    .map((r) => ({
      address: r.address,
      status: r.status,
      score: r.score ?? r.metrics?.score ?? 0,
      win_rate: r.metrics?.win_rate ?? 0,
      positions: r.metrics?.total_positions ?? 0,
      fee_yield: r.metrics?.avg_fee_yield ?? 0,
      pnl_usd: r.metrics?.total_pnl_usd ?? 0,
      reject_reason: r.reject_reason || null,
    }));
  return { evaluated: results.length, summary, results, performanceDetails };
}
