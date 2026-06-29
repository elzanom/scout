import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { withRetry, sleep } from "../utils/retry.js";
import {
  getHeliusKeyManager,
  markHeliusFailed,
  markHeliusRateLimited,
  markHeliusSuccess,
} from "./helius-key-manager.js";

/**
 * Helius RPC router.
 *
 * Scout has two different Helius-shaped needs:
 *
 * 1. Premium / parsed APIs — Enhanced Transactions (`/v0/addresses/{addr}/transactions`),
 *    webhook secret validation, and the Meteora portfolio endpoints (datapi.meteora.ag).
 *    These MUST keep using the key-authenticated Helius endpoint because
 *    `https://pump.helius-rpc.com` is a *public* Solana RPC proxy; it does not serve
 *    enhanced transaction history or webhook management.
 *
 * 2. Generic Solana RPC — `getAccountInfo`, `getBalance`, `getSignaturesForAddress`,
 *    `getTransaction`, `getProgramAccounts`, etc. These can be routed through any
 *    Solana RPC endpoint, including the public pump.helius-rpc.com proxy.
 *
 * This module provides helpers that keep (1) on `https://api.helius.xyz` (HELIUS_API_KEY)
 * and optionally route (2) through HELIUS_PUMP_RPC_URL / HELIUS_RPC_URL. When pump is
 * enabled we try it first; if it fails we fall back to the key endpoint so the cycle
 * keeps running.
 *
 * Multiple Helius API keys are supported via `HELIUS_API_KEY=key1,key2,...` or
 * `HELIUS_API_KEY_1`, `HELIUS_API_KEY_2`, ... See `src/rpc/helius-key-manager.js`.
 *
 * Limitations of pump.helius-rpc.com (public):
 * - No enhanced/parsed transactions.
 * - No webhook APIs.
 * - Rate limits are shared/unknown; treat it as best-effort.
 * - CORS and IP throttling may apply.
 * - Some methods (getProgramAccounts with large filters) may be restricted.
 */

const PREMIUM_BASE = "https://api.helius.xyz";
const DEFAULT_PUMP_RPC = "https://pump.helius-rpc.com";

function getPremiumUrl(key) {
  const k = key || getHeliusKeyManager().nextKey();
  return `${PREMIUM_BASE}/?api-key=${encodeURIComponent(k)}`;
}

function getGenericRpcUrl(primary = true) {
  const pumpUrl = config.env.heliusPumpRpcUrl || DEFAULT_PUMP_RPC;
  const keyUrl = config.env.heliusRpcUrl || getPremiumUrl();
  // When pump is explicitly disabled via env, only use the key endpoint.
  if (config.env.heliusUsePumpForRpc === false) return keyUrl;
  return primary ? pumpUrl : keyUrl;
}

function shouldTryPump() {
  // Default is OFF unless user opts in. Public RPCs are flaky and can silently drop txs;
  // we only mix when the operator explicitly asks for it.
  if (config.env.heliusUsePumpForRpc === true) return true;
  return false;
}

/**
 * Call a generic Solana JSON-RPC method.
 *
 * @param {string} method — Solana RPC method name, e.g. "getAccountInfo"
 * @param {any[]} params — method params
 * @param {{ timeoutMs?: number, retryOnStatus?: number[], label?: string }} opts
 * @returns {Promise<any>} the `result` field of the JSON-RPC response
 */
export async function rpcCall(method, params = [], opts = {}) {
  const { timeoutMs = 30_000, retryOnStatus = [429, 500, 502, 503, 504], label = method } = opts;
  const body = { jsonrpc: "2.0", id: 1, method, params };

  async function tryEndpoint(url, isPump) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`RPC ${label} ${res.status} ${res.statusText} @ ${isPump ? "pump" : "helius"}`);
        err.status = res.status;
        err.retryAfter = res.headers.get("retry-after");
        err.isPump = isPump;
        throw err;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(`RPC ${label} error ${json.error.code}: ${json.error.message} @ ${isPump ? "pump" : "helius"}`);
        err.code = json.error.code;
        err.isPump = isPump;
        throw err;
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  const usePump = shouldTryPump();
  const primaryUrl = getGenericRpcUrl(true);
  const fallbackUrl = usePump ? getGenericRpcUrl(false) : null;

  return withRetry(
    async (attempt) => {
      if (usePump) {
        try {
          const result = await tryEndpoint(primaryUrl, true);
          log("rpc", `${label} via pump.ok`);
          return result;
        } catch (err) {
          // Some JSON-RPC errors are not transient; don't retry endlessly.
          const transient = err.status != null || /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|aborted/i.test(String(err.message));
          if (!transient) throw err;
          log("rpc_warn", `${label} pump failed (${err.message}) — falling back to key endpoint`);
          if (fallbackUrl) {
            try {
              const result = await tryEndpoint(fallbackUrl, false);
              log("rpc", `${label} via helius.ok (pump fallback)`);
              return result;
            } catch (err2) {
              throw err2;
            }
          }
          throw err;
        }
      }
      return tryEndpoint(primaryUrl, false);
    },
    {
      maxAttempts: usePump ? 3 : 4,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      retryOnStatus,
    },
  );
}

