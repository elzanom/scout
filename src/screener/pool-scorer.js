import { config } from "../../config/config.js";
import { loadWeights } from "../signals/weights.js";

/** Discovery-API timeframes → minutes. Used by degenScore normalization + volatility re-fetch. */
export const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};

// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this 30m reference window,
// so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;

/**
 * Simple linear ranking score for sorting candidates by raw quality, adjusted by
 * Darwinian signal weights learned from past closed-position outcomes.
 */
export function scoreCandidate(pool) {
  const weights = loadWeights();
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return (
    feeTvl * 1000 * (weights.fee_tvl_ratio ?? 1) +
    organic * 10 * (weights.organic_score ?? 1) +
    (volume / 100) * (weights.volume ?? 1) +
    (holders / 100) * (weights.holder_count ?? 1)
  );
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity      → unique_lps + positions_created
 *   3. Fees paid to LPs        → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity               → active_tvl (log floor — dust pools can't win on ratios)
 * Each sub-score saturates at its target. The volume/fee/LP inputs are measured over
 * config.screening.timeframe, so they're normalized to a fixed 30m reference window first.
 * Ported verbatim from meridian tools/screening.js.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,     // (30m) volume/active_tvl for a full trading sub-score
    targetLpCount = 40,      // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,   // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for a full liquidity sub-score (not TF-scaled)
  } = targets;

  const weights = loadWeights();
  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  // Apply Darwinian weights to sub-scores (weights default to 1.0).
  const sTrading = clamp01(tradingRatio / targetVolRatio) * (weights.volume ?? 1);
  const sLp      = clamp01(lpActivity / targetLpCount) * (weights.holder_count ?? 1);
  const sFees    = clamp01(feeRatio / targetFeeRatio) * (weights.fee_tvl_ratio ?? 1);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

/** Pool score normalized to 0..1, for the signal confidence formula (CLAUDE.md calculateConfidence). */
export function poolScore01(pool, targets) {
  return Math.min(1, Math.max(0, degenScore(pool, targets) / 100));
}

// ─── Timeframe-scaled screening defaults ────────────────────────────────────
// fee_active_tvl_ratio and volume are window-dependent — the same numeric threshold means
// very different things on 30m vs 24h. These scales let you re-baseline thresholds per TF.
// (Ported from meridian screening-scales.js. Not auto-applied — available as a tuning utility.)
export const TIMEFRAME_SCREENING_SCALES = {
  "5m":  { minFeeActiveTvlRatio: 0.02, minVolume: 500 },
  "30m": { minFeeActiveTvlRatio: 0.15, minVolume: 1_000 },
  "1h":  { minFeeActiveTvlRatio: 0.2,  minVolume: 10_000 },
  "2h":  { minFeeActiveTvlRatio: 0.4,  minVolume: 20_000 },
  "4h":  { minFeeActiveTvlRatio: 0.4,  minVolume: 2_000 },
  "12h": { minFeeActiveTvlRatio: 1.5,  minVolume: 60_000 },
  "24h": { minFeeActiveTvlRatio: 2.0,  minVolume: 10_000 },
};

const DEFAULT_TIMEFRAME = "4h";

export function normalizeTimeframe(timeframe) {
  const tf = String(timeframe || DEFAULT_TIMEFRAME).trim().toLowerCase();
  return TIMEFRAME_SCREENING_SCALES[tf] ? tf : DEFAULT_TIMEFRAME;
}

export function getScreeningDefaultsForTimeframe(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  return { timeframe: tf, ...TIMEFRAME_SCREENING_SCALES[tf] };
}

/** Returns { minFeeActiveTvlRatio, minVolume } scaled to the given timeframe. */
export function scaleScreeningToTimeframe(timeframe) {
  const { minFeeActiveTvlRatio, minVolume } = getScreeningDefaultsForTimeframe(timeframe);
  return { minFeeActiveTvlRatio, minVolume };
}
