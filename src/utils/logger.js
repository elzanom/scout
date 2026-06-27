import fs from "fs";
import path from "path";
import { repoPath } from "../../repo-root.js";

let broadcastLog = null;
export function setLogBroadcaster(fn) { broadcastLog = fn; }

const LOG_DIR = repoPath("logs");
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function. Level is auto-derived from the category name:
 * a category containing "error" → error, "warn" → warn, otherwise info.
 *
 * @example log("screening", "Found 12 candidates")
 *          log("api_error", "top-lp 429")   // → error level
 */
export function log(category, message) {
  const level = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // WebSocket broadcast (best-effort, throttled)
  if (broadcastLog && level !== "debug") {
    try { broadcastLog({ timestamp, level, message }); } catch {}
  }

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `scout-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

/** Compact human-readable hint appended to a tool action's console line. */
function actionHint(action) {
  const a = action.args || {};
  const r = action.result || {};
  switch (action.tool) {
    case "discover_pools":   return ` ${r?.pools ?? r?.total ?? ""} pools`;
    case "study_top_lpers":  return ` ${a.pool_address?.slice(0, 8) ?? ""} → ${r?.lpers?.length ?? ""} lpers`;
    case "backfill_wallet":  return ` ${a.wallet?.slice(0, 8) ?? ""} (${a.days ?? ""}d)`;
    case "screen_pool":      return ` ${a.pool_address?.slice(0, 8) ?? ""}`;
    case "evaluate_wallet":  return ` ${a.wallet?.slice(0, 8) ?? ""} → ${r?.status ?? ""} score=${r?.score ?? ""}`;
    case "emit_signal":      return ` ${r?.pool?.slice(0, 8) ?? ""} conf=${r?.confidence ?? ""}`;
    case "build_record":     return ` ${a.position_id?.slice(0, 8) ?? ""}`;
    default:                 return "";
  }
}

/**
 * Log a tool action with full details (audit trail).
 * @param {{ tool: string, success: boolean, duration_ms?: number, args?: object, result?: object }} action
 */
export function logAction(action) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}

/**
 * Log a snapshot (system / collection state over time).
 * @param {object} snapshot
 */
export function logSnapshot(snapshot) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, ...snapshot };

  const dateStr = timestamp.split("T")[0];
  const snapshotFile = path.join(LOG_DIR, `snapshots-${dateStr}.jsonl`);
  fs.appendFileSync(snapshotFile, JSON.stringify(entry) + "\n");
}
