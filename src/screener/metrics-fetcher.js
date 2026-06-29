import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { withRetry, sleep } from "../utils/retry.js";
import { TIMEFRAME_MINUTES } from "./pool-scorer.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const POOL_PORTFOLIO_BASE = "https://dlmm.datapi.meteora.ag";
const BIRDEYE_OVERVIEW = "https://public-api.birdeye.so/defi/token_overview";
const GMGN_BASE = "https://openapi.gmgn.ai";
const MIN_VOLATILITY_TIMEFRAME = "30m";

// ─── Birdeye global rate limiter ──────────────────────────────────────────────
// Birdeye public API is aggressively rate-limited. Serialise in-flight requests
// across the whole process and back off hard after repeated 429s.
const BIRDEYE_MAX_IN_FLIGHT = Math.max(1, Number(process.env.BIRDEYE_MAX_IN_FLIGHT) || 1);
const BIRDEYE_DISPATCH_DELAY_MS = Math.max(0, Number(process.env.BIRDEYE_DISPATCH_DELAY_MS) || 300);
let birdeyeInFlight = 0;
let birdeye429Count = 0;
let birdeye400QuotaCount = 0;
let birdeyeCircuitOpen = false;
let birdeyeCircuitUntil = 0;
let birdeyeDisabled = false;
const BIRDEYE_CIRCUIT_FAILURE_THRESHOLD = 5;
const BIRDEYE_CIRCUIT_OPEN_MS = 60_000;
const BIRDEYE_QUOTA_DISABLED_MS = 6 * 60 * 60 * 1000; // disable for 6h after quota exceeded

function isBirdeyeDisabled() {
  if (!birdeyeDisabled) return false;
  if (Date.now() >= birdeyeCircuitUntil) {
    birdeyeDisabled = false;
    birdeye400QuotaCount = 0;
    log("birdeye", "Birdeye quota window expired, re-enabling");
    return false;
  }
  return true;
}

async function withBirdeyeLimit(fn) {
  while (birdeyeInFlight >= BIRDEYE_MAX_IN_FLIGHT) await sleep(BIRDEYE_DISPATCH_DELAY_MS);
  if (isBirdeyeDisabled()) {
    throw Object.assign(new Error("Birdeye quota exceeded"), { status: 429, retryAfter: Math.ceil((birdeyeCircuitUntil - Date.now()) / 1000) });
  }
  if (birdeyeCircuitOpen && Date.now() < birdeyeCircuitUntil) {
    throw Object.assign(new Error("Birdeye circuit open"), { status: 429, retryAfter: Math.ceil((birdeyeCircuitUntil - Date.now()) / 1000) });
  }
  birdeyeInFlight++;
  try {
    return await fn();
  } finally {
    birdeyeInFlight--;
  }
}

function recordBirdeye429() {
  birdeye429Count++;
  if (birdeye429Count >= BIRDEYE_CIRCUIT_FAILURE_THRESHOLD) {
    birdeyeCircuitOpen = true;
    birdeyeCircuitUntil = Date.now() + BIRDEYE_CIRCUIT_OPEN_MS;
    log("birdeye_warn", `circuit open: too many 429s, pausing Birdeye for ${BIRDEYE_CIRCUIT_OPEN_MS / 1000}s`);
  }
}

function recordBirdeyeQuotaExceeded() {
  birdeye400QuotaCount++;
  if (birdeye400QuotaCount >= 3) {
    birdeyeDisabled = true;
    birdeyeCircuitUntil = Date.now() + BIRDEYE_QUOTA_DISABLED_MS;
    log("birdeye_warn", `Birdeye quota exceeded, disabling for ${BIRDEYE_QUOTA_DISABLED_MS / 1000 / 60} minutes`);
  }
}

function recordBirdeyeSuccess() {
  if (birdeye429Count > 0) birdeye429Count = 0;
  if (birdeye400QuotaCount > 0) birdeye400QuotaCount = 0;
}

// ─── GMGN global rate limiter ─────────────────────────────────────────────────
// GMGN requires auth and a unique client_id per request. Rate limits are less
// aggressive than Birdeye public, but still throttle to keep us in good standing.
const GMGN_API_KEY = process.env.GMGN_API_KEY || "";
const GMGN_MAX_IN_FLIGHT = Math.max(1, Number(process.env.GMGN_MAX_IN_FLIGHT) || 3);
const GMGN_DISPATCH_DELAY_MS = Math.max(0, Number(process.env.GMGN_DISPATCH_DELAY_MS) || 150);
let gmgnOk = true;
let gmgnInFlight = 0;
let gmgn429Count = 0;
let gmgnCircuitOpen = false;
let gmgnCircuitUntil = 0;
const GMGN_CIRCUIT_FAILURE_THRESHOLD = 5;
const GMGN_CIRCUIT_OPEN_MS = 60_000;

function isGmgnEnabled() {
  return GMGN_API_KEY.length > 0 && gmgnOk;
}

