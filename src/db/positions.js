import { getDb } from "./index.js";

/**
 * Upsert a position keyed by its account id (Agent Meridian `position`). On conflict the outcome
 * fields are refreshed while created_at is preserved.
 */
export function upsertPosition(p) {
  getDb().prepare(
    `INSERT INTO positions (
       id, wallet_address, pool_address, token_pair, token_x_mint, token_y_mint,
       entry_timestamp, bin_lower, bin_upper, bin_range_width, capital_usd,
       exit_timestamp, fees_earned_usd, pnl_usd, pnl_pct, fee_yield,
       duration_hours, is_profitable, status, updated_at
     ) VALUES (
       @id, @wallet_address, @pool_address, @token_pair, @token_x_mint, @token_y_mint,
       @entry_timestamp, @bin_lower, @bin_upper, @bin_range_width, @capital_usd,
       @exit_timestamp, @fees_earned_usd, @pnl_usd, @pnl_pct, @fee_yield,
       @duration_hours, @is_profitable, @status, @updated_at
     )
     ON CONFLICT(id) DO UPDATE SET
       token_pair = excluded.token_pair,
       token_x_mint = excluded.token_x_mint,
       token_y_mint = excluded.token_y_mint,
       exit_timestamp = excluded.exit_timestamp,
       fees_earned_usd = excluded.fees_earned_usd,
       pnl_usd = excluded.pnl_usd,
       pnl_pct = excluded.pnl_pct,
       fee_yield = excluded.fee_yield,
       duration_hours = excluded.duration_hours,
       is_profitable = excluded.is_profitable,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run({
    id: p.id,
    wallet_address: p.wallet_address,
    pool_address: p.pool_address,
    token_pair: p.token_pair ?? null,
    token_x_mint: p.token_x_mint ?? null,
    token_y_mint: p.token_y_mint ?? null,
    entry_timestamp: p.entry_timestamp ?? null,
    bin_lower: p.bin_lower ?? null,
    bin_upper: p.bin_upper ?? null,
    bin_range_width: p.bin_range_width ?? null,
    capital_usd: p.capital_usd ?? null,
    exit_timestamp: p.exit_timestamp ?? null,
    fees_earned_usd: p.fees_earned_usd ?? null,
    pnl_usd: p.pnl_usd ?? null,
    pnl_pct: p.pnl_pct ?? null,
    fee_yield: p.fee_yield ?? null,
    duration_hours: p.duration_hours ?? null,
    is_profitable: p.is_profitable ?? null,
    status: p.status ?? "open",
    updated_at: Math.floor(Date.now() / 1000),
  });
}

export function getPositionsByWallet(address) {
  return getDb().prepare(
    `SELECT * FROM positions WHERE wallet_address = ? ORDER BY entry_timestamp DESC`,
  ).all(address);
}

/**
 * Aggregate outcome stats for a wallet across its known positions. Win/loss counted on
 * CLOSED positions only (open positions have no realized outcome yet).
 */
export function positionStats(address) {
  const row = getDb().prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'closed' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN status = 'closed' AND pnl_usd <= 0 THEN 1 ELSE 0 END) AS lost,
       COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl_usd ELSE 0 END), 0) AS total_pnl_usd,
       COALESCE(SUM(fees_earned_usd), 0) AS total_fees_usd,
       COALESCE(AVG(fee_yield), 0) AS avg_fee_yield,
       COALESCE(AVG(CASE WHEN status = 'closed' THEN duration_hours END), 0) AS avg_duration_hours
     FROM positions WHERE wallet_address = ?`,
  ).get(address);
  return {
    total: row.total || 0,
    won: row.won || 0,
    lost: row.lost || 0,
    total_pnl_usd: row.total_pnl_usd || 0,
    total_fees_usd: row.total_fees_usd || 0,
    avg_fee_yield: row.avg_fee_yield || 0,
    avg_duration_hours: row.avg_duration_hours || 0,
  };
}
