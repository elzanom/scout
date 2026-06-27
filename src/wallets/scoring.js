/**
 * Wallet scoring + signal confidence — pure functions (CLAUDE.md formulas).
 * Shared by the wallet-evaluator (Phase 3) and the signal validator (Phase 6).
 */

/**
 * Composite wallet score, 0-100. Weighted sum: win-rate (40) + fee yield (20) +
 * consistency/position-count (20) + overall PnL sign (20).
 *
 * @param {{ win_rate?: number, avg_fee_yield?: number, total_positions?: number, total_pnl_usd?: number }} w
 * @returns {number} 0-100
 */
export function calculateWalletScore(w) {
  const winRate = Number(w?.win_rate || 0);
  const feeYield = Number(w?.avg_fee_yield || 0);
  const totalPos = Number(w?.total_positions || 0);
  const pnl = Number(w?.total_pnl_usd || 0);

  const wrScore = winRate * 40;                                  // max 40
  const feeScore = Math.min((feeYield / 3) * 20, 20);            // max 20
  const consistencyScore = Math.min((totalPos / 100) * 20, 20);  // max 20
  const pnlScore = pnl > 0 ? 20 : 0;                              // max 20

  return Math.round((wrScore + feeScore + consistencyScore + pnlScore) * 100) / 100;
}

/**
 * Combined confidence for the double-validation signal gate.
 * Pool counts more than wallet (0.6 vs 0.4) — a great pool entered by a decent wallet
 * is a stronger signal than a great wallet in a mediocre pool.
 *
 * @param {number} walletScore 0-100
 * @param {number} poolScore 0-1 (degenScore / 100)
 * @returns {number} 0-1
 */
export function calculateConfidence(walletScore, poolScore) {
  // walletScore is 0-100 → normalize to 0-1 (divide first, THEN clamp).
  const wNorm = Math.min(1, Math.max(0, (Number(walletScore) || 0) / 100));
  const p = Math.min(1, Math.max(0, Number(poolScore) || 0));
  return Math.round((wNorm * 0.4 + p * 0.6) * 1000) / 1000;
}
