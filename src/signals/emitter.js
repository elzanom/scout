import fs from "fs";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { broadcastSignal } from "../webui/ws-broadcaster.js";
import { notifySignal } from "../notifier/telegram.js";

const now = () => Math.floor(Date.now() / 1000);
const MAX_FILE_SIGNALS = 200; // cap signals-output.json size (keep most recent)

/**
 * Persist a validated signal to the signals table and emit it to the configured output
 * (file | rest | stdout). Returns the SPEC-format signal object.
 */
export async function emitSignal({ wallet, pool, confidence, reasons, suggested, poolMetrics }) {
  const ts = now();
  const tokenPair = pool.token_pair || (pool.base?.symbol && pool.quote?.symbol
    ? `${pool.base.symbol}/${pool.quote.symbol}`
    : pool.name || null);

  const info = getDb().prepare(
    `INSERT INTO signals (
       pool_address, token_pair, trigger_type, triggered_by,
       wallet_score, pool_score, combined_confidence, validation_reasons,
       suggested_bin_step, suggested_range_lower, suggested_range_upper,
       fee_apr, volume_24h, tvl, status, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'sent', ?)`,
  ).run(
    pool.pool, tokenPair, "wallet_entry", wallet.address,
    wallet.score, pool.pool_score, confidence, JSON.stringify(reasons),
    suggested.bin_step ?? null, suggested.range_lower ?? null, suggested.range_upper ?? null,
    poolMetrics.fee_apr ?? null, poolMetrics.volume_24h ?? null, poolMetrics.tvl ?? null, ts,
  );

  const signal = {
    id: Number(info.lastInsertRowid),
    pool: pool.pool,
    token_pair: tokenPair,
    confidence: Number(confidence.toFixed(3)),
    wallet_score: wallet.score,
    pool_score: pool.pool_score,
    trigger: {
      type: "wallet_entry",
      wallet: wallet.address,
      wallet_score: wallet.score,
      wallet_wr: wallet.win_rate,
    },
    pool_metrics: poolMetrics,
    suggested,
    validation_reasons: reasons,
    created_at: ts,
  };

  await writeOutput(signal);
  log("signal", `emit #${signal.id} ${pool.pool?.slice(0, 8)}… conf=${signal.confidence} wallet=${wallet.address?.slice(0, 8)}…`);
  try { broadcastSignal(signal); } catch {}
  notifySignal(signal).catch((err) => log("telegram_warn", `notifySignal: ${err.message}`));
  return signal;
}

async function writeOutput(signal) {
  const mode = String(config.output.mode || "file").toLowerCase();
  if (mode === "rest" && config.output.apiEndpoint) return postSignal(signal);
  if (mode === "stdout") { console.log(JSON.stringify(signal)); return; }
  writeToFile(signal); // default: file
}

function writeToFile(signal) {
  const path = config.output.signalPath;
  let arr = [];
  try {
    if (fs.existsSync(path)) arr = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.push(signal);
  if (arr.length > MAX_FILE_SIGNALS) arr = arr.slice(-MAX_FILE_SIGNALS);
  fs.writeFileSync(path, JSON.stringify(arr, null, 2));
}

async function postSignal(signal) {
  try {
    await fetch(config.output.apiEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signal),
    });
  } catch (err) {
    log("signal_warn", `REST emit to ${config.output.apiEndpoint} failed: ${err.message} (signal #${signal.id} persisted to DB only)`);
  }
}
