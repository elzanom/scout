import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { getNearestSnapshot } from "../db/market-snapshots.js";
import { getAndClearStagedSignals } from "../signals/stage-signals.js";

/**
 * Training-record columns: identifiers + LABEL (outcome) + wallet/position FEATURES + an
 * `entry_snapshot_id` link. The rich market-context FEATURES come from the JOINed entry
 * snapshot at export time (dataset/exporter.js) — so every new snapshot metric auto-becomes a
 * training feature without changing this record.
 */
const DARWINIAN_SIGNALS = [
  "organic_score", "fee_tvl_ratio", "volume", "mcap", "holder_count",
  "smart_wallets_present", "narrative_quality", "study_win_rate", "hive_consensus",
  "volatility", "entry_mcap", "entry_tvl", "entry_volume",
];

const COLUMNS = [
  "position_id", "wallet_address", "pool_address",
  // LABEL (what Laminar learns)
  "was_profitable", "pnl_usd", "pnl_pct", "fee_earned_usd", "fee_yield", "duration_hours",
  // FEATURES: wallet + position (market context joined via entry_snapshot_id)
  "pool_bin_step", "token_pair", "bin_range_width", "capital_usd",
  "wallet_score_at_entry", "wallet_wr_at_entry", "hour_of_day", "day_of_week",
  "wallet_discovery_source", "wallet_preferred_strategy", "wallet_preferred_range_style",
  // link to the entry-time market snapshot (rich feature vector joined at export)
  "entry_snapshot_id",
  // Darwinian signal snapshot staged at screening time (flattened + JSON)
  ...DARWINIAN_SIGNALS.map((s) => `sig_${s}`),
  "signal_snapshot",
];

/**
 * Build + persist a training record for a CLOSED position (SPEC §8). Idempotent by position_id.
 * Links the nearest market snapshot at entry_timestamp so the exporter can emit the full
 * market-context feature vector. Returns the record or null.
 */
export function buildRecord(positionId) {
  const pos = getDb().prepare(`SELECT * FROM positions WHERE id = ?`).get(positionId);
  if (!pos) { log("dataset_warn", `position ${positionId} not found`); return null; }
  if (pos.status !== "closed") { log("dataset_warn", `position ${positionId} not closed (status=${pos.status})`); return null; }
  if (getDb().prepare(`SELECT 1 FROM training_records WHERE position_id = ?`).get(positionId)) {
    return getDb().prepare(`SELECT * FROM training_records WHERE position_id = ?`).get(positionId);
  }

  const wallet = getDb().prepare(`SELECT score, win_rate, source, preferred_strategy, preferred_range_style FROM wallets WHERE address = ?`).get(pos.wallet_address) || {};
  const snap = pos.entry_timestamp ? getNearestSnapshot(pos.pool_address, pos.entry_timestamp) : null;
  const entryDate = pos.entry_timestamp ? new Date(pos.entry_timestamp * 1000) : null;
  const stagedSignals = getAndClearStagedSignals(pos.pool_address, snap?.base_mint) || {};

  const record = {
    position_id: pos.id,
    wallet_address: pos.wallet_address,
    pool_address: pos.pool_address,
    was_profitable: pos.is_profitable,
    pnl_usd: pos.pnl_usd,
    pnl_pct: pos.pnl_pct,
    fee_earned_usd: pos.fees_earned_usd,
    fee_yield: pos.fee_yield,
    duration_hours: pos.duration_hours,
    pool_bin_step: pos.bin_step,
    token_pair: pos.token_pair,
    bin_range_width: pos.bin_range_width,
    capital_usd: pos.capital_usd,
    wallet_score_at_entry: wallet.score ?? null,
    wallet_wr_at_entry: wallet.win_rate ?? null,
    hour_of_day: entryDate ? entryDate.getUTCHours() : null,
    day_of_week: entryDate ? entryDate.getUTCDay() : null,
    wallet_discovery_source: wallet.source ?? null,
    wallet_preferred_strategy: wallet.preferred_strategy ?? null,
    wallet_preferred_range_style: wallet.preferred_range_style ?? null,
    entry_snapshot_id: snap?.id ?? null,
    signal_snapshot: JSON.stringify(stagedSignals),
  };

  // Flatten Darwinian signals into prefixed columns for easy SQL/CSV analysis.
  for (const s of DARWINIAN_SIGNALS) {
    let v = stagedSignals[s];
    if (s === "smart_wallets_present") v = v ? 1 : (v === false ? 0 : null);
    record[`sig_${s}`] = v ?? null;
  }

  const placeholders = COLUMNS.map(() => "?").join(", ");
  getDb().prepare(`INSERT INTO training_records (${COLUMNS.join(", ")}) VALUES (${placeholders})`)
    .run(...COLUMNS.map((c) => record[c]));
  return record;
}

export { COLUMNS };
