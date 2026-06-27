import { getDb } from "../db/index.js";
import { log } from "../utils/logger.js";

const SIGNAL_NAMES = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "volatility",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 1.0]));

const HIGHER_IS_BETTER = new Set([
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "holder_count",
  "study_win_rate",
]);

const BOOLEAN_SIGNALS = new Set(["smart_wallets_present"]);
const CATEGORICAL_SIGNALS = new Set(["narrative_quality"]);

export function ensureWeights() {
  const db = getDb();
  for (const name of SIGNAL_NAMES) {
    db.prepare("INSERT OR IGNORE INTO signal_weights (signal, weight, updated_at) VALUES (?, 1.0, ?)").run(name, Math.floor(Date.now() / 1000));
  }
}

export function loadWeights() {
  ensureWeights();
  const rows = getDb().prepare("SELECT signal, weight FROM signal_weights").all();
  const weights = { ...DEFAULT_WEIGHTS };
  for (const r of rows) weights[r.signal] = r.weight;
  return weights;
}

export function saveWeights(weights) {
  const db = getDb();
  const ts = Math.floor(Date.now() / 1000);
  const stmt = db.prepare("UPDATE signal_weights SET weight = ?, updated_at = ? WHERE signal = ?");
  for (const [signal, weight] of Object.entries(weights)) {
    if (SIGNAL_NAMES.includes(signal)) stmt.run(weight, ts, signal);
  }
}

export function getWeightsSummary() {
  const weights = loadWeights();
  const sorted = SIGNAL_NAMES.filter((s) => weights[s] != null).sort((a, b) => weights[b] - weights[a]);
  const lines = ["Darwinian signal weights:"];
  for (const s of sorted) {
    const w = weights[s];
    const bar = weightBar(w);
    lines.push(`${s.padEnd(22)} ${w.toFixed(2)} ${bar} ${interpretWeight(w)}`);
  }
  return lines.join("\n");
}

function interpretWeight(val) {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(val) {
  const filled = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}

export function recalculateWeights(cfg = {}) {
  const windowDays = cfg.windowDays ?? 60;
  const minSamples = cfg.minSamples ?? 10;
  const boostFactor = cfg.boostFactor ?? 1.05;
  const decayFactor = cfg.decayFactor ?? 0.95;
  const weightFloor = cfg.weightFloor ?? 0.3;
  const weightCeiling = cfg.weightCeiling ?? 2.5;

  ensureWeights();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;

  const rows = db.prepare(`
    SELECT pnl_usd, signal_snapshot
    FROM training_records
    WHERE signal_snapshot IS NOT NULL AND signal_snapshot != '{}' AND created_at >= ?
  `).all(cutoff);

  if (rows.length < minSamples) {
    log("signal_weights", `Only ${rows.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights: loadWeights() };
  }

  const wins = rows.filter((r) => (r.pnl_usd ?? 0) > 0);
  const losses = rows.filter((r) => (r.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}), skipping`);
    return { changes: [], weights: loadWeights() };
  }

  const lifts = {};
  for (const signal of SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses, minSamples);
    if (lift !== null) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights: loadWeights() };
  }

  const q1End = Math.ceil(ranked.length * 0.25);
  const q3Start = Math.floor(ranked.length * 0.75);
  const topQuartile = new Set(ranked.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(ranked.slice(q3Start).map(([name]) => name));

  const weights = loadWeights();
  const changes = [];

  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;
    if (topQuartile.has(signal)) next = Math.min(prev * boostFactor, weightCeiling);
    else if (bottomQuartile.has(signal)) next = Math.max(prev * decayFactor, weightFloor);
    next = Math.round(next * 1000) / 1000;
    if (next !== prev) {
      const dir = next > prev ? "boosted" : "decayed";
      changes.push({ signal, from: prev, to: next, lift: Math.round(lift * 1000) / 1000, action: dir });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)})`);
    }
  }

  saveWeights(weights);
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO signal_weight_history (recalculated_at, window_size, win_count, loss_count, changes)
    VALUES (?, ?, ?, ?, ?)
  `).run(ts, rows.length, wins.length, losses.length, JSON.stringify(changes));

  log("signal_weights", changes.length > 0
    ? `Recalculated: ${changes.length} weight(s) adjusted from ${rows.length} records`
    : `Recalculated: no changes needed (${rows.length} records, ${ranked.length} signals evaluated)`);

  return { changes, weights };
}

function computeLift(signal, wins, losses, minSamples) {
  if (BOOLEAN_SIGNALS.has(signal)) return computeBooleanLift(signal, wins, losses, minSamples);
  if (CATEGORICAL_SIGNALS.has(signal)) return computeCategoricalLift(signal, wins, losses, minSamples);
  return computeNumericLift(signal, wins, losses, minSamples);
}

function parseSnapshots(rows) {
  return rows.map((r) => {
    try { return JSON.parse(r.signal_snapshot || "{}"); } catch { return {}; }
  });
}

function computeNumericLift(signal, wins, losses, minSamples) {
  const winSnaps = parseSnapshots(wins);
  const lossSnaps = parseSnapshots(losses);
  const winVals = extractNumeric(signal, winSnaps);
  const lossVals = extractNumeric(signal, lossSnaps);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) return 0;

  const normalize = (v) => (v - min) / range;
  const winMean = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));
  return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
}

function computeBooleanLift(signal, wins, losses, minSamples) {
  const entries = [
    ...parseSnapshots(wins).map((s) => ({ w: true, snap: s })),
    ...parseSnapshots(losses).map((s) => ({ w: false, snap: s })),
  ];
  let trueWins = 0, trueTotal = 0, falseWins = 0, falseTotal = 0;
  for (const { w, snap } of entries) {
    const val = snap[signal];
    if (val === undefined || val === null) continue;
    if (val) { trueTotal++; if (w) trueWins++; }
    else { falseTotal++; if (w) falseWins++; }
  }
  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;
  return (trueWins / trueTotal) - (falseWins / falseTotal);
}

function computeCategoricalLift(signal, wins, losses, minSamples) {
  const entries = [
    ...parseSnapshots(wins).map((s) => ({ w: true, snap: s })),
    ...parseSnapshots(losses).map((s) => ({ w: false, snap: s })),
  ];
  const buckets = {};
  for (const { w, snap } of entries) {
    const val = snap[signal];
    if (val === undefined || val === null) continue;
    if (!buckets[val]) buckets[val] = { wins: 0, total: 0 };
    buckets[val].total++;
    if (w) buckets[val].wins++;
  }
  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  if (totalSamples < minSamples) return null;
  const rates = Object.values(buckets).filter((b) => b.total >= 2).map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

function extractNumeric(signal, snapshots) {
  const vals = [];
  for (const snap of snapshots) {
    const v = snap[signal];
    if (v != null && typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  return vals;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
