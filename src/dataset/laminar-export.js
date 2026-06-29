/**
 * Export Scout closed-position outcomes into Laminar-compatible formats for MANUAL training:
 *   1. dataset/laminar-lessons.json       → mirror Laminar's lessons.json structure
 *   2. dataset/laminar-messages.jsonl     → OpenAI messages format for LLM fine-tuning
 *   3. dataset/laminar-signal-weights.json → Darwinian weights in Laminar's signal-weights.json format
 *   4. dataset/laminar-pool-memory.json     → Pool memory keyed by pool address
 *   5. dataset/laminar-decision-traces.jsonl→ Screener-style decision traces
 *
 * No on-chain execution; the user copies these files into Laminar and runs training manually.
 *
 * DATA LIMITATIONS vs real Laminar learning:
 *   - close_reason: inferred from PnL%, duration, fee_yield, volatility and organic score. The
 *     heuristic is intentionally conservative: it labels big directional moves as OOR, long flat
 *     holds as low_yield, and medium-duration profits as trailing_tp when appropriate. Real labels
 *     require Laminar's own position tracking.
 *   - range_efficiency: not tracked by Scout — left null in performance entries.
 *   - minutes_in_range: Scout doesn't observe OOR duration.
 *   - hive_consensus: not available (would need HiveMind Laminar pull).
 *   - strategy: inferred from wallet preferred_strategy (Agent Meridian) — may be "unknown".
 *   - Darwinian weights are recomputed from Scout data only; for production Laminar learning
 *     these are a useful bootstrap but should be regenerated once Laminar has its own positions.
 */
import fs from "fs";
import path from "path";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { getNearestSnapshot } from "../db/market-snapshots.js";

const now = () => Math.floor(Date.now() / 1000);

const LAMINAR_SIGNAL_NAMES = [
  "organic_score", "fee_tvl_ratio", "volume", "mcap", "holder_count",
  "smart_wallets_present", "narrative_quality", "study_win_rate",
  "hive_consensus", "volatility", "entry_mcap", "entry_tvl", "entry_volume",
];

const HIGHER_IS_BETTER = new Set([
  "organic_score", "fee_tvl_ratio", "volume", "holder_count",
  "study_win_rate", "hive_consensus",
]);

const DARWIN_DEFAULTS = {
  windowDays: 60,
  minSamples: 10,
  boostFactor: 1.05,
  decayFactor: 0.95,
  weightFloor: 0.3,
  weightCeiling: 2.5,
};

function outFile(name) {
  const base = config.dataset.exportPath ? path.dirname(config.dataset.exportPath) : path.join(process.cwd(), "dataset");
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return path.join(base, name);
}

function fmtNum(n) {
  if (n == null) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

function parseSignalSnapshot(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Laminar's outcome buckets (matches lessons.js derivLesson) */
function outcomeFromPosition(perf) {
  const pnlPct = Number(perf.pnl_pct) || 0;
  const initial = perf.initial_value_usd || 0;
  const fees = perf.fees_earned_usd || 0;
  const feeYieldPct = initial > 0 ? (fees / initial) * 100 : 0;
  if (pnlPct >= 5) return "good";
  if (pnlPct >= 0 && feeYieldPct >= 2) return "good";
  if (pnlPct >= 0) return "neutral";
  if (pnlPct >= -5) return "poor";
  return "bad";
}

/** Laminar's close_reason categories (matches close-reason.js) */
function normalizeCloseReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("stop loss") || r.includes("stop_loss")) return "stop_loss";
  if (r.includes("take profit") || r.includes("take_profit")) return "take_profit";
  if (r.includes("oor below")) return "oor_below";
  if (r.includes("pumped far above range") || r.includes("oor above")) return "oor_above";
  if (r.includes("out of range") || r.includes("out_of_range") || r === "oor") return "oor";
  if (r.includes("low yield") || r.includes("low_yield") || r.includes("fee/tvl")) return "low_yield";
  if (r.includes("trailing tp") || r.includes("trailing_tp")) return "trailing_tp";
  if (r.includes("agent")) return "agent";
  if (r.includes("manual") || r.includes("user requested")) return "manual";
  return "unknown";
}

/**
 * Scout's best-effort close_reason estimation.
 *
 * We don't know the real trigger, so we combine several proxies:
 * - PnL sign + magnitude
 * - holding duration
 * - fee_yield vs capital returned
 * - volatility / organic score from the entry snapshot
 *
 * Categories map to Laminar: stop_loss, take_profit, trailing_tp, oor_above,
 * oor_below, oor, low_yield, agent, manual, unknown.
 */
