/**
 * Pool regime classification — derive a coarse market regime from a pool's
 * (volatility, bin_step) so we can weight wallet strategy fit: a `spot` wallet
 * thrives in trending pools, a `bid_ask` wallet in range-bound pools. Regime
 * doesn't change pool scoring, only wallet-side confidence modulation.
 *
 * 4 regimes (heuristic, calibrated to Meteora DLMM mainnet):
 *   - trending   vol ≥ 0.8  AND bin_step ≥ 100       (active discovery, momentum)
 *   - range      vol <  0.3  AND bin_step ≤ 100       (sideways, tight farming)
 *   - volatile   vol ≥ 1.2  AND bin_step ≥ 125       (extreme moves, wide bin)
 *   - mixed      doesn't fit cleanly above (default)
 *
 * Ties broken in priority: volatile > trending > range > mixed.
 */

/**
 * Classify a pool's regime from snapshot fields.
 * @param {{ volatility?: number, bin_step?: number }} p
 * @returns {"trending"|"range"|"volatile"|"mixed"|"unknown"}
 */
export function classifyPoolRegime(p = {}) {
  const vol = Number(p.volatility);
  const bs = Number(p.bin_step);
  if (!Number.isFinite(vol) || !Number.isFinite(bs)) return "unknown";
  if (vol >= 1.2 && bs >= 125) return "volatile";
  if (vol >= 0.8 && bs >= 100) return "trending";
  if (vol < 0.3 && bs <= 100) return "range";
  return "mixed";
}

/**
 * Derive regime directly from a Meteora pool object (the same shape returned by
 * `screenPool(poolAddress)`). No DB query — caller passes the pool they already have.
 * @param {object} pool  Meteora pool object with { dlmm_params.bin_step, volatility }
 * @returns {"trending"|"range"|"volatile"|"mixed"|"unknown"}
 */
export function regimeFromPool(pool) {
  if (!pool) return "unknown";
  const binStep = Number(pool?.dlmm_params?.bin_step ?? pool?.bin_step);
  const vol = Number(pool?.volatility ?? pool?.token_volatility_24h);
  return classifyPoolRegime({ volatility: vol, bin_step: binStep });
}

/**
 * Strategy × regime fit multiplier. 1.0 = neutral, > 1.0 = good fit, < 1.0 = poor fit.
 *
 * spot wallet:     trending/volatile boost (momentum capture), range penalized
 * bid_ask wallet:  range boost (mean-reversion farming), trending penalized
 * curve wallet:    slight range bias (curve farming), modest penalty in trending
 * unknown:         neutral
 *
 * @param {string|null} preferredStrategy "spot" | "bid_ask" | "curve" | "unknown" | null
 * @param {"trending"|"range"|"volatile"|"mixed"|"unknown"} regime
 * @returns {number} multiplier in [0.7, 1.3]
 */
export function strategyFitMultiplier(preferredStrategy, regime) {
  const s = String(preferredStrategy || "unknown").toLowerCase();
  const r = String(regime || "unknown").toLowerCase();

  const table = {
    spot:    { trending: 1.20, volatile: 1.10, range: 0.80, mixed: 1.00, unknown: 1.00 },
    bid_ask: { trending: 0.70, volatile: 0.80, range: 1.20, mixed: 1.00, unknown: 1.00 },
    curve:   { trending: 0.90, volatile: 0.90, range: 1.05, mixed: 1.00, unknown: 1.00 },
    unknown: { trending: 1.00, volatile: 1.00, range: 1.00, mixed: 1.00, unknown: 1.00 },
  };

  const mult = (table[s] && table[s][r] != null) ? table[s][r] : 1.0;
  return Math.min(1.3, Math.max(0.7, mult));
}

/**
 * Range style × regime fit. Wider range suits volatile; tight range suits sideways.
 * @param {string|null} preferredRangeStyle "tight" | "medium" | "wide" | "unknown" | null
 * @param {"trending"|"range"|"volatile"|"mixed"|"unknown"} regime
 * @returns {number} multiplier in [0.85, 1.15]
 */
export function rangeStyleFitMultiplier(preferredRangeStyle, regime) {
  const s = String(preferredRangeStyle || "unknown").toLowerCase();
  const r = String(regime || "unknown").toLowerCase();

  const table = {
    tight:   { range: 1.15, trending: 0.95, volatile: 0.85, mixed: 1.00, unknown: 1.00 },
    medium:  { range: 1.00, trending: 1.00, volatile: 1.00, mixed: 1.00, unknown: 1.00 },
    wide:    { range: 0.90, trending: 1.05, volatile: 1.15, mixed: 1.00, unknown: 1.00 },
    unknown: { range: 1.00, trending: 1.00, volatile: 1.00, mixed: 1.00, unknown: 1.00 },
  };

  const mult = (table[s] && table[s][r] != null) ? table[s][r] : 1.0;
  return Math.min(1.15, Math.max(0.85, mult));
}

/**
 * Combined fit score for a wallet × pool regime.
 * Returns the geometric mean of strategy + range style fit (both must agree for high score).
 * Clamped to [0.75, 1.25].
 *
 * @param {{ preferred_strategy?: string|null, preferred_range_style?: string|null }} wallet
 * @param {"trending"|"range"|"volatile"|"mixed"|"unknown"} regime
 * @returns {{ multiplier: number, strategyFit: number, rangeFit: number, regime: string }}
 */
export function regimeFitScore(wallet, regime) {
  const strategyFit = strategyFitMultiplier(wallet?.preferred_strategy, regime);
  const rangeFit = rangeStyleFitMultiplier(wallet?.preferred_range_style, regime);
  // Geometric mean is symmetric: 1.2× * 0.8× = ~0.98 (slight penalty for mixed signals).
  const multiplier = Math.sqrt(strategyFit * rangeFit);
  return {
    multiplier: Math.min(1.25, Math.max(0.75, multiplier)),
    strategyFit,
    rangeFit,
    regime,
  };
}
