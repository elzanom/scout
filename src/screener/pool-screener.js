import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import {
  fetchPoolPage,
  fetchPoolByAddress,
  applyVolatilityTimeframe,
  numeric,
  isUsableVolatility,
  getVolatilityTimeframe,
} from "./metrics-fetcher.js";
import { scoreCandidate, degenScore, poolScore01 } from "./pool-scorer.js";
import { loadWeights } from "../signals/weights.js";
import { stageSignals } from "../signals/stage-signals.js";
import { getTokenInfo } from "../db/token-info.js";
import { getLatestSnapshot } from "../db/market-snapshots.js";
import { getDb } from "../db/index.js";

// ─── helpers ──────────────────────────────────────────────────────────────────
function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_SYMBOLS = new Set(["sol", "wsol"]);

function isSolToken(token) {
  if (!token) return false;
  const mint = String(token?.address || "").toLowerCase();
  const symbol = String(token?.symbol || "").toLowerCase();
  return mint === SOL_MINT.toLowerCase() || SOL_SYMBOLS.has(symbol);
}

function isSolPair(pool) {
  return isSolToken(pool?.token_x) || isSolToken(pool?.token_y);
}

/** Whether any currently-ranked top wallet has an open position in this pool. */
function isTopWalletInPool(poolAddress) {
  try {
    const row = getDb().prepare(`
      SELECT 1 FROM positions p
      JOIN wallets w ON w.address = p.wallet_address
      WHERE p.pool_address = ? AND p.status = 'open' AND w.is_top_wallet = 1
      LIMIT 1
    `).get(poolAddress);
    return !!row;
  } catch {
    return false;
  }
}

/** Best-effort narrative quality from cached token info (Laminar uses present/absent). */
function inferNarrativeQuality(tokenInfo) {
  if (!tokenInfo) return "absent";
  const tags = (() => {
    try { return JSON.parse(tokenInfo.tags || "[]"); } catch { return []; }
  })();
  const hasNarrative = Array.isArray(tags) && tags.length > 0;
  return hasNarrative ? "present" : "absent";
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = numeric(n);
  return value != null ? Number(value.toFixed(decimals)) : null;
}

// ─── in-memory screened-pools cache (SPEC section 5) ─────────────────────────
// The signal validator (Phase 6) consults this when a top wallet enters a pool.
// Only passing pools are cached. Upserted by discoverPools and screenPool.
/** @type {Map<string, { pool: object, degen_score: number, score_candidate: number, pool_score: number, screened_at: number }>} */
const screenedPoolCache = new Map();

export function getCachedScreenedPool(poolAddress) {
  return screenedPoolCache.get(poolAddress) || null;
}

export function getCachedScreenedPools() {
  return [...screenedPoolCache.values()];
}

function cacheScreenedPool(pool) {
  screenedPoolCache.set(pool.pool, {
    pool,
    degen_score: pool.degen_score,
    score_candidate: pool.score_candidate,
    pool_score: pool.pool_score,
    screened_at: Date.now(),
  });
}

// ─── validation ───────────────────────────────────────────────────────────────
/**
 * Ground-truth screening rules. Returns null if the pool passes, or a human-readable
 * reason string if it fails. Applied client-side (re-validates whatever the API returned)
 * and doubles as the source of actionable reject_reasons. Ported from meridian screening.js.
 */
export function getRawPoolScreeningRejectReason(pool, s = config.screening) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (!isUsableVolatility(volatility)) return `volatility ${volatility ?? "unknown"} unusable`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0 && launchpad &&
      !includesCaseInsensitive(s.allowedLaunchpads, launchpad)) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  if (s.requireSolPair && !isSolPair(pool)) {
    return `not a SOL pair (${base?.symbol ?? "?"}/${quote?.symbol ?? "?"})`;
  }

  // Vipera/Laminar parity: holder concentration filters. Prefer cached token_info
  // (already enriched from GMGN/Jupiter) over live pool object.
  const baseMint = base?.address || pool?.base_mint;
  let top10Pct = numeric(pool?.top_10_holder_rate);
  let botPct = numeric(pool?.bundler_rate ?? pool?.bot_holder_rate);
  if ((top10Pct == null || botPct == null) && baseMint) {
    try {
      const ti = getTokenInfo(baseMint);
      if (ti) {
        if (top10Pct == null) top10Pct = numeric(ti.top10_holder_rate);
        if (botPct == null) botPct = numeric(ti.bundler_rate);
      }
    } catch { /* ignore — token_info may not be ready */ }
  }
  if (s.maxTop10Pct != null && top10Pct != null && top10Pct > s.maxTop10Pct) {
    return `top10 holder rate ${(top10Pct * 100).toFixed(1)}% above maxTop10Pct ${(s.maxTop10Pct * 100).toFixed(1)}%`;
  }
  if (s.maxBotHoldersPct != null && botPct != null && botPct > s.maxBotHoldersPct) {
    return `bot/bundler holder rate ${(botPct * 100).toFixed(1)}% above maxBotHoldersPct ${(s.maxBotHoldersPct * 100).toFixed(1)}%`;
  }
  return null;
}

