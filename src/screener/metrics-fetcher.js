import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { TIMEFRAME_MINUTES } from "./pool-scorer.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const POOL_PORTFOLIO_BASE = "https://dlmm.datapi.meteora.ag";
const BIRDEYE_OVERVIEW = "https://public-api.birdeye.so/defi/token_overview";
const MIN_VOLATILITY_TIMEFRAME = "30m";

/** Coerce a value to a finite number, or null. */
export function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Volatility is only meaningful when finite and > 0. */
export function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

/** Volatility is only meaningful on ≥30m windows; fall back to 30m for shorter TFs. */
export function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

/** Fetch one page of pools from the Meteora discovery API (public, no auth). */
export async function fetchPoolPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${encodeURIComponent(timeframe)}` +
    `&category=${encodeURIComponent(category)}`;
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const e = new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  });
}

/** Fetch a single pool's full raw detail by address (page_size=1 filter). */
export async function fetchPoolByAddress(poolAddress, timeframe = config.screening.timeframe) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${encodeURIComponent(timeframe)}`;
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const e = new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    return (data.data || [])[0] ?? null;
  });
}

// Macro SOL price (market regime feature) via Coingecko, cached 60s. Free, no key.
let _solPrice = null;
let _solPriceAt = 0;
export async function getSolPriceUsd() {
  const now = Date.now();
  if (_solPrice != null && now - _solPriceAt < 60_000) return _solPrice;
  try {
    const price = await withRetry(async () => {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      if (!res.ok) { const e = new Error(`coingecko ${res.status}`); e.status = res.status; throw e; }
      return (await res.json())?.solana?.usd ?? null;
    }, { maxAttempts: 2 });
    if (price != null) { _solPrice = price; _solPriceAt = now; }
  } catch { /* keep last known price */ }
  return _solPrice;
}

/**
 * Birdeye token_overview trade-direction subset (buy/sell volume USD + counts over 24h).
 * Cached 5min/mint (multiple pools share a base_mint → avoid hammering Birdeye). Null if no key.
 * Fields: vBuy24hUSD, vSell24hUSD, buy24h, sell24h (raw token_overview envelope).
 */
const _birdeyeTradeCache = new Map();
const _BIRDEYE_TRADE_TTL_MS = 5 * 60 * 1000;
export async function fetchBirdeyeTradeFlow(mint) {
  if (!mint || !config.env.birdeyeApiKey) return null;
  const cached = _birdeyeTradeCache.get(mint);
  if (cached && Date.now() - cached.at < _BIRDEYE_TRADE_TTL_MS) return cached.data;
  try {
    const data = await withRetry(async () => {
      const res = await fetch(`${BIRDEYE_OVERVIEW}?address=${mint}&chain=solana`, {
        headers: { "x-api-key": config.env.birdeyeApiKey },
      });
      if (!res.ok) { const e = new Error(`birdeye trade ${res.status}`); e.status = res.status; throw e; }
      const j = await res.json();
      return j?.data || j || null;
    });
    if (data) _birdeyeTradeCache.set(mint, { at: Date.now(), data });
    return data;
  } catch (err) {
    log("birdeye_warn", `trade flow ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * A wallet's CURRENT open-position portfolio (Meteora portfolio API). This is the reliable,
 * always-present per-wallet data source — unlike LPAgent (which only details top-20 LPers per
 * pool). Used by the evaluator for: open-position COUNT (consistency/gate), current PnL/fees,
 * and open win-rate (fraction of pools with positive PnL).
 */
export async function fetchWalletPortfolio(wallet) {
  return withRetry(async () => {
    const res = await fetch(`${POOL_PORTFOLIO_BASE}/portfolio/open?user=${encodeURIComponent(wallet)}`);
    if (!res.ok) {
      const e = new Error(`portfolio/open ${res.status} ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    const d = await res.json();
    const pools = Array.isArray(d.pools)
      ? d.pools.map((p) => ({
          poolAddress: p.poolAddress,
          pnl: Number(p.pnl) || 0,
          unclaimedFees: Number(p.unclaimedFees) || 0,
          feePerTvl24h: Number(p.feePerTvl24h) || 0,
          totalDeposit: Number(p.totalDeposit) || 0,
          openPositionCount: Number(p.openPositionCount) || 0,
        }))
      : [];
    return { totalPositions: Number(d.totalPositions) || 0, pools };
  });
}

/**
 * The screening timeframe may be shorter than 30m, where volatility is not meaningful.
 * Tag the primary-TF values on each pool, then — if needed — re-fetch the longer-TF
 * volume/volatility per pool and use those as the canonical values for filtering.
 * Ported from meridian tools/screening.js.
 */
export async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const addresses = [...new Set(rawPools.map((p) => p?.pool_address).filter(Boolean))];
  const results = await Promise.allSettled(
    addresses.map((poolAddress) =>
      fetchPoolByAddress(poolAddress, volatilityTimeframe).then((pool) => ({
        poolAddress,
        volatility: numeric(pool?.volatility),
        volume: numeric(pool?.volume),
      }))
    )
  );

  const byPool = new Map();
  for (const r of results) if (r.status === "fulfilled") byPool.set(r.value.poolAddress, r.value);

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const m = byPool.get(pool.pool_address);
    if (!m) continue;
    pool[`volume_${volatilityTimeframe}`] = m.volume;
    pool[`volatility_${volatilityTimeframe}`] = m.volatility;
    if (m.volatility != null) pool.volatility = m.volatility;
    if (m.volume != null) pool.volume = m.volume;
  }

  return rawPools;
}
