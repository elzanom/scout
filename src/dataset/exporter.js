import fs from "fs";
import path from "path";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { COLUMNS } from "./record-builder.js";
import { SNAPSHOT_COLUMNS } from "../db/market-snapshots.js";

// CSV column order: record LABEL + wallet/position features, then entry-snapshot metrics
// (`snap_`) and token-info security/metadata (`ti_`). Both JOINs deliver the rich vectors.
const RECORD_COLS = COLUMNS.filter((c) => c !== "entry_snapshot_id"); // drop the FK from output
const SNAP_COLS = SNAPSHOT_COLUMNS.filter((c) => c !== "id").map((c) => "snap_" + c);
const TI_COLS_RAW = [
  "symbol", "launchpad", "graduated", "graduated_at", "holder_count", "organic_score",
  "is_verified", "created_at", "fdv", "mcap", "circ_supply", "total_supply",
  "bundler_rate", "is_honeypot", "rug_ratio", "top10_holder_rate", "renounced_mint", "renounced_freeze",
  "creator_holding_pct",
];
const TI_COLS = TI_COLS_RAW.map((c) => "ti_" + c);
const ALL_COLS = [...RECORD_COLS, ...SNAP_COLS, ...TI_COLS];
const RECORD_SEL = RECORD_COLS.map((c) => `tr.${c} AS ${c}`).join(", ");
const SNAP_SEL = SNAPSHOT_COLUMNS.filter((c) => c !== "id").map((c) => `ms.${c} AS snap_${c}`).join(", ");
const TI_SEL = TI_COLS_RAW.map((c) => `ti.${c} AS ti_${c}`).join(", ");
const JOIN_SQL = `SELECT ${RECORD_SEL}, ${SNAP_SEL}, ${TI_SEL}
  FROM training_records tr
  LEFT JOIN market_snapshots ms ON tr.entry_snapshot_id = ms.id
  LEFT JOIN token_info ti ON ms.base_mint = ti.mint
  ORDER BY tr.created_at`;

/**
 * Export all training records to CSV (default) or JSON. Each row = position outcome (LABEL) +
 * wallet/position features + the full entry-time market-snapshot feature vector (~50 metrics).
 * @param {{ format?: "csv"|"json", path?: string }} opts
 * @returns {{ count: number, columns: number, path: string, format: string }}
 */
export function exportDataset({ format, path: outPath } = {}) {
  const records = getDb().prepare(JOIN_SQL).all();
  const target = outPath || config.dataset.exportPath;
  const dir = path.dirname(target);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fmt = (format || (target.endsWith(".json") ? "json" : "csv")).toLowerCase();

  if (fmt === "json") {
    fs.writeFileSync(target, JSON.stringify(records, null, 2));
  } else {
    const escape = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ALL_COLS.join(",");
    const lines = records.map((r) => ALL_COLS.map((c) => escape(r[c])).join(","));
    fs.writeFileSync(target, [header, ...lines].join("\n") + "\n");
  }

  log("dataset", `exported ${records.length} record(s) × ${ALL_COLS.length} cols → ${target} (${fmt})`);
  return { count: records.length, columns: ALL_COLS.length, path: target, format: fmt };
}

/** Count training records (quick census). */
export function trainingRecordCount() {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM training_records`).get().c;
}

/** How many training records have a linked entry snapshot (rich features available). */
export function recordsWithSnapshot() {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM training_records WHERE entry_snapshot_id IS NOT NULL`).get().c;
}