// ─── DexScreener free fallback ─────────────────────────────────────────────────
// No API key needed. Provides buy/sell counts + total volume, but does NOT split
// buy volume vs sell volume. Used as the last resort when Birdeye/GMGN/gmn-cli
// all fail or are unconfigured.
const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens";
const DEXSCREENER_MAX_IN_FLIGHT = Math.max(1, Number(process.env.DEXSCREENER_MAX_IN_FLIGHT) || 3);
const DEXSCREENER_DISPATCH_DELAY_MS = Math.max(0, Number(process.env.DEXSCREENER_DISPATCH_DELAY_MS) || 150);
let dexInFlight = 0;
let dexOk = true;
let dexCircuitOpen = false;
let dexCircuitUntil = 0;
let dex429Count = 0;
const DEXSCREENER_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEXSCREENER_CIRCUIT_OPEN_MS = 60_000;

function isDexscreenerEnabled() {
  return dexOk;
}

async function withDexscreenerLimit(fn) {
  if (!isDexscreenerEnabled()) {
    throw Object.assign(new Error("DexScreener not available"), { status: 503 });
  }
  while (dexInFlight >= DEXSCREENER_MAX_IN_FLIGHT) await sleep(DEXSCREENER_DISPATCH_DELAY_MS);
  if (dexCircuitOpen && Date.now() < dexCircuitUntil) {
    throw Object.assign(new Error("DexScreener circuit open"), { status: 429, retryAfter: Math.ceil((dexCircuitUntil - Date.now()) / 1000) });
  }
  dexInFlight++;
  try {
    return await fn();
  } finally {
    dexInFlight--;
  }
}

function recordDexscreener429() {
  dex429Count++;
  if (dex429Count >= DEXSCREENER_CIRCUIT_FAILURE_THRESHOLD) {
    dexCircuitOpen = true;
    dexCircuitUntil = Date.now() + DEXSCREENER_CIRCUIT_OPEN_MS;
    log("dexscreener_warn", `circuit open: too many 429s, pausing DexScreener for ${DEXSCREENER_CIRCUIT_OPEN_MS / 1000}s`);
  }
}

function recordDexscreenerSuccess() {
  if (dex429Count > 0) dex429Count = 0;
}

export async function fetchDexscreenerTokenInfo(mint) {
  return withDexscreenerLimit(async () => {
    return withRetry(async () => {
      const res = await fetch(`${DEXSCREENER_TOKEN_API}/${encodeURIComponent(mint)}`);
      if (res.status === 429) { recordDexscreener429(); const e = new Error(`dexscreener ${res.status}`); e.status = res.status; throw e; }
      if (!res.ok) { const e = new Error(`dexscreener ${res.status}`); e.status = res.status; throw e; }
      recordDexscreenerSuccess();
      return await res.json();
    }, { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000 });
  });
}

// ─── gmgn-cli fallback ─────────────────────────────────────────────────────────
// When no GMGN_API_KEY is configured, fall back to the locally installed gmgn-cli
// binary. It calls the same backend but handles auth/session internally, so the
// user only needs to install it (`npm install -g gmgn-cli`) without wiring an API
// key into the environment. We rate-limit CLI spawns to avoid fork storms.
const GMGN_CLI_MAX_IN_FLIGHT = Math.max(1, Number(process.env.GMGN_CLI_MAX_IN_FLIGHT) || 2);
const GMGN_CLI_DISPATCH_DELAY_MS = Math.max(0, Number(process.env.GMGN_CLI_DISPATCH_DELAY_MS) || 250);
let gmgnCliInFlight = 0;
let gmgnCliOk = true;
let gmgnCliCircuitOpen = false;
let gmgnCliCircuitUntil = 0;
let gmgnCli429Count = 0;
const GMGN_CLI_CIRCUIT_FAILURE_THRESHOLD = 5;
const GMGN_CLI_CIRCUIT_OPEN_MS = 60_000;

function isGmgnCliEnabled() {
  return !GMGN_API_KEY && gmgnCliOk;
}

async function withGmgnCliLimit(fn) {
  if (!isGmgnCliEnabled()) {
    throw Object.assign(new Error("gmgn-cli not available"), { status: 503 });
  }
  while (gmgnCliInFlight >= GMGN_CLI_MAX_IN_FLIGHT) await sleep(GMGN_CLI_DISPATCH_DELAY_MS);
  if (gmgnCliCircuitOpen && Date.now() < gmgnCliCircuitUntil) {
    throw Object.assign(new Error("gmgn-cli circuit open"), { status: 429, retryAfter: Math.ceil((gmgnCliCircuitUntil - Date.now()) / 1000) });
  }
  gmgnCliInFlight++;
  try {
    return await fn();
  } finally {
    gmgnCliInFlight--;
  }
}

