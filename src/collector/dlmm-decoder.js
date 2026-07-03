/**
 * Meteora DLMM on-chain instruction decoder.
 *
 * Decodes Meteora DLMM (v2) Anchor instructions from raw Helius enhanced-transaction data —
 * the same "tx-decode" path Metlex uses (rangeSource:"tx-decode") to recover a position's bin
 * range without the Meteora portfolio API.
 *
 * Discriminators are the first 8 bytes of each instruction's data (= sha256("global:<name>")[:8]
 * for standard Anchor methods). Verified against live transactions and cross-checked with public
 * decoder repos (staccDOTsol/stacSOL hawkfi-v2.ts, bucketshop69/myboon, accretion-xyz).
 *
 * NOTE: Meteora emits Swap/AddLiquidity/etc EVENTS via Anchor self-CPI — those show up as
 * instructions whose data begins with the DLMM_EVENT_HEADER prefix. They are NOT user operations
 * and are reported separately (kind:"event").
 */

import { log } from "../utils/logger.js";

export const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

/** Verified Meteora DLMM (v2) instruction discriminators. */
export const DLMM_INSTRUCTIONS = {
  dbc0ea47bebf6650: "initialize_position",
  "03dd95da6f8d76d5": "add_liquidity_by_strategy_2",
  cc02c391359191cd: "remove_liquidity_by_range_2",
  "70bf65ab1c907fbb": "claim_fee_2",
  "3b7cd4765b986e9d": "close_position_if_empty",
};

/** Anchor CPI event header — emitted events (Swap/AddLiq/RemoveLiq/ClaimFee) carry this + an
 *  8-byte event discriminator. NOT a real instruction. */
export const DLMM_EVENT_HEADER = "e445a52e51cb9a1d";

