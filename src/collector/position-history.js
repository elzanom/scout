import { fetchPositionEvents, fetchPoolPositionPnl } from "../screener/metrics-fetcher.js";
import { upsertPositionEvent } from "../db/position-events.js";
import { heliusApiPost } from "../rpc/helius-router.js";
import { decodeDlmmInstructionsInTx, binRangeFromDecoded, computeBinDistribution } from "./dlmm-decoder.js";
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

/**
 * Decode a position's bin range from an on-chain Meteora DLMM transaction — the same
 * "tx-decode" path Metlex uses (rangeSource:"tx-decode"), independent of the Meteora API.
 *
 * Pass an explicit `txSig`, or omit it and pass the cached `events` ledger: the close tx
 * (the remove / claim_fee event signature) is derived automatically, which yields the full
 * [lower, upper] range (remove_liquidity_by_range_2 / claim_fee_2 carry both bin ids).
 *
 * @param {{ txSig?: string, events?: object[], positionId?: string, poolAddress?: string, walletAddress?: string }} opts
 * @returns {Promise<{ signature, slot, blockTime, binRange, binDistribution, instructions }|null>}
 */
export async function decodePositionBinRange({ txSig, events, positionId, poolAddress, walletAddress } = {}) {
  const sig =
    txSig ||
    (Array.isArray(events) && events.find((e) => e.event_type === "remove")?.signature) ||
    (Array.isArray(events) && events.find((e) => e.event_type === "claim_fee")?.signature);
  if (!sig) return null;

  try {
    const txs = await heliusApiPost("/v0/transactions/", { transactions: [sig] }, {}, { maxAttempts: 3 });
    const tx = Array.isArray(txs) ? txs[0] : txs;
    if (!tx) return null;
    const decoded = decodeDlmmInstructionsInTx(tx);
    // When a positionId is given, ensure the tx actually references it — otherwise ?tx= could be
    // used as an arbitrary-transaction decode oracle (IDOR on public on-chain data + Helius cost).
    if (positionId) {
      const referenced = decoded
        .filter((d) => d.kind === "instruction")
        .some((d) => (d.accounts || []).includes(positionId));
      if (!referenced) {
        log("position_history_warn", `tx ${sig.slice(0, 8)}… does not reference position ${positionId.slice(0, 8)}…`);
        return null;
      }
    }
    const compact = (d) => {
      const o = { kind: d.kind, name: d.name || d.eventId };
      if (d.lowerBinId != null) o.lowerBinId = d.lowerBinId;
      if (d.upperBinId != null) o.upperBinId = d.upperBinId;
      if (d.amountX != null) o.amountX = d.amountX;
      if (d.amountY != null) o.amountY = d.amountY;
      return o;
    };
    // Enrich with the per-bin price ladder (Metlex "Range" view) when we know pool+wallet —
    // matches this position in /positions/{pool}/pnl and derives the per-bin ratio from its
    // own minPrice/maxPrice. Best-effort: null when Meteora is unavailable or the position
    // isn't returned (e.g. closed long ago).
    let binDistribution = null;
    if (poolAddress && walletAddress && positionId) {
      try {
        binDistribution = await fetchPositionBinDetail(poolAddress, walletAddress, positionId);
      } catch (err) {
        log("position_history_warn", `bin distribution ${positionId.slice(0, 8)}…: ${err.message}`);
      }
    }
    return {
      signature: sig,
      slot: tx.slot ?? null,
      blockTime: tx.timestamp ?? tx.blockTime ?? null,
      binRange: binRangeFromDecoded(decoded),
      binDistribution,
      instructions: decoded.map(compact),
    };
  } catch (err) {
    log("position_history_warn", `decode bin range ${sig.slice(0, 8)}…: ${err.message}`);
    return null;
  }
}

/**
 * Fetch this position's bin detail (minPrice/maxPrice/poolActiveBinId/poolActivePrice) by matching
 * its positionAddress in /positions/{pool}/pnl, then compute the per-bin distribution.
 * @returns {Promise<object|null>} computeBinDistribution result, or null.
 */
async function fetchPositionBinDetail(poolAddress, walletAddress, positionAddress) {
  const positions = await fetchPoolPositionPnl(walletAddress, poolAddress, { status: "all", pageSize: 100 });
  const match = (positions || []).find((p) => p.positionAddress === positionAddress);
  if (!match) return null;
  return computeBinDistribution({
    lowerBinId: match.lowerBinId,
    upperBinId: match.upperBinId,
    minPrice: match.minPrice,
    maxPrice: match.maxPrice,
    poolActiveBinId: match.poolActiveBinId,
    poolActivePrice: match.poolActivePrice,
  });
}