function estimateCloseReason({ pnlUsd, pnlPct, durationHours, feeYield, volatility, organicScore }) {
  const pnl = Number(pnlUsd) || 0;
  const pct = Number(pnlPct) || 0;
  const hours = Number(durationHours);
  const validHours = Number.isFinite(hours) && hours >= 0;
  const fees = Number(feeYield) || 0;                     // percent of capital earned in fees
  const vol = Number(volatility) || 0;
  const organic = Number(organicScore) || 0;

  // No outcome data at all
  if (pnlUsd == null && pnlPct == null) return "unknown";

  // Duration-based edge cases first — these are the strongest heuristics
  if (validHours && hours > 0) {
    // Very quick loss + any meaningful volatility → likely stopped out / OOR
    if (pct < -3 && hours < 4 && vol > 3) {
      return pct <= -10 ? "oor" : "stop_loss";
    }
    // Very quick gain → aggressive take-profit (could also be trailing)
    if (pct > 5 && hours < 2) return "take_profit";
    // Held a long time but only broke even on fees → closed because yield was too low
    if (hours > 72 && pct >= -2 && pct <= 2 && fees < 0.5) return "low_yield";
    // Long hold with small loss and modest fees → also likely yield-driven exit
    if (hours > 96 && pct < 0 && pct > -5 && fees < 1) return "low_yield";
  }

  // Large directional moves beyond a plausible manual range → out of range
  if (pct >= 15) return "oor_above";
  if (pct <= -15) return "oor_below";

  // Moderate losses in volatile low-organic pools → OOR likely
  if (pct < -5 && vol > 4 && organic < 50) return "oor";

  // Fee yield wasn't compensating for a small loss / flat result
  if (pct < 0 && fees > 0 && fees < Math.abs(pct) * 0.5) return "low_yield";

  // Strong fee income that didn't fully offset IL but kept loss small → low_yield
  if (pct >= -3 && pct < 0 && fees >= Math.abs(pct)) return "low_yield";

  // Trailing take-profit heuristic: solid profit but not extreme, with some duration
  if (pct >= 5 && pct < 15 && validHours && hours > 6) return "trailing_tp";

  // Default to take_profit / stop_loss by sign
  if (pnl > 0 || pct > 0) return "take_profit";
  if (pnl < 0 || pct < 0) return "stop_loss";
  return "unknown";
}

function buildPerformanceEntry(p, snap, ss, wallet) {
  const pnlUsd = Number(p.pnl_usd) || 0;
  const capital = Number(p.capital_usd) || 0;
  const finalValue = capital + pnlUsd;
  const closeReason = estimateCloseReason({
    pnlUsd,
    pnlPct: p.pnl_pct,
    durationHours: p.duration_hours,
    feeYield: p.fee_yield,
    volatility: ss.volatility ?? snap?.token_volatility_24h ?? null,
    organicScore: ss.organic_score ?? snap?.base_organic_score ?? null,
  });
  return {
    position: p.id,
    pool: p.pool_address,
    pool_name: p.token_pair || "UNKNOWN",
    base_mint: snap?.base_mint || null,
    strategy: wallet?.preferred_strategy || "spot",
    bin_range: buildBinRange(p),
    bin_step: p.bin_step,
    entry_price: p.entry_price ?? snap?.token_price ?? null,
    volatility: ss.volatility ?? snap?.token_volatility_24h ?? null,
    fee_tvl_ratio: ss.fee_tvl_ratio ?? snap?.fee_tvl_ratio ?? null,
    organic_score: ss.organic_score ?? snap?.base_organic_score ?? null,
    amount_sol: capital > 0 && snap?.sol_price_usd ? capital / snap.sol_price_usd : null,
    fees_earned_usd: p.fees_earned_usd,
    fees_earned_sol: capital > 0 && snap?.sol_price_usd && p.fees_earned_usd != null
      ? p.fees_earned_usd / snap.sol_price_usd
      : null,
    final_value_usd: finalValue,
    initial_value_usd: capital,
    minutes_in_range: null,        // Scout doesn't track this
    range_efficiency: null,        // derived from minutes_in_range when available
    minutes_held: p.duration_hours != null ? p.duration_hours * 60 : null,
    close_reason: closeReason,
    signal_snapshot: ss,
    deployed_at: p.entry_timestamp ? new Date(p.entry_timestamp * 1000).toISOString() : null,
    closed_at: p.exit_timestamp ? new Date(p.exit_timestamp * 1000).toISOString() : null,
    recorded_at: p.exit_timestamp ? new Date(p.exit_timestamp * 1000).toISOString() : new Date().toISOString(),
    pnl_usd: Math.round(pnlUsd * 100) / 100,
    pnl_pct: Number(p.pnl_pct) || 0,
    fee_yield: Number(p.fee_yield) || 0,
    duration_hours: p.duration_hours,
    wallet_address: p.wallet_address,
    wallet_score: wallet?.score ?? null,
    wallet_win_rate: wallet?.win_rate ?? null,
    entry_mcap: ss.entry_mcap ?? snap?.base_mcap ?? null,
    entry_tvl: ss.entry_tvl ?? snap?.tvl ?? null,
    entry_volume: ss.entry_volume ?? snap?.volume_24h ?? null,
    entry_holders: ss.entry_holders ?? snap?.base_holders ?? null,
    momentum_score: ss.momentum_score ?? snap?.momentum_score ?? null,
    price_change_pct: ss.price_change_pct ?? snap?.token_price_change_24h ?? null,
    volume_change_pct: ss.volume_change_pct ?? snap?.volume_change_pct ?? null,
    exit_mcap: null,
    exit_tvl: null,
    exit_volume: null,
  };
}