const BS58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string to a Buffer (Bitcoin alphabet). */
export function base58Decode(s) {
  const bytes = [];
  for (const c of s) {
    let carry = BS58.indexOf(c);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of s) {
    if (c === "1") bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

const i32 = (b, o) => (b && b.length >= o + 4 ? b.readInt32LE(o) : null);
const u64 = (b, o) => (b && b.length >= o + 8 ? Number(b.readBigUInt64LE(o)) : null);

/** Is this Helius instruction a Meteora DLMM user operation (excludes emitted events)? */
export function isDlmmInstruction(ix) {
  if (ix?.programId !== DLMM_PROGRAM_ID) return false;
  const data = base58Decode(ix.data || "");
  return data.slice(0, 8).toString("hex") !== DLMM_EVENT_HEADER;
}

/**
 * Decode one DLMM instruction into a structured shape.
 * @param {{programId:string, data:string, accounts?:string[]}} ix  Helius instruction
 * @returns {{program,kind,name?,discriminator,accounts,lowerBinId?,upperBinId?,amountX?,amountY?,walletAddress?,positionAddress?,poolAddress?,eventId?}|null}
 */
export function decodeDlmmInstruction(ix) {
  if (ix?.programId !== DLMM_PROGRAM_ID) return null;
  const data = base58Decode(ix.data || "");
  const discriminator = data.slice(0, 8).toString("hex");
  const accounts = ix.accounts || [];

  if (discriminator === DLMM_EVENT_HEADER) {
    return { program: "dlmm", kind: "event", discriminator, eventId: data.slice(8, 16).toString("hex") };
  }

  const name = DLMM_INSTRUCTIONS[discriminator];
  const args = data.slice(8);
  const out = { program: "dlmm", kind: "instruction", name: name || "unknown", discriminator, accounts };
  if (!name) return out;

  try {
    switch (name) {
      case "initialize_position":
        // args: lower_bin_id(i32), upper_bin_id(i32).
        // accounts: [owner, position, lbPair(pool), owner, system, rent, binArray, program]
        out.lowerBinId = i32(args, 0);
        out.upperBinId = i32(args, 4);
        out.walletAddress = accounts[0];
        out.positionAddress = accounts[1];
        out.poolAddress = accounts[2];
        break;
      case "remove_liquidity_by_range_2":
      case "claim_fee_2":
        // args: lower_bin_id(i32), upper_bin_id(i32), ...
        out.lowerBinId = i32(args, 0);
        out.upperBinId = i32(args, 4);
        break;
      case "add_liquidity_by_strategy_2":
        // args: amount_x(u64), amount_y(u64), strategy params + bin range (offset varies by
        // distribution shape, so only the two leading amounts are decoded here).
        out.amountX = u64(args, 0);
        out.amountY = u64(args, 8);
        break;
      default:
        break;
    }
  } catch {
    /* short data — leave fields unset */
  }
  return out;
}

/** Walk a Helius enhanced transaction and decode every DLMM instruction (including inner). */
export function decodeDlmmInstructionsInTx(tx) {
  const out = [];
  const walk = (insts) => {
    for (const ix of insts || []) {
      if (ix?.programId === DLMM_PROGRAM_ID) {
        const decoded = decodeDlmmInstruction(ix);
        if (decoded) out.push(decoded);
      }
      if (ix?.innerInstructions?.length) walk(ix.innerInstructions);
    }
  };
  walk(tx?.instructions || []);
  return out;
}

/**
 * Best-effort bin range [lowerBinId, upperBinId] decoded purely from on-chain instructions.
 * Reliable from remove_liquidity_by_range_2 / claim_fee_2 (range at stable arg offsets);
 * falls back to initialize_position.lower_bin_id when only the open tx is available.
 *
 * @param {object[]} decoded  output of decodeDlmmInstructionsInTx
 * @returns {{lowerBinId:number, upperBinId:number|null, source:string}|null}
 */
export function binRangeFromDecoded(decoded) {
  for (const d of decoded) {
    if (
      Number.isInteger(d.lowerBinId) &&
      Number.isInteger(d.upperBinId) &&
      d.upperBinId >= d.lowerBinId
    ) {
      return { lowerBinId: d.lowerBinId, upperBinId: d.upperBinId, source: d.name };
    }
  }
  const init = decoded.find((d) => d.name === "initialize_position");
  if (Number.isInteger(init?.lowerBinId)) {
    return { lowerBinId: init.lowerBinId, upperBinId: null, source: "initialize_position" };
  }
  return null;
}

/**
 * Build a per-bin price ladder + coverage over a position's bin range — Metlex's "Range" view,
 * without hard-decoding the addLiquidity distribution.
 *
 * The per-bin price ratio is DERIVED from the position's own endpoints:
 *   ratio = (maxPrice/minPrice) ^ (1 / (upperBinId - lowerBinId))     (= 1 + binStep/10000)
 * and prices are anchored to the pool's active bin/price:
 *   price(binId) = activePrice * ratio ^ (binId - activeBinId)
 * (Verified against live Meteora data: adjacent bins differ by exactly (1 + binStep/10000).)
 *
 * @param {{lowerBinId:number, upperBinId:number, minPrice:number, maxPrice:number, poolActiveBinId?:number, poolActivePrice?:number, padding?:number}} args
 * @returns {{ratio:number, lowerBinId:number, upperBinId:number, activeBinId:number|null, activePrice:number|null, bins:Array<{binId:number,price:number,inRange:boolean,isActive:boolean}>}|null}
 */
export function computeBinDistribution({
  lowerBinId,
  upperBinId,
  minPrice,
  maxPrice,
  poolActiveBinId,
  poolActivePrice,
  padding = 3,
}) {
  if (
    !Number.isInteger(lowerBinId) ||
    !Number.isInteger(upperBinId) ||
    upperBinId < lowerBinId ||
    !(minPrice > 0) ||
    !(maxPrice > 0)
  ) {
    return null;
  }
  const ratio = Math.pow(maxPrice / minPrice, 1 / (upperBinId - lowerBinId));
  // Anchor prices to the active bin when available, else to the lower edge.
  const useActive = Number.isInteger(poolActiveBinId) && poolActivePrice > 0;
  const anchorBin = useActive ? poolActiveBinId : lowerBinId;
  const anchorPrice = useActive ? poolActivePrice : minPrice;
  const priceAt = (binId) => anchorPrice * Math.pow(ratio, binId - anchorBin);

  const from = lowerBinId - padding;
  const to = upperBinId + padding;
  const bins = [];
  for (let binId = from; binId <= to; binId++) {
    bins.push({
      binId,
      price: Number(priceAt(binId).toPrecision(8)),
      inRange: binId >= lowerBinId && binId <= upperBinId,
      isActive: useActive && binId === poolActiveBinId,
    });
  }
  return {
    ratio,
    lowerBinId,
    upperBinId,
    activeBinId: useActive ? poolActiveBinId : null,
    activePrice: useActive ? poolActivePrice : null,
    bins,
  };
}