function recordGmgnCliFailure(err) {
  if (err?.status === 429 || err?.message?.includes("429")) {
    gmgnCli429Count++;
    if (gmgnCli429Count >= GMGN_CLI_CIRCUIT_FAILURE_THRESHOLD) {
      gmgnCliCircuitOpen = true;
      gmgnCliCircuitUntil = Date.now() + GMGN_CLI_CIRCUIT_OPEN_MS;
      log("gmgn_cli_warn", `circuit open: too many 429s, pausing gmgn-cli for ${GMGN_CLI_CIRCUIT_OPEN_MS / 1000}s`);
    }
  }
}

function recordGmgnCliSuccess() {
  if (gmgnCli429Count > 0) gmgnCli429Count = 0;
}

function runGmgnCli(args, timeoutMs = 20_000) {
  return withGmgnCliLimit(() => new Promise((resolve, reject) => {
    const child = spawn("gmgn-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error("gmgn-cli timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const e = new Error(`gmgn-cli exited ${code}: ${stderr.trim() || stdout.trim() || "unknown error"}`);
        if (stderr.includes("429") || stdout.includes("429")) e.status = 429;
        if (stderr.includes("401") || stdout.includes("401") || stderr.includes("403") || stdout.includes("403")) e.status = 401;
        reject(e);
        return;
      }
      try {
        const j = JSON.parse(stdout.trim());
        resolve(j);
      } catch (err) {
        reject(new Error(`gmgn-cli invalid JSON: ${err.message}`));
      }
    });
  }));
}

async function fetchGmgnCliTokenInfo(mint) {
  try {
    return await withRetry(async () => {
      const data = await runGmgnCli(["token", "info", "--chain", "sol", "--address", mint, "--raw"]);
      recordGmgnCliSuccess();
      return data || null;
    }, { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000 });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      gmgnCliOk = false;
      log("gmgn_cli_warn", `gmgn-cli auth failed, disabling CLI fallback`);
    } else {
      recordGmgnCliFailure(err);
      log("gmgn_cli_warn", `gmgn-cli token info ${mint?.slice(0, 8)}: ${err.message}`);
    }
    return null;
  }
}

async function withGmgnLimit(fn) {
  if (!isGmgnEnabled()) {
    throw Object.assign(new Error("GMGN not available"), { status: 503 });
  }
  while (gmgnInFlight >= GMGN_MAX_IN_FLIGHT) await sleep(GMGN_DISPATCH_DELAY_MS);
  if (gmgnCircuitOpen && Date.now() < gmgnCircuitUntil) {
    throw Object.assign(new Error("GMGN circuit open"), { status: 429, retryAfter: Math.ceil((gmgnCircuitUntil - Date.now()) / 1000) });
  }
  gmgnInFlight++;
  try {
    return await fn();
  } finally {
    gmgnInFlight--;
  }
}

function recordGmgn429() {
  gmgn429Count++;
  if (gmgn429Count >= GMGN_CIRCUIT_FAILURE_THRESHOLD) {
    gmgnCircuitOpen = true;
    gmgnCircuitUntil = Date.now() + GMGN_CIRCUIT_OPEN_MS;
    log("gmgn_warn", `circuit open: too many 429s, pausing GMGN for ${GMGN_CIRCUIT_OPEN_MS / 1000}s`);
  }
}

function recordGmgnSuccess() {
  if (gmgn429Count > 0) gmgn429Count = 0;
}

export async function fetchGmgnTokenInfo(mint) {
  return withGmgnLimit(async () => {
    return withRetry(async () => {
      const url = `${GMGN_BASE}/v1/token/info?chain=sol&address=${encodeURIComponent(mint)}` +
        `&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${randomUUID()}`;
      const res = await fetch(url, {
        headers: { "X-APIKEY": GMGN_API_KEY, "Content-Type": "application/json" },
      });
      if (res.status === 401 || res.status === 403) {
        gmgnOk = false;
        log("gmgn_warn", `GMGN ${res.status} — key issue, disabling`);
        return null;
      }
      if (res.status === 429) { recordGmgn429(); const e = new Error(`gmgn ${res.status}`); e.status = res.status; throw e; }
      if (!res.ok) { const e = new Error(`gmgn ${res.status}`); e.status = res.status; throw e; }
      recordGmgnSuccess();
      const j = await res.json();
      return j?.data || j || null;
    }, { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5000 });
  });
}

/** Coerce a value to a finite number, or null. */
export function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Volatility is only meaningful when finite and > 0. */
export function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

/** Volatility is only meaningful on ≥30m windows; fall back to 30m for shorter TFs. */
export function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

// ─── Meteora Pool Discovery API rate limiter ──────────────────────────────────
// The public Meteora pool-discovery endpoint is aggressively throttled (429). We
// serialise calls, add a small dispatch delay, and circuit-break after repeated
// rate-limits so screening cycles don't spam the API.
const METEORA_POOL_MAX_IN_FLIGHT = config.env.meteoraPoolMaxInFlight;
const METEORA_POOL_DISPATCH_DELAY_MS = config.env.meteoraPoolDispatchDelayMs;
let meteoraPoolInFlight = 0;
let meteoraPool429Count = 0;
let meteoraPoolCircuitOpen = false;
let meteoraPoolCircuitUntil = 0;
const METEORA_POOL_CIRCUIT_FAILURE_THRESHOLD = config.env.meteoraPoolCircuitFailureThreshold;
const METEORA_POOL_CIRCUIT_OPEN_MS = config.env.meteoraPoolCircuitOpenMs;