/**
 * Build a Laminar-shaped bin_range object from Scout position data.
 * Laminar expects { min, max, bins_below, bins_above } for context formatting.
 */
function buildBinRange(p) {
  const width = Number(p.bin_range_width);
  const lower = Number(p.bin_lower);
  const upper = Number(p.upper_bin_id ?? p.bin_upper);
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    return {
      min: lower,
      max: upper,
      bins_below: Math.abs(upper - lower),
      bins_above: 0,
    };
  }
  if (Number.isFinite(width) && Number.isFinite(lower)) {
    return {
      min: lower,
      max: lower + width,
      bins_below: Math.abs(width),
      bins_above: 0,
    };
  }
  if (Number.isFinite(width)) {
    return {
      min: -Math.abs(width),
      max: 0,
      bins_below: Math.abs(width),
      bins_above: 0,
    };
  }
  return { min: null, max: null, bins_below: null, bins_above: null };
}

function inferStrategyFromPosition(perf) {
  // Prefer wallet preferred strategy, then infer from bin range width.
  if (perf.strategy && perf.strategy !== "unknown" && perf.strategy !== "spot") {
    return perf.strategy;
  }
  const width = Number(perf.bin_range?.bins_below);
  if (Number.isFinite(width)) {
    if (width <= 10) return "curve";
    if (width >= 60) return "bid_ask";
  }
  const rangeWidthPct = perf.entry_tvl > 0 && perf.entry_price
    ? Math.abs(perf.bin_range?.max - perf.bin_range?.min) / perf.entry_price
    : null;
  if (rangeWidthPct != null) {
    if (rangeWidthPct < 0.05) return "curve";
    if (rangeWidthPct > 0.30) return "bid_ask";
  }
  return "spot";
}

function buildLesson(perf) {
  const pnlPct = Number(perf.pnl_pct) || 0;
  const outcome = perf.pnl_pct >= 5 ? "good" : perf.pnl_pct >= 0 ? "neutral" : "bad";
  if (outcome === "neutral") return null;

  const strategy = inferStrategyFromPosition(perf);
  const binRange = perf.bin_range;
  const binRangeStr = binRange && (binRange.min != null || binRange.max != null)
    ? `${Number(binRange.min ?? 0).toFixed(4)}-${Number(binRange.max ?? 0).toFixed(4)} (${binRange.bins_below ?? "?"} bins)`
    : String(binRange ?? "?");

  const ss = perf.signal_snapshot || {};
  const contextParts = [
    `${perf.pool_name}`,
    `strategy=${strategy}`,
    `bin_step=${perf.bin_step ?? "?"}`,
    `volatility=${perf.volatility ?? "?"}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio ?? "?"}`,
    `organic=${perf.organic_score ?? "?"}`,
    `bin_range=${binRangeStr}`,
  ];
  if (perf.entry_mcap != null || perf.entry_tvl != null || perf.entry_volume != null) {
    contextParts.push(`entry(mcap=${fmtNum(perf.entry_mcap)}, tvl=${fmtNum(perf.entry_tvl)}, vol=${fmtNum(perf.entry_volume)})`);
  }
  const context = contextParts.join(", ");

  // Laminar-shaped rule text (matches lessons.js derivLesson format closely)
  const reasonText = perf.close_reason || "unknown";
  let rule;
  if (outcome === "good") {
    rule = `WORKED: ${context} → PnL +${pnlPct.toFixed(2)}%.`;
  } else {
    rule = `FAILED: ${context} → PnL ${pnlPct.toFixed(2)}%. Reason: ${reasonText}.`;
  }

  // Tag matching ROLE_TAGS in lessons.js so they're filterable per agent role
  const tags = [outcome === "good" ? "worked" : "failed", "scout_top_wallet", "scout_position"];

  return {
    id: `${perf.position}_${now()}`,
    rule,
    tags,
    outcome,
    sourceType: "scout_performance",
    confidence: outcome === "good" ? 0.75 : 0.65,
    context,
    pnl_pct: perf.pnl_pct,
    pnl_usd: perf.pnl_usd,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency ?? null, // Scout doesn't track true OOR duration
    minutes_held: perf.minutes_held,
    close_reason: perf.close_reason,
    strategy: inferStrategyFromPosition(perf),
    bin_step: perf.bin_step ?? null,
    bin_range: perf.bin_range,
    pool: perf.pool,
    pool_name: perf.pool_name,
    entry_mcap: perf.entry_mcap,
    entry_tvl: perf.entry_tvl,
    entry_volume: perf.entry_volume,
    exit_mcap: perf.exit_mcap,
    exit_tvl: perf.exit_tvl,
    exit_volume: perf.exit_volume,
    wallet_address: perf.wallet_address,
    signal_snapshot: ss,
    created_at: perf.recorded_at,
  };
}

