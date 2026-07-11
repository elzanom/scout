/**
 * Bayesian smoothing helpers — keep noisy small-N metrics from dominating rankings.
 *
 * Raw WR = wins/total explodes on tiny samples (1/1 = 100%). Bayesian shrinkage pulls
 * the estimate toward a prior, trading off "how much we trust this wallet's track record"
 * against "how much we trust the prior". Formula:
 *
 *   smoothed = (wins + α · prior) / (total + α)
 *
 * - α = 10 means "10 prior pseudo-observations"
 * - prior = 0.5 (neutral) means a wallet with 0 closed positions scores 0.5 WR
 * - With 50 closed positions, prior weight is ~17% — still meaningful
 * - With 5 closed positions, prior weight is ~67% — dominates the estimate
 *
 * Net effect: tiny-N wallets look average, not extreme. Top wallets must accumulate
 * real volume to climb above the prior. Once they do, their WR reflects actual skill.
 */

/**
 * Bayesian-smoothed win rate.
 * @param {number} wins
 * @param {number} total
 * @param {number} prior default 0.5 (neutral)
 * @param {number} alpha default 10 (pseudo-observations)
 * @returns {number} smoothed WR in [0, 1]
 */
export function bayesianWinRate(wins, total, prior = 0.5, alpha = 10) {
  const w = Math.max(0, Number(wins) || 0);
  const t = Math.max(0, Number(total) || 0);
  const p = Math.min(1, Math.max(0, Number(prior) || 0));
  const a = Math.max(0, Number(alpha) || 0);
  if (t + a === 0) return p;
  return (w + a * p) / (t + a);
}

/**
 * Score an estimator's reliability by sample size. Use to gate metric usage:
 *   const conf = sampleConfidence(totalPositions);
 *   const effectiveWr = rawWr * conf + smoothedWr * (1 - conf);
 * Higher total → closer to raw. Lower total → closer to prior.
 * @param {number} total
 * @param {number} halfAt how many samples we want ~50/50 mix (default 10)
 * @returns {number} 0..1
 */
export function sampleConfidence(total, halfAt = 10) {
  const t = Math.max(0, Number(total) || 0);
  return t / (t + halfAt);
}