function recordMeteoraPool429() {
  meteoraPool429Count++;
  if (meteoraPool429Count >= METEORA_POOL_CIRCUIT_FAILURE_THRESHOLD) {
    meteoraPoolCircuitOpen = true;
    meteoraPoolCircuitUntil = Date.now() + METEORA_POOL_CIRCUIT_OPEN_MS;
    log("meteora_pool_warn", `circuit open: too many 429s, pausing pool discovery for ${METEORA_POOL_CIRCUIT_OPEN_MS / 1000}s`);
  }
}

function recordMeteoraPoolSuccess() {
  if (meteoraPool429Count > 0) meteoraPool429Count = 0;
}

async function withMeteoraPoolLimit(fn) {
  while (meteoraPoolInFlight >= METEORA_POOL_MAX_IN_FLIGHT) await sleep(METEORA_POOL_DISPATCH_DELAY_MS);
  if (meteoraPoolCircuitOpen && Date.now() < meteoraPoolCircuitUntil) {
    throw Object.assign(
      new Error("Meteora pool discovery circuit open"),
      { status: 429, retryAfter: Math.ceil((meteoraPoolCircuitUntil - Date.now()) / 1000) },
    );
  }
  meteoraPoolInFlight++;
  try {
    return await fn();
  } finally {
    meteoraPoolInFlight--;
  }
}