function buildMessageExample(perf) {
  const ss = perf.signal_snapshot || {};
  const outcome = Number(perf.pnl_usd) > 0 ? "DEPLOY" : "SKIP";
  const reasoning = Number(perf.pnl_usd) > 0
    ? `Top wallet ${perf.wallet_address?.slice(0, 8)}… entered ${perf.pool_name}. Signal snapshot shows strong predictors: fee_tvl_ratio=${fmtNum(ss.fee_tvl_ratio)}, organic=${fmtNum(ss.organic_score)}, volatility=${fmtNum(ss.volatility)}. Result: PnL +$${perf.pnl_usd?.toFixed?.(2)}.`
    : `Top wallet ${perf.wallet_address?.slice(0, 8)}… entered ${perf.pool_name} but outcome was negative: PnL $${perf.pnl_usd?.toFixed?.(2)}. Avoid similar conditions.`;

  return {
    messages: [
      {
        role: "system",
        content: "You are an autonomous DLMM LP agent on Meteora, Solana. Decide whether to DEPLOY or SKIP a pool based on the signal snapshot and top-wallet context. Output only DEPLOY or SKIP followed by a short reasoning.",
      },
      {
        role: "user",
        content: JSON.stringify({
          pool: perf.pool,
          pool_name: perf.pool_name,
          wallet_score: perf.wallet_score,
          wallet_win_rate: perf.wallet_win_rate,
          signal_snapshot: ss,
          entry_mcap: perf.entry_mcap,
          entry_tvl: perf.entry_tvl,
          entry_volume: perf.entry_volume,
        }),
      },
      {
        role: "assistant",
        content: `${outcome}\n${reasoning}`,
      },
    ],
  };
}

// ─── Darwinian Signal Weights ─────────────────────────────────────

function extractNumeric(snapshot, signal) {
  const v = snapshot?.[signal];
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function computeNumericLift(signal, wins, losses) {
  const winVals = wins.map((s) => extractNumeric(s, signal)).filter((v) => v != null);
  const lossVals = losses.map((s) => extractNumeric(s, signal)).filter((v) => v != null);
  if (winVals.length === 0 || lossVals.length === 0) return null;
  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) return 0;
  const normalize = (v) => (v - min) / range;
  const winMean = winVals.reduce((s, v) => s + normalize(v), 0) / winVals.length;
  const lossMean = lossVals.reduce((s, v) => s + normalize(v), 0) / lossVals.length;
  return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
}

function computeBooleanLift(signal, wins, losses) {
  const all = [...wins.map((w) => ({ w: true, s: w })), ...losses.map((l) => ({ w: false, s: l }))];
  let trueWins = 0, trueTotal = 0, falseWins = 0, falseTotal = 0;
  for (const { w, s } of all) {
    const v = s.signal_snapshot?.[signal];
    if (v === undefined || v === null) continue;
    if (v) { trueTotal++; if (w) trueWins++; }
    else  { falseTotal++; if (w) falseWins++; }
  }
  if (trueTotal === 0 || falseTotal === 0) return null;
  return (trueWins / trueTotal) - (falseWins / falseTotal);
}