/**
 * Execute a premium Helius API request with automatic key rotation.
 *
 * @param {(key: string) => Promise<Response>} fetchFn - receives a Helius API key and returns a fetch Response
 * @param {object} opts
 * @returns {Promise<any>}
 */
async function withPremiumKeyRotation(fetchFn, opts = {}) {
  const manager = getHeliusKeyManager();
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts || 5, manager.count || 1));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const key = manager.nextKey();
    try {
      const res = await fetchFn(key);
      if (!res.ok) {
        const err = new Error(`Helius API ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.retryAfter = res.headers.get("retry-after");
        throw err;
      }
      markHeliusSuccess(key);
      return res;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      if (status === 429) {
        markHeliusRateLimited(key, Number(error?.retryAfter));
      } else if ([500, 502, 503, 504].includes(status) || /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(String(error?.message))) {
        markHeliusFailed(key);
      } else {
        // Non-retryable error (400/401/etc.) — don't burn more keys.
        throw error;
      }
      if (attempt < maxAttempts) {
        log("rpc_warn", `Helius attempt ${attempt}/${maxAttempts} failed with key ${key.slice(0, 4)}…${key.slice(-4)}: ${error.message}`);
        await sleep(Math.min(2000 * attempt, 10_000));
      }
    }
  }
  throw lastError || new Error("Helius request failed after key rotation");
}

/**
 * Call the Helius *premium* RPC/API. Use this for Enhanced Transactions, webhooks,
 * or any method that requires the authenticated Helius endpoint.
 *
 * The path should be relative, e.g. "/v0/addresses/{addr}/transactions".
 * Query params are merged with the api-key automatically.
 */
export async function heliusApiGet(path, query = {}, opts = {}) {
  const urlForKey = (key) => {
    const url = new URL(path, PREMIUM_BASE);
    url.searchParams.set("api-key", key);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  };

  const res = await withPremiumKeyRotation((key) => fetch(urlForKey(key)), opts);
  return res.json();
}

export async function heliusApiPost(path, payload, query = {}, opts = {}) {
  const urlForKey = (key) => {
    const url = new URL(path, PREMIUM_BASE);
    url.searchParams.set("api-key", key);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  };

  const res = await withPremiumKeyRotation(
    (key) =>
      fetch(urlForKey(key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    opts,
  );
  return res.json();
}

/**
 * Batch multiple RPC calls in one HTTP request. Useful for account reads.
 * Falls back to individual calls if the batch is rejected.
 */
export async function rpcBatch(calls, opts = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params ?? [] }));
  const url = getGenericRpcUrl(shouldTryPump());

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30_000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`RPC batch ${res.status} ${res.statusText}`);
    const json = await res.json();
    return Array.isArray(json) ? json.sort((a, b) => a.id - b.id).map((r) => r.result ?? r.error) : [];
  } catch (err) {
    if (calls.length === 1) throw err;
    log("rpc_warn", `batch failed (${err.message}), falling back to serial calls`);
    const results = [];
    for (const c of calls) {
      try {
        results.push(await rpcCall(c.method, c.params ?? [], opts));
      } catch (e) {
        results.push(e);
      }
    }
    return results;
  }
}

/**
 * Simple health check against the generic RPC endpoint(s).
 * Returns the first endpoint that answers `getHealth` successfully.
 */
export async function rpcHealthCheck() {
  const pumpUrl = getGenericRpcUrl(true);
  const keyUrl = getGenericRpcUrl(false);
  for (const [name, url] of [["pump", pumpUrl], ["helius", keyUrl]]) {
    try {
      const result = await rpcCall("getHealth", [], { timeoutMs: 10_000 });
      if (result === "ok") return { ok: true, endpoint: name, url };
    } catch (err) {
      log("rpc_warn", `${name} health check failed: ${err.message}`);
    }
  }
  return { ok: false, endpoint: null, url: null };
}
