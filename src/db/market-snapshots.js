import { getDb } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

// Full column set written per snapshot: original core metrics + the rich additive columns
// (kept in sync with schema.js SNAPSHOT_COLS). New snapshot metrics auto-join into the
// training dataset via entry_snapshot_id.
export const SNAPSHOT_COLUMNS = [
  "pool_address", "timestamp", "fee_apr", "volume_24h", "tvl", "fee_tvl_ratio", "active_bin",
  "price", "token_price", "token_price_change_24h", "token_volatility_24h", "token_volume_24h",
  // momentum
  "volume_change_pct", "tvl_change_pct", "active_tvl_change_pct", "fee_change_pct",
  "fee_active_tvl_ratio_change_pct", "swap_count_change_pct", "holders_change_pct",
  "positions_created_change_pct", "unique_lps_change_pct", "unique_traders_change_pct",
  "net_deposits_change_pct",
  // LP flow
  "net_deposits", "total_deposits", "total_withdraws",
  // activity
  "swap_count", "unique_traders", "unique_lps", "total_lps", "positions_created",
  "active_positions", "active_positions_pct", "open_positions",
  // structure
  "pool_fee_pct", "dynamic_fee_pct", "min_price", "max_price", "price_trend", "has_farm",
  "permanent_lock_liquidity_pct", "volume_tvl_ratio", "volume_active_tvl_ratio",
  // base-token health
  "base_holders", "base_fdv", "base_mcap", "base_dev_balance_pct", "base_top_holders_pct",
  "base_organic_score", "base_is_verified", "base_has_freeze_auth", "base_has_mint_auth",
  "pool_created_at", "base_created_at", "days_since_pool_created",
  // multi-source enrichment
  "base_mint", "sol_price_usd",
  // buy/sell trade direction (Birdeye, 5min cache/mint)
  "buy_volume_24h_usd", "sell_volume_24h_usd", "buy_count_24h", "sell_count_24h", "buy_sell_ratio_24h",
  // 1h timeframe (parallel Meteora fetch — "freshly hot" vs "long-hot" detection)
  "volume_1h", "fee_apr_1h", "volume_change_pct_1h", "swap_count_change_pct_1h",
];

/** Insert a market-context snapshot for a pool. Missing/non-scalar fields default to null. */
export function insertSnapshot(s) {
  const cols = SNAPSHOT_COLUMNS;
  const placeholders = cols.map(() => "?").join(", ");
  // Coerce to scalar — better-sqlite3 would otherwise expand an array value into multiple
  // bound params (e.g. Meteora's price_trend can be an array) and blow the parameter count.
  const scalar = (v) => {
    if (v == null) return null;
    if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return null; // arrays/objects → null
  };
  const values = cols.map((c) => (c === "timestamp" ? (s.timestamp ?? now()) : scalar(s[c])));
  getDb().prepare(`INSERT INTO market_snapshots (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
}

/**
 * Snapshot nearest to `timestamp` for a pool — prefer the most recent one at or before it
 * (the market context visible AT entry); fall back to the absolute-nearest if none before.
 */
export function getNearestSnapshot(poolAddress, timestamp) {
  const before = getDb().prepare(
    `SELECT * FROM market_snapshots WHERE pool_address = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1`,
  ).get(poolAddress, timestamp);
  if (before) return before;
  return getDb().prepare(
    `SELECT * FROM market_snapshots WHERE pool_address = ? ORDER BY ABS(timestamp - ?) ASC LIMIT 1`,
  ).get(poolAddress, timestamp);
}

/** Most recent snapshot for a pool. */
export function getLatestSnapshot(poolAddress) {
  return getDb().prepare(
    `SELECT * FROM market_snapshots WHERE pool_address = ? ORDER BY timestamp DESC LIMIT 1`,
  ).get(poolAddress);
}

export function countSnapshotsByPool(poolAddress) {
  return getDb().prepare(
    `SELECT COUNT(*) AS c FROM market_snapshots WHERE pool_address = ?`,
  ).get(poolAddress).c;
}