function computeCategoricalLift(signal, wins, losses) {
  const all = [...wins.map((w) => ({ w: true, s: w })), ...losses.map((l) => ({ w: false, s: l }))];
  const buckets = {};
  for (const { w, s } of all) {
    const v = s.signal_snapshot?.[signal];
    if (v === undefined || v === null) continue;
    if (!buckets[v]) buckets[v] = { wins: 0, total: 0 };
    buckets[v].total++;
    if (w) buckets[v].wins++;
  }
  const rates = Object.values(buckets).filter((b) => b.total >= 2).map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

function computeLift(signal, wins, losses) {
  if (signal === "smart_wallets_present") return computeBooleanLift(signal, wins, losses);
  if (signal === "narrative_quality") return computeCategoricalLift(signal, wins, losses);
  return computeNumericLift(signal, wins, losses);
}

function recalculateWeightsFromPerformance(performance) {
  const cfg = { darwin: { ...DARWIN_DEFAULTS, ...(config.signalWeights || {}) } };
  const cutoffMs = Date.now() - cfg.darwin.windowDays * 86400 * 1000;
  const recent = performance.filter((p) => p.recorded_at && new Date(p.recorded_at).getTime() >= cutoffMs);
  if (recent.length < cfg.darwin.minSamples) {
    return {
      weights: Object.fromEntries(LAMINAR_SIGNAL_NAMES.map((s) => [s, 1.0])),
      history: [],
      last_recalc: new Date().toISOString(),
      recalc_count: 0,
      window_size: recent.length,
      wins: 0,
      losses: 0,
      changes: [],
      reason: `only ${recent.length} records in ${cfg.darwin.windowDays}d window (need ${cfg.darwin.minSamples}), skipped`,
    };
  }

  const wins = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) <= 0);
  if (wins.length === 0 || losses.length === 0) {
    return {
      weights: Object.fromEntries(LAMINAR_SIGNAL_NAMES.map((s) => [s, 1.0])),
      history: [],
      last_recalc: new Date().toISOString(),
      recalc_count: 0,
      window_size: recent.length,
      wins: wins.length,
      losses: losses.length,
      changes: [],
      reason: "no wins or losses; using defaults",
    };
  }

  const weights = Object.fromEntries(LAMINAR_SIGNAL_NAMES.map((s) => [s, 1.0]));
  const lifts = {};
  for (const signal of LAMINAR_SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses);
    if (lift !== null && Number.isFinite(lift)) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) {
    return {
      weights,
      history: [],
      last_recalc: new Date().toISOString(),
      recalc_count: 0,
      window_size: recent.length,
      wins: wins.length,
      losses: losses.length,
      changes: [],
      reason: "no signals had enough samples; using defaults",
    };
  }

  const q1End = Math.ceil(ranked.length * 0.25);
  const q3Start = Math.floor(ranked.length * 0.75);
  const topQ = new Set(ranked.slice(0, q1End).map(([n]) => n));
  const bottomQ = new Set(ranked.slice(q3Start).map(([n]) => n));

  const changes = [];
  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;
    if (topQ.has(signal))      next = Math.min(prev * cfg.darwin.boostFactor, cfg.darwin.weightCeiling);
    else if (bottomQ.has(signal)) next = Math.max(prev * cfg.darwin.decayFactor, cfg.darwin.weightFloor);
    next = Math.round(next * 1000) / 1000;
    if (next !== prev) {
      changes.push({
        signal,
        from: prev,
        to: next,
        lift: Math.round(lift * 1000) / 1000,
        action: next > prev ? "boosted" : "decayed",
      });
      weights[signal] = next;
    }
  }

  const history = [{
    timestamp: new Date().toISOString(),
    changes,
    window_size: recent.length,
    win_count: wins.length,
    loss_count: losses.length,
  }];

  return {
    weights,
    history,
    last_recalc: new Date().toISOString(),
    recalc_count: 1,
    window_size: recent.length,
    wins: wins.length,
    losses: losses.length,
    changes,
    reason: `recalculated from ${recent.length} scout records`,
  };
}

// ─── Pool Memory ──────────────────────────────────────────────────

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").toLowerCase();
  return text.includes("out of range") || text.includes("pumped far above range") || text === "oor" || text.includes("oor");
}

