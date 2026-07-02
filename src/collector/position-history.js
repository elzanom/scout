import { fetchPositionEvents } from "../screener/metrics-fetcher.js";
import { upsertPositionEvent } from "../db/position-events.js";
import { log } from "../utils/logger.js";

/**
 * Sync a single position's cash-flow event timeline from Meteora
 * (/positions/{positionAddress}/historical) into the position_events table.
 *
 * This is the Metlex-style per-position ledger: add (deposit) / remove (withdraw) /
 * claim_fee events with USD amounts and timestamps. Keyed by the POSITION (NFT) address,
 * not a wallet — same as Metlex's /pnl2/<positionAddress>.
 *
 * Idempotent via the (position_id, signature, ix_index) unique constraint.
 *
 * @param {string} positionAddress  position NFT address (NOT a wallet address)
 * @returns {Promise<{ positionId: string, ingested: number, total: number }>}
 */
export async function syncPositionEvents(positionAddress) {
  const resp = await fetchPositionEvents(positionAddress);
  const events = Array.isArray(resp?.events) ? resp.events : [];

  let ingested = 0;
  for (const ev of events) {
    try {
      upsertPositionEvent({
        positionId: ev.positionAddress || positionAddress,
        poolAddress: ev.poolAddress,
        walletAddress: ev.userAddress,
        eventType: ev.eventType,
        signature: ev.signature,
        ixIndex: ev.ixIndex,
        blockTime: ev.blockTime ? Math.floor(ev.blockTime) : null,
        tokenXMint: ev.tokenX,
        tokenYMint: ev.tokenY,
        amountX: ev.amountX,
        amountY: ev.amountY,
        amountXUsd: ev.amountXUsd,
        amountYUsd: ev.amountYUsd,
        totalUsd: ev.totalUsd,
      });
      ingested++;
    } catch (err) {
      log("position_history_warn", `upsert event ${ev.signature?.slice(0, 8) ?? "?"}: ${err.message}`);
    }
  }

  log("position_history", `sync ${positionAddress.slice(0, 8)}…: ${ingested}/${events.length} events`);
  return { positionId: positionAddress, ingested, total: events.length };
}