/** Fetch one page of pools from the Meteora discovery API (public, no auth). */
export async function fetchPoolPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${encodeURIComponent(timeframe)}` +
    `&category=${encodeURIComponent(category)}`;
  return withMeteoraPoolLimit(() =>
    withRetry(async () => {
      const res = await fetch(url);
      if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
      if (!res.ok) {
        const e = new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
        e.status = res.status;
        throw e;
      }
      recordMeteoraPoolSuccess();
      return res.json();
    }, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 })
  );
}

// ─── Per-pool detail cache ────────────────────────────────────────────────────
// signal_scan fetches the same pools repeatedly; cache the raw detail for 60s to
// reduce 429 pressure and speed up repeated calls.
const _poolDetailCache = new Map();
const _POOL_DETAIL_TTL_MS = 60_000;

/** Fetch a single pool's full raw detail by address (page_size=1 filter). */
export async function fetchPoolByAddress(poolAddress, timeframe = config.screening.timeframe) {
  const cacheKey = `${poolAddress}:${timeframe}`;
  const cached = _poolDetailCache.get(cacheKey);
  if (cached && Date.now() - cached.at < _POOL_DETAIL_TTL_MS) return cached.data;

  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${encodeURIComponent(timeframe)}`;
  const data = await withMeteoraPoolLimit(() =>
    withRetry(async () => {
      const res = await fetch(url);
      if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`Pool detail API error: ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
      if (!res.ok) {
        const e = new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
        e.status = res.status;
        throw e;
      }
      recordMeteoraPoolSuccess();
      const json = await res.json();
      return (json.data || [])[0] ?? null;
    }, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 })
  );

  _poolDetailCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

// Macro SOL price (market regime feature) via Coingecko, cached 60s. Free, no key.
let _solPrice = null;
let _solPriceAt = 0;
export async function getSolPriceUsd() {
  const now = Date.now();
  if (_solPrice != null && now - _solPriceAt < 60_000) return _solPrice;
  try {
    const price = await withRetry(async () => {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      if (!res.ok) { const e = new Error(`coingecko ${res.status}`); e.status = res.status; throw e; }
      return (await res.json())?.solana?.usd ?? null;
    }, { maxAttempts: 2 });
    if (price != null) { _solPrice = price; _solPriceAt = now; }
  } catch { /* keep last known price */ }
  return _solPrice;
}

/**
 * Birdeye token_overview trade-direction subset (buy/sell volume USD + counts over 24h).
 * Cached 15min/mint (multiple pools share a base_mint → avoid hammering Birdeye). Null if no key.
 * Fields: vBuy24hUSD, vSell24hUSD, buy24h, sell24h (raw token_overview envelope).
 */
const _birdeyeTradeCache = new Map();
const _BIRDEYE_TRADE_TTL_MS = 15 * 60 * 1000; // 15min cache to reduce 429 pressure
export async function fetchBirdeyeTradeFlow(mint) {
  if (!mint || !config.env.birdeyeApiKey) return null;
  const cached = _birdeyeTradeCache.get(mint);
  if (cached && Date.now() - cached.at < _BIRDEYE_TRADE_TTL_MS) return cached.data;
  try {
    const data = await withBirdeyeLimit(async () => {
      return await withRetry(async () => {
        const res = await fetch(`${BIRDEYE_OVERVIEW}?address=${mint}&chain=solana`, {
          headers: { "x-api-key": config.env.birdeyeApiKey },
        });
        if (res.status === 429) {
          recordBirdeye429();
          const e = new Error(`birdeye trade ${res.status}`);
          e.status = res.status;
          throw e;
        }
        if (res.status === 400) {
          const body = await res.text().catch(() => "");
          if (body.includes("Compute units usage limit exceeded")) {
            recordBirdeyeQuotaExceeded();
            const e = new Error(`Birdeye quota exceeded`);
            e.status = 429;
            throw e;
          }
          const e = new Error(`birdeye trade ${res.status}`);
          e.status = res.status;
          throw e;
        }
        if (!res.ok) { const e = new Error(`birdeye trade ${res.status}`); e.status = res.status; throw e; }
        recordBirdeyeSuccess();
        const j = await res.json();
        return j?.data || j || null;
      }, { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 30_000 });
    });
    if (data) _birdeyeTradeCache.set(mint, { at: Date.now(), data });
    return data;
  } catch (err) {
    log("birdeye_warn", `trade flow ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * GMGN token info trade-direction subset (buy/sell volume USD + counts over 24h).
 * Cached 15min/mint and uses the same cache key-space as Birdeye so callers can try
 * one and fall back to the other transparently.
 * Fields: vBuy24hUSD, vSell24hUSD, buy24h, sell24h (normalised to Birdeye shape).
 */
const _gmgnTradeCache = new Map();
const _GMGN_TRADE_TTL_MS = 15 * 60 * 1000;
export async function fetchGmgnTradeFlow(mint) {
  if (!mint || !isGmgnEnabled()) return null;
  const cached = _gmgnTradeCache.get(mint);
  if (cached && Date.now() - cached.at < _GMGN_TRADE_TTL_MS) return cached.data;
  try {
    const data = await fetchGmgnTokenInfo(mint);
    if (!data) return null;
    const price = data.price || {};
    const normalised = {
      vBuy24hUSD: numeric(price.buy_volume_24h),
      vSell24hUSD: numeric(price.sell_volume_24h),
      buy24h: numeric(price.buys_24h),
      sell24h: numeric(price.sells_24h),
      volume24hUSD: numeric(price.volume_24h),
      swaps24h: numeric(price.swaps_24h),
      source: "gmgn",
    };
    _gmgnTradeCache.set(mint, { at: Date.now(), data: normalised });
    return normalised;
  } catch (err) {
    log("gmgn_warn", `trade flow ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * GMGN trade-flow via local gmgn-cli binary. Used when no GMGN_API_KEY is configured.
 * Parses the same `price.*_24h` fields and normalises them to the Birdeye shape.
 */
export async function fetchGmgnCliTradeFlow(mint) {
  if (!mint || !isGmgnCliEnabled()) return null;
  const cached = _gmgnTradeCache.get(mint);
  if (cached && Date.now() - cached.at < _GMGN_TRADE_TTL_MS) return cached.data;
  try {
    const data = await fetchGmgnCliTokenInfo(mint);
    if (!data) return null;
    const price = data.price || {};
    const normalised = {
      vBuy24hUSD: numeric(price.buy_volume_24h),
      vSell24hUSD: numeric(price.sell_volume_24h),
      buy24h: numeric(price.buys_24h),
      sell24h: numeric(price.sells_24h),
      volume24hUSD: numeric(price.volume_24h),
      swaps24h: numeric(price.swaps_24h),
      source: "gmgn-cli",
    };
    _gmgnTradeCache.set(mint, { at: Date.now(), data: normalised });
    return normalised;
  } catch (err) {
    log("gmgn_cli_warn", `trade flow ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * DexScreener trade-direction subset. Free, no key. Provides buy/sell counts and
 * total 24h volume. Buy/sell volume USD is NOT split by DexScreener, so we leave
 * those fields null and rely on total volume + counts.
 */
const _dexscreenerTradeCache = new Map();
const _DEXSCREENER_TRADE_TTL_MS = 15 * 60 * 1000;
export async function fetchDexscreenerTradeFlow(mint) {
  if (!mint || !isDexscreenerEnabled()) return null;
  const cached = _dexscreenerTradeCache.get(mint);
  if (cached && Date.now() - cached.at < _DEXSCREENER_TRADE_TTL_MS) return cached.data;
  try {
    const data = await fetchDexscreenerTokenInfo(mint);
    if (!data?.pairs || !Array.isArray(data.pairs)) return null;
    // Pick the Solana pair with the highest 24h volume.
    const pair = data.pairs
      .filter((p) => p?.chainId === "solana")
      .sort((a, b) => (numeric(b.volume?.h24) || 0) - (numeric(a.volume?.h24) || 0))[0];
    if (!pair) return null;
    const txns = pair.txns?.h24 || {};
    const vol = pair.volume?.h24 || {};
    const normalised = {
      vBuy24hUSD: null,
      vSell24hUSD: null,
      buy24h: numeric(txns.buys),
      sell24h: numeric(txns.sells),
      volume24hUSD: numeric(vol),
      swaps24h: numeric(txns.buys) != null && numeric(txns.sells) != null
        ? (numeric(txns.buys) + numeric(txns.sells))
        : null,
      source: "dexscreener",
    };
    _dexscreenerTradeCache.set(mint, { at: Date.now(), data: normalised });
    return normalised;
  } catch (err) {
    log("dexscreener_warn", `trade flow ${mint?.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Unified trade-flow fetcher. Priority:
 * 1. Birdeye (keyed, buy/sell volume + counts)
 * 2. GMGN HTTP API (keyed, buy/sell volume + counts)
 * 3. gmgn-cli binary (handles its own auth, same data)
 * 4. DexScreener (free, counts + total volume only)
 * Returns null only when all sources are unavailable.
 */
export async function fetchTradeFlow(mint) {
  if (!mint) return null;
  const b = await fetchBirdeyeTradeFlow(mint);
  if (b && (numeric(b.vBuy24hUSD) != null || numeric(b.vSell24hUSD) != null || numeric(b.buy24h) != null)) {
    return b;
  }
  const g = await fetchGmgnTradeFlow(mint);
  if (g && (numeric(g.vBuy24hUSD) != null || numeric(g.vSell24hUSD) != null || numeric(g.buy24h) != null)) {
    return g;
  }
  const c = await fetchGmgnCliTradeFlow(mint);
  if (c && (numeric(c.vBuy24hUSD) != null || numeric(c.vSell24hUSD) != null || numeric(c.buy24h) != null)) {
    return c;
  }
  const d = await fetchDexscreenerTradeFlow(mint);
  if (d && (numeric(d.buy24h) != null || numeric(d.volume24hUSD) != null)) {
    return d;
  }
  return null;
}

/**
 * Unified token-info enrichment payload. Priority mirrors fetchTradeFlow:
 * 1. Birdeye token_overview (most complete market + security data)
 * 2. GMGN HTTP API (launchpad/dev/risk rates)
 * 3. gmgn-cli binary (same backend, no explicit API key)
 * 4. DexScreener (free, basic market data only)
 * Returns { source: string, data: object } or null when all sources fail.
 */
const _tokenInfoCache = new Map();
const _TOKEN_INFO_TTL_MS = 15 * 60 * 1000;
export async function fetchTokenInfo(mint) {
  if (!mint) return null;
  const cached = _tokenInfoCache.get(mint);
  if (cached && Date.now() - cached.at < _TOKEN_INFO_TTL_MS) return cached.data;

  // 1. Birdeye
  if (config.env.birdeyeApiKey) {
    try {
      const data = await fetchBirdeyeTradeFlow(mint); // raw token_overview envelope is cached inside
      if (data && (data.symbol != null || data.marketCap != null || data.fdv != null || data.totalSupply != null)) {
        const result = { source: "birdeye", data };
        _tokenInfoCache.set(mint, { at: Date.now(), data: result });
        return result;
      }
    } catch (err) {
      log("tokeninfo_warn", `fetchTokenInfo birdeye ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // 2. GMGN HTTP
  if (isGmgnEnabled()) {
    try {
      const data = await fetchGmgnTokenInfo(mint);
      if (data && (data.symbol != null || data.mcap != null || data.total_supply != null)) {
        const result = { source: "gmgn", data };
        _tokenInfoCache.set(mint, { at: Date.now(), data: result });
        return result;
      }
    } catch (err) {
      log("tokeninfo_warn", `fetchTokenInfo gmgn ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // 3. gmgn-cli
  if (isGmgnCliEnabled()) {
    try {
      const data = await fetchGmgnCliTokenInfo(mint);
      if (data && (data.symbol != null || data.mcap != null || data.total_supply != null)) {
        const result = { source: "gmgn-cli", data };
        _tokenInfoCache.set(mint, { at: Date.now(), data: result });
        return result;
      }
    } catch (err) {
      log("tokeninfo_warn", `fetchTokenInfo gmgn-cli ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  // 4. DexScreener
  if (isDexscreenerEnabled()) {
    try {
      const data = await fetchDexscreenerTokenInfo(mint);
      if (data?.pairs?.length) {
        const pair = data.pairs
          .filter((p) => p?.chainId === "solana")
          .sort((a, b) => (numeric(b.volume?.h24) || 0) - (numeric(a.volume?.h24) || 0))[0];
        if (pair) {
          const result = { source: "dexscreener", data: pair };
          _tokenInfoCache.set(mint, { at: Date.now(), data: result });
          return result;
        }
      }
    } catch (err) {
      log("tokeninfo_warn", `fetchTokenInfo dexscreener ${mint.slice(0, 8)}: ${err.message}`);
    }
  }

  return null;
}

/**
 * A wallet's CURRENT open-position portfolio (Meteora portfolio API). This is the reliable,
 * always-present per-wallet data source — unlike Agent Meridian (which only details top-20 LPers per
 * pool). Used by the evaluator for: open-position COUNT (consistency/gate), current PnL/fees,
 * and open win-rate (fraction of pools with positive PnL).
 */
export async function fetchWalletPortfolio(wallet) {
  return withMeteoraPoolLimit(() =>
    withRetry(async () => {
      const res = await fetch(`${POOL_PORTFOLIO_BASE}/portfolio/open?user=${encodeURIComponent(wallet)}`);
      if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`portfolio/open ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
      if (!res.ok) {
        const e = new Error(`portfolio/open ${res.status} ${res.statusText}`);
        e.status = res.status;
        throw e;
      }
      recordMeteoraPoolSuccess();
      const d = await res.json();
      const pools = Array.isArray(d.pools)
        ? d.pools.map((p) => ({
            poolAddress: p.poolAddress,
            pnl: Number(p.pnl) || 0,
            unclaimedFees: Number(p.unclaimedFees) || 0,
            feePerTvl24h: Number(p.feePerTvl24h) || 0,
            totalDeposit: Number(p.totalDeposit) || 0,
            openPositionCount: Number(p.openPositionCount) || 0,
            tokenXSymbol: p.tokenX || "",
            tokenYSymbol: p.tokenY || "",
          }))
        : [];
      return { totalPositions: Number(d.totalPositions) || 0, pools };
    })
  );
}

/**
 * Wallet lifetime realized-PnL summary from Meteora. Complements portfolio/open with closed
 * position totals. Lightweight, public, no auth.
 * @param {string} wallet
 * @returns {Promise<{ totalPnlUsd: number, totalPnlPctChange: number, totalClosedPositions: number }>}
 */
export async function fetchWalletPortfolioTotal(wallet) {
  return withMeteoraPoolLimit(() =>
    withRetry(async () => {
      const res = await fetch(`${POOL_PORTFOLIO_BASE}/portfolio/total?user=${encodeURIComponent(wallet)}`);
      if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`portfolio/total ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
      if (!res.ok) {
        const e = new Error(`portfolio/total ${res.status} ${res.statusText}`);
        e.status = res.status;
        throw e;
      }
      recordMeteoraPoolSuccess();
      const d = await res.json();
      return {
        totalPnlUsd: Number(d.totalPnlUsd) || 0,
        totalPnlPctChange: Number(d.totalPnlPctChange) || 0,
        totalClosedPositions: Number(d.totalClosedPositions) || 0,
      };
    })
  );
}

/**
 * Per-pool position PnL history from Meteora. Returns both open and closed positions with
 * bin range, deposits, withdrawals, fees, and close timestamps. Much richer than Agent Meridian
 * (which only covers top-3 historical owners per pool).
 * @param {string} wallet
 * @param {string} poolAddress
 * @param {{ status?: 'all'|'closed'|'open', pageSize?: number }} opts
 * @returns {Promise<object[]>}
 */
export async function fetchPoolPositionPnl(wallet, poolAddress, { status = "all", pageSize = 100, symbolMap = null } = {}) {
  return withMeteoraPoolLimit(() =>
    withRetry(async () => {
      const url = `${POOL_PORTFOLIO_BASE}/positions/${encodeURIComponent(poolAddress)}/pnl` +
        `?user=${encodeURIComponent(wallet)}` +
        `&status=${encodeURIComponent(status)}` +
        `&page=1&page_size=${pageSize}`;
      const res = await fetch(url);
      if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`positions/pnl ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
      if (!res.ok) {
        const e = new Error(`positions/pnl ${res.status} ${res.statusText}`);
        e.status = res.status;
        throw e;
      }
      recordMeteoraPoolSuccess();
      const d = await res.json();
      // /positions/pnl returns tokenX/Y as mint addresses (often null). Prefer symbols from
      // the parent /portfolio call (passed in symbolMap), or fall back to mint addresses.
      const mapped = symbolMap?.get(poolAddress);
      const tokenXSymbol = mapped?.x || d.tokenXSymbol || d.tokenX || "";
      const tokenYSymbol = mapped?.y || d.tokenYSymbol || d.tokenY || "";
      const positions = Array.isArray(d.positions) ? d.positions : [];
      return positions.map((p) => ({
        positionAddress: p.positionAddress,
        poolAddress,
        tokenXSymbol,
        tokenYSymbol,
        tokenPair: `${tokenXSymbol}/${tokenYSymbol}`.replace(/^\//, ""),
        minPrice: Number(p.minPrice) || null,
        maxPrice: Number(p.maxPrice) || null,
        lowerBinId: Number(p.lowerBinId) ?? null,
        upperBinId: Number(p.upperBinId) ?? null,
        poolActiveBinId: Number(p.poolActiveBinId) ?? null,
        isOutOfRange: p.isOutOfRange === true,
        isClosed: p.isClosed === true,
        createdAt: Number(p.createdAt) || null,
        closedAt: Number(p.closedAt) || null,
        pnlUsd: Number(p.pnlUsd) || 0,
        pnlSol: Number(p.pnlSol) || 0,
        pnlPctChange: Number(p.pnlPctChange) || 0,
        feePerTvl24h: Number(p.feePerTvl24h) || 0,
        depositsUsd: Number(p.allTimeDeposits?.total?.usd) || 0,
        withdrawalsUsd: Number(p.allTimeWithdrawals?.total?.usd) || 0,
        feesUsd: Number(p.allTimeFees?.total?.usd) || 0,
        tokenXPrice: Number(d.tokenXPrice) || null,
        tokenYPrice: Number(d.tokenYPrice) || null,
        solPrice: Number(d.solPrice) || null,
      }));
    })
  );
}

/**
 * Full wallet position history across all pools. Fetches the wallet's portfolio list and then
 * per-pool position PnL details in parallel. Used by the evaluator to reconstruct closed
 * positions without relying solely on Agent Meridian.
 * @param {string} wallet
 * @param {{ status?: 'all'|'closed'|'open', daysBack?: number, pageSize?: number }} opts
 * @returns {Promise<{ totalClosedPositions: number, positions: object[] }>}
 */
export async function fetchWalletPositionHistory(wallet, { status = "all", daysBack = 365, pageSize = 100 } = {}) {
  const pools = [];
  let page = 1;
  let hasNext = true;
  let totalClosedPositions = 0;

  while (hasNext) {
    const summary = await withMeteoraPoolLimit(() =>
      withRetry(async () => {
        const res = await fetch(
          `${POOL_PORTFOLIO_BASE}/portfolio?user=${encodeURIComponent(wallet)}` +
          `&page=${page}&page_size=${pageSize}&days_back=${daysBack}`,
        );
        if (res.status === 429) { recordMeteoraPool429(); const e = new Error(`portfolio ${res.status} ${res.statusText}`); e.status = res.status; e.retryAfter = res.headers.get("retry-after"); throw e; }
        if (!res.ok) {
          const e = new Error(`portfolio ${res.status} ${res.statusText}`);
          e.status = res.status;
          throw e;
        }
        recordMeteoraPoolSuccess();
        return res.json();
      })
    );

    if (Array.isArray(summary?.pools)) pools.push(...summary.pools);
    if (Number.isFinite(summary?.totalClosedPositions)) {
      totalClosedPositions = summary.totalClosedPositions;
    }
    hasNext = summary?.hasNext === true;
    page += 1;

    // Safety guard: never loop beyond a reasonable page count.
    if (page > 50) {
      log("metrics_warn", `portfolio pagination exceeded 50 pages for ${wallet.slice(0, 8)}…; stopping`);
      break;
    }
  }

  // Build a symbol lookup from the portfolio summary so /positions/pnl rows get readable pairs.
  const symbolMap = new Map();
  for (const p of pools) {
    if (!p?.poolAddress) continue;
    const x = p.tokenXSymbol || p.tokenX || "";
    const y = p.tokenYSymbol || p.tokenY || "";
    symbolMap.set(p.poolAddress, { x, y });
  }

  const uniquePools = [...new Set(pools.map((p) => p?.poolAddress).filter(Boolean))];

  const all = await Promise.allSettled(
    uniquePools.map((pool) => fetchPoolPositionPnl(wallet, pool, { status, pageSize, symbolMap })),
  );

  const positions = [];
  for (const r of all) {
    if (r.status === "fulfilled") positions.push(...r.value);
  }

  return {
    totalClosedPositions: Number(totalClosedPositions) || 0,
    positions,
  };
}

/**
 * The screening timeframe may be shorter than 30m, where volatility is not meaningful.
 * Tag the primary-TF values on each pool, then — if needed — re-fetch the longer-TF
 * volume/volatility per pool and use those as the canonical values for filtering.
 * Ported from meridian tools/screening.js.
 */
export async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const addresses = [...new Set(rawPools.map((p) => p?.pool_address).filter(Boolean))];
  const results = await Promise.allSettled(
    addresses.map((poolAddress) =>
      fetchPoolByAddress(poolAddress, volatilityTimeframe).then((pool) => ({
        poolAddress,
        volatility: numeric(pool?.volatility),
        volume: numeric(pool?.volume),
      }))
    )
  );

  const byPool = new Map();
  for (const r of results) if (r.status === "fulfilled") byPool.set(r.value.poolAddress, r.value);

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const m = byPool.get(pool.pool_address);
    if (!m) continue;
    pool[`volume_${volatilityTimeframe}`] = m.volume;
    pool[`volatility_${volatilityTimeframe}`] = m.volatility;
    if (m.volatility != null) pool.volatility = m.volatility;
    if (m.volume != null) pool.volume = m.volume;
  }

  return rawPools;
}