function buildPoolMemory(performance) {
  const byPool = new Map();
  for (const perf of performance) {
    if (!byPool.has(perf.pool)) {
      byPool.set(perf.pool, {
        name: perf.pool_name || perf.pool.slice(0, 8),
        base_mint: perf.base_mint || null,
        deploys: [],
        total_deploys: 0,
        avg_pnl_pct: 0,
        win_rate: 0,
        adjusted_win_rate: 0,
        adjusted_win_rate_sample_count: 0,
        last_deployed_at: null,
        last_outcome: null,
        notes: [],
      });
    }
    const entry = byPool.get(perf.pool);
    const deploy = {
      deployed_at: perf.deployed_at,
      closed_at: perf.closed_at,
      pnl_pct: perf.pnl_pct,
      pnl_usd: perf.pnl_usd,
      fees_earned_usd: perf.fees_earned_usd,
      fee_earned_pct: perf.initial_value_usd > 0 ? (perf.fees_earned_usd / perf.initial_value_usd) * 100 : null,
      range_efficiency: perf.range_efficiency, // null for Scout-derived
      minutes_held: perf.minutes_held,
      close_reason: perf.close_reason,
      close_reason_category: normalizeCloseReason(perf.close_reason),
      strategy: perf.strategy,
      volatility_at_deploy: perf.volatility,
      entry_mcap: perf.entry_mcap,
      entry_tvl: perf.entry_tvl,
      entry_volume: perf.entry_volume,
      entry_holders: perf.entry_holders ?? null,
      momentum_score: perf.momentum_score ?? null,
      price_change_pct: perf.price_change_pct ?? null,
      volume_change_pct: perf.volume_change_pct ?? null,
      bin_step: perf.bin_step,
      organic_score: perf.organic_score,
      fee_tvl_ratio: perf.fee_tvl_ratio,
      wallet_address: perf.wallet_address,
    };
    entry.deploys.push(deploy);
  }

  const result = {};
  for (const [pool, entry] of byPool.entries()) {
    entry.total_deploys = entry.deploys.length;
    const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
    if (withPnl.length > 0) {
      entry.avg_pnl_pct = Math.round(
        (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100,
      ) / 100;
      entry.win_rate = Math.round(
        (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100,
      ) / 100;
    }
    const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
    entry.adjusted_win_rate_sample_count = adjusted.length;
    entry.adjusted_win_rate = adjusted.length > 0
      ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
      : 0;
    entry.last_deployed_at = entry.deploys[entry.deploys.length - 1]?.closed_at || null;
    entry.last_outcome = (withPnl[withPnl.length - 1]?.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
    result[pool] = entry;
  }
  return result;
}

// ─── Decision Traces ───────────────────────────────────────────────

async function writeJsonArray(filePath, key, items, meta) {
  const stream = fs.createWriteStream(filePath);
  stream.write(`{\n  "_meta": ${JSON.stringify(meta, null, 2).replace(/\n/g, "\n  ")},\n  "${key}": [\n`);
  for (let i = 0; i < items.length; i++) {
    const line = i === items.length - 1 ? JSON.stringify(items[i]) : `${JSON.stringify(items[i])},`;
    stream.write("    " + line + "\n");
  }
  stream.write("  ]\n}\n");
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end();
  });
}

function buildTuningSummary({ performance, lessons, weightsResult, poolMemory }) {
  const byOutcome = { good: [], bad: [] };
  for (const l of lessons) {
    if (l.outcome === "good") byOutcome.good.push(l);
    else if (l.outcome === "bad") byOutcome.bad.push(l);
  }

  const topGood = byOutcome.good
    .sort((a, b) => (b.pnl_pct || 0) - (a.pnl_pct || 0))
    .slice(0, 50)
    .map((l) => ({ rule: l.rule, tags: l.tags, pnl_pct: l.pnl_pct, pnl_usd: l.pnl_usd, close_reason: l.close_reason, strategy: l.strategy, pool_name: l.pool_name }));

  const topBad = byOutcome.bad
    .sort((a, b) => (a.pnl_pct || 0) - (b.pnl_pct || 0))
    .slice(0, 50)
    .map((l) => ({ rule: l.rule, tags: l.tags, pnl_pct: l.pnl_pct, pnl_usd: l.pnl_usd, close_reason: l.close_reason, strategy: l.strategy, pool_name: l.pool_name }));

  const strategyStats = {};
  for (const p of performance) {
    const s = p.strategy || "unknown";
    if (!strategyStats[s]) strategyStats[s] = { count: 0, wins: 0, total_pnl_pct: 0, total_pnl_usd: 0 };
    strategyStats[s].count++;
    if ((p.pnl_usd ?? 0) > 0) strategyStats[s].wins++;
    strategyStats[s].total_pnl_pct += p.pnl_pct || 0;
    strategyStats[s].total_pnl_usd += p.pnl_usd || 0;
  }
  for (const s of Object.keys(strategyStats)) {
    const st = strategyStats[s];
    st.win_rate = st.count > 0 ? Math.round((st.wins / st.count) * 10000) / 100 : 0;
    st.avg_pnl_pct = st.count > 0 ? Math.round((st.total_pnl_pct / st.count) * 100) / 100 : 0;
  }

  const poolSummaries = Object.entries(poolMemory)
    .map(([pool, m]) => ({
      pool,
      name: m.name,
      deploys: m.total_deploys,
      avg_pnl_pct: m.avg_pnl_pct,
      win_rate: m.win_rate,
      adjusted_win_rate: m.adjusted_win_rate,
      last_outcome: m.last_outcome,
    }))
    .sort((a, b) => b.win_rate - a.win_rate || b.avg_pnl_pct - a.avg_pnl_pct);

  const rankedSignals = Object.entries(weightsResult.weights)
    .map(([name, weight]) => ({ name, weight, lift: weightsResult.changes.find((c) => c.signal === name)?.lift || null }))
    .sort((a, b) => b.weight - a.weight);

  return {
    generated_at: new Date().toISOString(),
    source: "laminar-scout",
    dataset_size: { performance: performance.length, lessons: lessons.length, pools: Object.keys(poolMemory).length },
    darwinian_weights: {
      ranked_signals: rankedSignals,
      history: weightsResult.history,
      note: weightsResult.reason,
    },
    strategy_summary: strategyStats,
    top_worked_lessons: topGood,
    top_failed_lessons: topBad,
    top_pools: poolSummaries.slice(0, 50),
    worst_pools: poolSummaries.slice(-50).reverse(),
  };
}

function renderTuningPrompt(tuning) {
  const lines = [];
  lines.push("# Laminar/Vipera Tuning Brief (from Laminar Scout)");
  lines.push("");
  lines.push(`Generated: ${tuning.generated_at}`);
  lines.push(`Dataset: ${tuning.dataset_size.performance} positions, ${tuning.dataset_size.lessons} lessons, ${tuning.dataset_size.pools} pools.`);
  lines.push("");
  lines.push("## Darwinian Signal Weights (higher = stronger predictor)");
  for (const s of tuning.darwinian_weights.ranked_signals) {
    lines.push(`- ${s.name}: weight=${s.weight}${s.lift != null ? `, lift=${s.lift}` : ""}`);
  }
  lines.push("");
  lines.push("## Strategy Performance");
  for (const [strategy, st] of Object.entries(tuning.strategy_summary)) {
    lines.push(`- ${strategy}: win_rate=${st.win_rate}%, avg_pnl_pct=${st.avg_pnl_pct}%, count=${st.count}`);
  }
  lines.push("");
  lines.push("## Top Worked Lessons");
  for (const l of tuning.top_worked_lessons) lines.push(`- ${l.rule}`);
  lines.push("");
  lines.push("## Top Failed Lessons");
  for (const l of tuning.top_failed_lessons) lines.push(`- ${l.rule}`);
  lines.push("");
  lines.push("## Top Pools");
  for (const p of tuning.top_pools) {
    lines.push(`- ${p.name} (${p.pool.slice(0, 8)}…): WR=${p.win_rate}%, avg PnL=${p.avg_pnl_pct}%, deploys=${p.deploys}`);
  }
  lines.push("");
  lines.push("## Worst Pools");
  for (const p of tuning.worst_pools) {
    lines.push(`- ${p.name} (${p.pool.slice(0, 8)}…): WR=${p.win_rate}%, avg PnL=${p.avg_pnl_pct}%, deploys=${p.deploys}`);
  }
  lines.push("");
  lines.push("## Tuning Instructions");
  lines.push("Use this brief to adjust Laminar/Vipera decision thresholds, signal weights, and strategy preferences.");
  lines.push("The lessons are derived from historical top-wallet LP positions on Meteora DLMM.");
  lines.push("For full raw data, see laminar-performance.jsonl and laminar-messages.jsonl.");
  return lines.join("\n");
}

function buildDecisionTraces(performance, lessons) {
  const lessonByPosition = new Map();
  for (const lesson of lessons) {
    if (lesson.position) lessonByPosition.set(lesson.position, lesson);
  }

  return performance.map((perf) => {
    const ss = perf.signal_snapshot || {};
    const lesson = lessonByPosition.get(perf.position);

    // Reconstruct the "transcript" Laminar expects: tool calls / checks performed
    const transcript = [
      {
        tool: "get_pool_memory",
        success: true,
        result_summary: JSON.stringify({ pool_address: perf.pool, known: false, message: "Scout-derived trace — no prior Laminar memory." }),
      },
      {
        tool: "check_smart_wallets_on_pool",
        success: true,
        result_summary: JSON.stringify({
          pool: perf.pool,
          tracked_wallets: perf.wallet_score != null ? 1 : 0,
          in_pool: perf.wallet_address ? [perf.wallet_address] : [],
          confidence_boost: (perf.wallet_score ?? 0) >= 60,
          signal: perf.wallet_score != null
            ? `Top wallet present (score ${Math.round(perf.wallet_score)})`
            : "No tracked smart wallets — neutral signal",
        }),
      },
      {
        tool: "get_token_info",
        success: true,
        result_summary: JSON.stringify({
          found: true,
          query: perf.pool,
          results: [{
            mcap: perf.entry_mcap,
            tvl: perf.entry_tvl,
            volume_24h: perf.entry_volume,
            organic_score: perf.organic_score,
            volatility: perf.volatility,
            fee_tvl_ratio: perf.fee_tvl_ratio,
          }],
        }),
      },
      {
        tool: "screener_evaluate_pool",
        success: true,
        result_summary: JSON.stringify({
          pool: perf.pool,
          passed: perf.pnl_usd > 0,
          score: perf.wallet_score ?? null,
          confidence: ss.confidence ?? null,
          signal_snapshot: ss,
        }),
      },
    ];

    const decisionType = perf.pnl_usd > 0 ? "deploy" : "no_deploy";
    const finalContent = decisionType === "deploy"
      ? `DEPLOY ${perf.pool_name} — top wallet ${perf.wallet_address?.slice(0, 8)}… entered at fee/TVL ${fmtNum(perf.fee_tvl_ratio)}%, organic ${fmtNum(perf.organic_score)}. Outcome PnL ${perf.pnl_pct?.toFixed?.(2)}% (${perf.close_reason}).`
      : `NO DEPLOY ${perf.pool_name} — top wallet ${perf.wallet_address?.slice(0, 8)}… entry resulted in loss ${perf.pnl_pct?.toFixed?.(2)}% (${perf.close_reason}).`;

    return {
      id: `scout_trace_${perf.position}_${Date.now()}`,
      ts: perf.recorded_at || new Date().toISOString(),
      cycle: "screening",
      actor: "SCOUT_SCREENER",
      decision: {
        type: decisionType,
        summary: decisionType === "deploy" ? "Deployed (Scout-derived)" : "Did not deploy (Scout-derived)",
      },
      inputs: {
        candidates_considered: 1,
        filtered: [],
        candidate_pools: [perf.pool_name || perf.pool],
        signal_snapshot: ss,
        wallet_address: perf.wallet_address,
        wallet_score: perf.wallet_score,
        wallet_win_rate: perf.wallet_win_rate,
      },
      transcript,
      challenger: [],
      final_content_raw: finalContent,
      final_content: finalContent,
      error: null,
      // Scout-specific extensions (non-breaking for Laminar readers)
      _scout: {
        position: perf.position,
        lesson_id: lesson?.id || null,
        pnl_pct: perf.pnl_pct,
        pnl_usd: perf.pnl_usd,
        close_reason: perf.close_reason,
        duration_hours: perf.duration_hours,
      },
    };
  });
}

// ─── Main Export ──────────────────────────────────────────────────

export async function exportLaminarTrainingOutputs({ minPositions = 1 } = {}) {
  const db = getDb();
  const positions = db.prepare(`
    SELECT p.*, w.score AS wallet_score, w.win_rate AS wallet_win_rate, w.preferred_strategy
    FROM positions p
    LEFT JOIN wallets w ON w.address = p.wallet_address
    WHERE p.status = 'closed'
      AND p.pnl_usd IS NOT NULL
      AND p.capital_usd IS NOT NULL
      AND p.capital_usd > 0
    ORDER BY p.exit_timestamp DESC
  `).all();

  const performance = [];
  const lessons = [];
  const messages = [];

  for (const p of positions) {
    const snap = p.entry_timestamp ? getNearestSnapshot(p.pool_address, p.entry_timestamp) : null;
    const ss = parseSignalSnapshot(p.signal_snapshot);
    const wallet = { score: p.wallet_score, win_rate: p.wallet_win_rate, preferred_strategy: p.preferred_strategy };
    const perf = buildPerformanceEntry(p, snap, ss, wallet);
    performance.push(perf);

    const lesson = buildLesson(perf);
    if (lesson) lessons.push(lesson);

    messages.push(buildMessageExample(perf));
  }

  // 1. Lessons (all) — streamed to avoid RangeError on huge arrays.
  const lessonsPath = outFile("laminar-lessons.json");
  const lessonsMeta = { source: "laminar-scout", generated_at: new Date().toISOString(), count: lessons.length };
  await writeJsonArray(lessonsPath, "lessons", lessons, lessonsMeta);

  // 2. Performance (all) — JSONL to keep file readable line-by-line without giant string.
  const performancePath = outFile("laminar-performance.jsonl");
  fs.writeFileSync(performancePath, performance.map((p) => JSON.stringify(p)).join("\n") + "\n");

  // 3. Messages (OpenAI fine-tune)
  const messagesPath = outFile("laminar-messages.jsonl");
  fs.writeFileSync(messagesPath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

  // 4. Darwinian Signal Weights (Laminar signal-weights.json format)
  const weightsResult = recalculateWeightsFromPerformance(performance);
  const weightsPath = outFile("laminar-signal-weights.json");
  fs.writeFileSync(
    weightsPath,
    JSON.stringify(
      {
        weights: weightsResult.weights,
        last_recalc: weightsResult.last_recalc,
        recalc_count: weightsResult.recalc_count,
        history: weightsResult.history,
        _meta: {
          source: "laminar-scout",
          generated_at: new Date().toISOString(),
          window_days: DARWIN_DEFAULTS.windowDays,
          window_size: weightsResult.window_size,
          wins: weightsResult.wins,
          losses: weightsResult.losses,
          note: weightsResult.reason,
          limitation: "Computed from Scout-tracked top wallet positions only. For production Laminar, regenerate from own positions.",
        },
      },
      null,
      2,
    ),
  );

  // 5. Pool Memory (Laminar pool-memory.json format)
  const poolMemory = buildPoolMemory(performance);
  const poolMemoryPath = outFile("laminar-pool-memory.json");
  fs.writeFileSync(
    poolMemoryPath,
    JSON.stringify(
      { _meta: { source: "laminar-scout", generated_at: new Date().toISOString() }, ...poolMemory },
      null,
      2,
    ),
  );

  // 6. Decision Traces (Laminar decision-traces.jsonl format)
  const traces = buildDecisionTraces(performance, lessons);
  const tracesPath = outFile("laminar-decision-traces.jsonl");
  fs.writeFileSync(tracesPath, traces.map((t) => JSON.stringify(t)).join("\n") + "\n");

  // 7. Tuning summary — small, Claude-Code-friendly artifact
  const tuning = buildTuningSummary({ performance, lessons, weightsResult, poolMemory });
  const tuningJsonPath = outFile("laminar-tuning-summary.json");
  fs.writeFileSync(tuningJsonPath, JSON.stringify(tuning, null, 2));
  const tuningPromptPath = outFile("laminar-tuning-prompt.txt");
  fs.writeFileSync(tuningPromptPath, renderTuningPrompt(tuning));

  log(
    "laminar_export",
    `exported ${performance.length} perf / ${lessons.length} lessons / ${messages.length} messages / ${Object.keys(poolMemory).length} pools / ${weightsResult.changes.length} weight changes / ${traces.length} traces / tuning summary`,
  );
  return {
    performanceCount: performance.length,
    lessonCount: lessons.length,
    messageCount: messages.length,
    poolMemoryCount: Object.keys(poolMemory).length,
    weightsChanges: weightsResult.changes.length,
    tracesCount: traces.length,
    weightsReason: weightsResult.reason,
    lessonsPath,
    performancePath,
    messagesPath,
    weightsPath,
    poolMemoryPath,
    tracesPath,
    tuningJsonPath,
    tuningPromptPath,
  };
}
