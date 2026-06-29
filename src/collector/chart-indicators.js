// Chart indicator collector (Laminar parity: populates chart_indicators table).
//
// Laminar uses RSI/supertrend/MACD/Bollinger for entry/exit signals (chartIndicators block
// in user-config.json). Scout mirrors the schema so the same model can be tuned against either
// engine's data.
//
// Current source: derived from market_snapshots.price + min/max_price (pool-detail values are
// last-tick mid-price + a synthetic high/low band). This is intentionally coarse — full OHLC
// feeds require Birdeye/GMGN candles which are rate-limited. Future enhancement: wire a real
// candle feed (Birdeye /defi/ohlcv or GMGN candlestick endpoint) and replace this stub.

import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb, initDb, closeDb } from "../db/index.js";

const SUPPORTED_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];
const DEFAULT_TIMEFRAMES = ["5m"];

const TIMEFRAME_SECONDS = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

function rsi14(prices) {
  if (!Array.isArray(prices) || prices.length < 15) return null;
  const slice = prices.slice(-15);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / Math.max(1e-9, losses);
  const rsi = 100 - 100 / (1 + rs);
  return Number(rsi.toFixed(2));
}

function supertrendSignal(prices, period = 10, multiplier = 3) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const slice = prices.slice(-period);
  const atr = slice.reduce((acc, p, i) => {
    if (i === 0) return 0;
    return acc + Math.abs(p - slice[i - 1]);
  }, 0) / Math.max(1, slice.length - 1);
  const hl2 = (Math.max(...slice) + Math.min(...slice)) / 2;
  const upperBand = hl2 + multiplier * atr;
  const lowerBand = hl2 - multiplier * atr;
  const last = slice[slice.length - 1];
  const signal = last > lowerBand && last < upperBand ? "up" : "down";
  return { signal, value: Number(hl2.toFixed(6)) };
}

/**
 * Populate chart_indicators for a given pool from its recent price snapshots.
 * Returns the number of rows inserted.
 */
export function populateChartIndicatorsForPool(poolAddress, { timeframes = DEFAULT_TIMEFRAMES } = {}) {
  if (!config?.dataset?.exportPath) return 0; // honour feature flag context if needed
  const db = getDb();
  const stmt = db.prepare("SELECT id, timestamp, price FROM market_snapshots WHERE pool_address = ? AND price IS NOT NULL ORDER BY timestamp ASC LIMIT 200");
  const snaps = stmt.all(poolAddress);
  if (!snaps.length) return 0;

  let written = 0;
  const insertStmt = db.prepare(`INSERT OR REPLACE INTO chart_indicators (
    pool_address, snapshot_id, timeframe, timestamp,
    rsi_14, supertrend_signal, supertrend_value, open_price, close_price, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`);

  for (const tf of timeframes) {
    if (!SUPPORTED_TIMEFRAMES.includes(tf)) continue;
    const windowSec = TIMEFRAME_SECONDS[tf];
    const buckets = new Map();
    for (const s of snaps) {
      const bucket = Math.floor(s.timestamp / windowSec) * windowSec;
      const arr = buckets.get(bucket) || [];
      arr.push(s.price);
      buckets.set(bucket, arr);
    }
    const sorted = [...buckets.entries()].sort(([a], [b]) => a - b);
    const closes = sorted.map(([, prices]) => prices[prices.length - 1]);
    const rsi = rsi14(closes);
    const st = supertrendSignal(closes);
    if (closes.length === 0) continue;
    insertStmt.run(
      poolAddress,
      snaps[snaps.length - 1].id,
      tf,
      sorted[sorted.length - 1][0],
      rsi,
      st?.signal ?? null,
      st?.value ?? null,
      sorted[0][1][0],
      closes[closes.length - 1],
    );
    written += 1;
  }
  return written;
}

/** CLI: backfill all known pools. */
const isStandalone = import.meta.url === `file://${process.argv[1]}`;
if (isStandalone) {
  initDb();
  try {
    const db = getDb();
    const pools = db.prepare("SELECT DISTINCT pool_address FROM market_snapshots LIMIT 500").all();
    let total = 0;
    for (const { pool_address } of pools) {
      total += populateChartIndicatorsForPool(pool_address);
    }
    log("chart", `populated ${total} chart_indicators rows for ${pools.length} pools`);
  } finally {
    closeDb();
  }
}
