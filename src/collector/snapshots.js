import { log } from "../utils/logger.js";
import { fetchPoolByAddress, getSolPriceUsd, fetchTradeFlow } from "../screener/metrics-fetcher.js";
import { insertSnapshot, getLatestSnapshot } from "../db/market-snapshots.js";
import { broadcastSnapshot } from "../webui/ws-broadcaster.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const bool01 = (v) => (v ? 1 : 0);
const msToSec = (v) => {
  const n = num(v);
  return n != null ? Math.floor(n / 1000) : null;
};

/**
 * Collect a rich market-context snapshot for a pool: fetch its current detail from the Meteora
 * discovery API (at 24h timeframe for standardized daily metrics + a real APR) and persist ~50
 * metrics to market_snapshots — momentum (change %), LP flow direction, activity counts, fee
 * structure, and base-token health. All from the single fetch. The snapshot cron (Phase 7
 * orchestrator) calls this for pools with open positions (and screened/top-wallet pools).
 */
export async function collectPoolSnapshot(poolAddress) {
  let raw;
  try {
    raw = await fetchPoolByAddress(poolAddress, "24h"); // 24h → genuine volume_24h / fee-APR
  } catch (err) {
    log("snapshot_warn", `fetch ${poolAddress?.slice(0, 8)}: ${err.message}`);
    return null;
  }
  if (!raw) return null;

  const base = raw.token_x || {};
  const poolCreated = msToSec(raw.pool_created_at);
  const ts = Math.floor(Date.now() / 1000);
  const solPrice = await getSolPriceUsd();
  const baseMint = base.address || null;

  // Parallel secondary fetches: 1h Meteora timeframe (freshly-hot vs long-hot) + trade
  // flow (sell-pressure signal). Birdeye first, GMGN fallback. Both null-safe; snapshot still
  // succeeds if either fails.
  const [raw1h, tradeFlow] = await Promise.all([
    fetchPoolByAddress(poolAddress, "1h").catch(() => null),
    baseMint ? fetchTradeFlow(baseMint).catch(() => null) : Promise.resolve(null),
  ]);
  const buyUsd = num(tradeFlow?.vBuy24hUSD);
  const sellUsd = num(tradeFlow?.vSell24hUSD);
  const buySellRatio = buyUsd != null && sellUsd != null
    ? (sellUsd > 0 ? buyUsd / sellUsd : (buyUsd > 0 ? 999 : 0))
    : null;

  // 1h metrics — fee_active_tvl_ratio_1h * 8760 annualizes an hourly fee/TVL ratio.
  const feeApr1h = num(raw1h?.fee_active_tvl_ratio) != null ? num(raw1h.fee_active_tvl_ratio) * 8760 : null;

  const snapshot = {
    pool_address: poolAddress,
    timestamp: ts,
    // core
    fee_apr: num(raw.fee_active_tvl_ratio) != null ? num(raw.fee_active_tvl_ratio) * 365 : null, // 24h fee/tvl annualized
    volume_24h: num(raw.volume),
    tvl: num(raw.tvl),
    fee_tvl_ratio: num(raw.fee_tvl_ratio),
    active_bin: num(raw.active_bin),
    price: num(raw.pool_price),
    token_price: num(base.price ?? raw.pool_price),
    token_price_change_24h: num(raw.pool_price_change_pct),
    token_volatility_24h: num(raw.volatility),
    token_volume_24h: num(raw.volume),
    // momentum
    volume_change_pct: num(raw.volume_change_pct),
    tvl_change_pct: num(raw.tvl_change_pct),
    active_tvl_change_pct: num(raw.active_tvl_change_pct),
    fee_change_pct: num(raw.fee_change_pct),
    fee_active_tvl_ratio_change_pct: num(raw.fee_active_tvl_ratio_change_pct),
    swap_count_change_pct: num(raw.swap_count_change_pct),
    holders_change_pct: num(raw.base_token_holders_change_pct),
    positions_created_change_pct: num(raw.positions_created_change_pct),
    unique_lps_change_pct: num(raw.unique_lps_change_pct),
    unique_traders_change_pct: num(raw.unique_traders_change_pct),
    net_deposits_change_pct: num(raw.net_deposits_change_pct),
    // LP flow
    net_deposits: num(raw.net_deposits),
    total_deposits: num(raw.total_deposits),
    total_withdraws: num(raw.total_withdraws),
    // activity
    swap_count: num(raw.swap_count),
    unique_traders: num(raw.unique_traders),
    unique_lps: num(raw.unique_lps),
    total_lps: num(raw.total_lps),
    positions_created: num(raw.positions_created),
    active_positions: num(raw.active_positions),
    active_positions_pct: num(raw.active_positions_pct),
    open_positions: num(raw.open_positions),
    // structure
    pool_fee_pct: num(raw.fee_pct),
    dynamic_fee_pct: num(raw.dynamic_fee_pct),
    min_price: num(raw.min_price),
    max_price: num(raw.max_price),
    price_trend: raw.price_trend || null,
    has_farm: bool01(raw.has_farm),
    permanent_lock_liquidity_pct: num(raw.permanent_lock_liquidity_pct),
    volume_tvl_ratio: num(raw.volume_tvl_ratio),
    volume_active_tvl_ratio: num(raw.volume_active_tvl_ratio),
    // base-token health
    base_holders: num(raw.base_token_holders ?? base.holders),
    base_fdv: num(base.fdv),
    base_mcap: num(base.market_cap),
    base_dev_balance_pct: num(base.dev_balance_pct),
    base_top_holders_pct: num(base.top_holders_pct),
    base_organic_score: num(base.organic_score),
    base_is_verified: bool01(base.is_verified),
    base_has_freeze_auth: bool01(base.has_freeze_authority),
    base_has_mint_auth: bool01(base.has_mint_authority),
    pool_created_at: poolCreated,
    base_created_at: msToSec(base.created_at),
    days_since_pool_created: poolCreated != null ? Math.round((ts - poolCreated) / 86400) : null,
    // multi-source enrichment
    base_mint: baseMint,
    sol_price_usd: solPrice,
    // buy/sell flow (Birdeye → GMGN fallback)
    buy_volume_24h_usd: buyUsd,
    sell_volume_24h_usd: sellUsd,
    buy_count_24h: num(tradeFlow?.buy24h),
    sell_count_24h: num(tradeFlow?.sell24h),
    buy_sell_ratio_24h: buySellRatio,
    // 1h timeframe (Meteora)
    volume_1h: num(raw1h?.volume),
    fee_apr_1h: feeApr1h,
    volume_change_pct_1h: num(raw1h?.volume_change_pct),
    swap_count_change_pct_1h: num(raw1h?.swap_count_change_pct),
  };

  insertSnapshot(snapshot);
  try { broadcastSnapshot(snapshot); } catch {}
  return snapshot;
}

/** Convenience: latest snapshot for a pool (without re-fetching). */
export function latestSnapshot(poolAddress) {
  return getLatestSnapshot(poolAddress);
}
