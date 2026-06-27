import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { screenPool } from "../screener/pool-screener.js";
import { getWallet } from "../db/wallets.js";
import { calculateConfidence } from "../wallets/scoring.js";
import { emitSignal } from "./emitter.js";

/**
 * Double validation (SPEC §7): a top wallet entering a pool becomes a signal only if
 *   1. the wallet is a top wallet with score >= minWalletScore, AND
 *   2. the pool passes screening, AND
 *   3. combined confidence >= minCombinedConfidence.
 * Returns the verdict with wallet/pool/confidence/reasons/suggested params.
 */
export async function validateSignal(walletAddress, poolAddress) {
  // Check 1 — wallet
  const wallet = getWallet(walletAddress);
  if (!wallet) return { passes: false, reasons: ["wallet unknown"] };
  if (!wallet.is_top_wallet) return { passes: false, reasons: [`wallet not top (status=${wallet.status})`] };
  if (wallet.score < config.tiers.minWalletScore) {
    return { passes: false, reasons: [`wallet score ${wallet.score} < ${config.tiers.minWalletScore}`] };
  }
  const reasons = ["top_wallet_entered"];

  // Check 2 — pool
  const screened = await screenPool(poolAddress);
  if (!screened.passes) return { passes: false, reasons: [`pool not screened: ${screened.reason}`] };
  const pool = screened.pool;
  reasons.push("pool_passed_screening");

  // Confidence gate
  const confidence = calculateConfidence(wallet.score, pool.pool_score);
  if (confidence < config.signals.minCombinedConfidence) {
    return { passes: false, reasons: [`confidence ${confidence.toFixed(3)} < ${config.signals.minCombinedConfidence}`], wallet, pool, confidence };
  }

  // Suggested params: the top wallet's own bin range in this pool (their proven config), else just bin_step
  const own = getDb().prepare(
    `SELECT bin_lower, bin_upper FROM positions WHERE wallet_address = ? AND pool_address = ? AND bin_lower IS NOT NULL ORDER BY entry_timestamp DESC LIMIT 1`,
  ).get(walletAddress, poolAddress);

  return {
    passes: true,
    wallet,
    pool,
    confidence,
    reasons,
    suggested: {
      bin_step: pool.bin_step,
      range_lower: own?.bin_lower ?? null,
      range_upper: own?.bin_upper ?? null,
    },
    poolMetrics: {
      fee_apr: pool.fee_active_tvl_ratio, // fee/active-TVL proxy
      volume_24h: pool.volume_window,
      tvl: pool.tvl,
      fee_tvl_ratio: pool.fee_active_tvl_ratio,
      organic_score: pool.base?.organic ?? null,
    },
  };
}

/**
 * Signal pipeline entry: validate a (wallet, pool) entry event; if it passes, emit the signal.
 * Called by the webhook/orchestrator when a top wallet is seen entering a pool.
 * @returns {Promise<{emitted: boolean, signal?: object, reasons: string[]}>}
 */
export async function processWalletEntry(walletAddress, poolAddress) {
  const verdict = await validateSignal(walletAddress, poolAddress);
  if (!verdict.passes) {
    log("signal", `skip ${walletAddress?.slice(0, 8)}… @ ${poolAddress?.slice(0, 8)}… — ${verdict.reasons.join("; ")}`);
    return { emitted: false, reasons: verdict.reasons };
  }
  const signal = await emitSignal({
    wallet: verdict.wallet,
    pool: verdict.pool,
    confidence: verdict.confidence,
    reasons: verdict.reasons,
    suggested: verdict.suggested,
    poolMetrics: verdict.poolMetrics,
  });
  return { emitted: true, signal, reasons: verdict.reasons };
}