// ─── condense + score ─────────────────────────────────────────────────────────
/**
 * Reduce a raw ~100-field API pool object to the ~25 fields scout cares about, then attach
 * composite scores. Adapted from meridian condensePool (discord fields dropped). The scoring
 * functions operate on the condensed object, which carries every field they read.
 */
function condensePool(p) {
  const condensed = {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    positions_created: p.positions_created,
  };

  condensed.degen_score = fix(degenScore(condensed), 2);
  condensed.score_candidate = fix(scoreCandidate(condensed), 2);
  condensed.pool_score = poolScore01(condensed);

  // Stage Darwinian signal snapshot for later weight learning.
  // Mirrors Laminar signal-weights.js: 13 signals at entry time.
  const snap = getLatestSnapshot(condensed.pool);
  const tokenInfo = snap?.base_mint ? getTokenInfo(snap.base_mint) : null;
  stageSignals(condensed.pool, {
    base_mint: condensed.base?.mint,
    organic_score: condensed.organic_score,
    fee_tvl_ratio: condensed.fee_active_tvl_ratio,
    volume: condensed.volume_window,
    mcap: condensed.mcap,
    holder_count: condensed.holders,
    smart_wallets_present: isTopWalletInPool(condensed.pool),
    narrative_quality: inferNarrativeQuality(tokenInfo),
    study_win_rate: null, // filled by wallet-evaluator per-position if known
    hive_consensus: null, // reserved for future HiveMind sync; Laminar compatibility
    volatility: condensed.volatility,
    entry_mcap: condensed.mcap,
    entry_tvl: condensed.tvl,
    entry_volume: condensed.volume_window,
    entry_holders: condensed.holders,
    momentum_score: condensed.degen_score ?? null,
    price_change_pct: condensed.price_change_pct ?? null,
    volume_change_pct: condensed.volume_change_pct ?? null,
  });

  return condensed;
}

// ─── discovery ─────────────────────────────────────────────────────────────────
/** Build the discovery-API filter_by query string from the screening config. */
function buildDiscoveryFilters(s) {
  return [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");
}

/**
 * Discover + screen pools from the Meteora discovery API. Returns condensed, validated,
 * scored pools (sorted by degen_score desc) plus filtered-out examples with reasons.
 * @param {{ page_size?: number, cache?: boolean, screening?: object }} opts — `screening` overrides config.screening (e.g. for the established-pool pass).
 * @returns {Promise<{ total: number, pools: object[], filtered_examples: {name:string,reason:string}[] }>}
 */
export async function discoverPools({ page_size = 50, cache = true, screening } = {}) {
  const s = { ...config.screening, ...(screening || {}) };
  const filters = buildDiscoveryFilters(s);

  const data = await fetchPoolPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];
  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);

  const filteredExamples = [];
  const passing = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    return false;
  });

  const pools = passing.map(condensePool).sort((a, b) => b.degen_score - a.degen_score);

  if (cache) {
    for (const pool of pools) cacheScreenedPool(pool);
  }

  log("screening", `discovered ${data.total ?? rawPools.length} → ${pools.length} pass, ${filteredExamples.length} filtered [tf=${s.timeframe} cat=${s.category}]`);
  if (filteredExamples.length > 0) {
    log("screening", `filtered: ${filteredExamples.slice(0, 3).map((e) => `${e.name} (${e.reason})`).join(" | ")}`);
  }

  return { total: data.total ?? rawPools.length, pools, filtered_examples: filteredExamples };
}

/**
 * On-demand screening of a single pool — used by the signal validator (Phase 6) when a top
 * wallet enters a pool that may not be in the periodic screen cache. Serves from cache when
 * available; otherwise fetches, validates, scores, caches, and returns.
 * @param {string} poolAddress
 * @param {{ timeframe?: string, refresh?: boolean }} opts
 * @returns {Promise<{ passes: boolean, reason: string|null, pool: object|null, cached: boolean }>}
 */
export async function screenPool(poolAddress, { timeframe, refresh = false } = {}) {
  if (!refresh) {
    const cached = screenedPoolCache.get(poolAddress);
    if (cached) return { passes: true, reason: null, pool: cached.pool, cached: true };
  }

  const s = config.screening;
  const raw = await fetchPoolByAddress(poolAddress, timeframe || s.timeframe);
  if (!raw) return { passes: false, reason: "pool not found", pool: null, cached: false };

  const reason = getRawPoolScreeningRejectReason(raw, s);
  if (reason) return { passes: false, reason, pool: null, cached: false };

  const pool = condensePool(raw);
  cacheScreenedPool(pool);
  return { passes: true, reason: null, pool, cached: false };
}

/** Full raw detail for a specific pool (uncondensed). Thin wrapper over the fetcher. */
export async function getPoolDetail({ pool_address, timeframe = config.screening.timeframe }) {
  const pool = await fetchPoolByAddress(pool_address, timeframe);
  if (!pool) throw new Error(`Pool ${pool_address} not found`);
  return pool;
}
