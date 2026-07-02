import { getDb } from "./index.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Per-position cash-flow event ledger (Meteora /positions/{positionAddress}/historical).
 * Pure DB accessors — fetching lives in collector/position-history.js.
 *
 * Events are add (deposit) / remove (withdraw) / claim_fee, keyed idempotently by
 * (position_id, signature, ix_index) so re-syncs don't duplicate.
 */

/** Upsert one cash-flow event for a position. */
export function upsertPositionEvent(e) {
  getDb().prepare(
    `INSERT INTO position_events (
       position_id, pool_address, wallet_address, event_type, signature, ix_index,
       block_time, token_x_mint, token_y_mint, amount_x, amount_y,
       amount_x_usd, amount_y_usd, total_usd
     ) VALUES (
       @position_id, @pool_address, @wallet_address, @event_type, @signature, @ix_index,
       @block_time, @token_x_mint, @token_y_mint, @amount_x, @amount_y,
       @amount_x_usd, @amount_y_usd, @total_usd
     )
     ON CONFLICT(position_id, signature, ix_index) DO UPDATE SET
       pool_address = excluded.pool_address,
       wallet_address = excluded.wallet_address,
       block_time = excluded.block_time,
       amount_x_usd = excluded.amount_x_usd,
       amount_y_usd = excluded.amount_y_usd,
       total_usd = excluded.total_usd`,
  ).run({
    position_id: e.positionId,
    pool_address: e.poolAddress ?? null,
    wallet_address: e.walletAddress ?? null,
    event_type: e.eventType,
    signature: e.signature,
    ix_index: e.ixIndex ?? null,
    block_time: e.blockTime ?? null,
    token_x_mint: e.tokenXMint ?? null,
    token_y_mint: e.tokenYMint ?? null,
    amount_x: e.amountX ?? null,
    amount_y: e.amountY ?? null,
    amount_x_usd: num(e.amountXUsd),
    amount_y_usd: num(e.amountYUsd),
    total_usd: num(e.totalUsd),
  });
}

/** All events for a position, oldest-first. */
export function getPositionEvents(positionId) {
  return getDb().prepare(
    `SELECT * FROM position_events WHERE position_id = ? ORDER BY block_time ASC, id ASC`,
  ).all(positionId);
}

/**
 * Metlex-style PnL aggregates derived from the event ledger:
 *   PnL = (withdrawals + fees) − deposits
 */
export function getPnlFromEvents(positionId) {
  const events = getPositionEvents(positionId);
  const sumType = (type) =>
    events
      .filter((e) => e.event_type === type)
      .reduce((s, e) => s + (Number(e.total_usd) || 0), 0);

  const totalDeposit = sumType("add");
  const totalWithdraw = sumType("remove");
  const totalFees = sumType("claim_fee");
  const proceeds = totalWithdraw + totalFees;
  const pnlUsd = proceeds - totalDeposit;
  const pnlPct = totalDeposit > 0 ? (proceeds / totalDeposit - 1) * 100 : 0;

  const first = events.find((e) => e.block_time);
  const last = [...events].reverse().find((e) => e.block_time);
  const durationMs = first && last ? last.block_time - first.block_time : null;

  return {
    event_count: events.length,
    total_deposit_usd: totalDeposit,
    total_withdraw_usd: totalWithdraw,
    total_fees_usd: totalFees,
    proceeds_usd: proceeds,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    first_event_at: first?.block_time ?? null,
    last_event_at: last?.block_time ?? null,
    duration_ms: durationMs,
  };
}
