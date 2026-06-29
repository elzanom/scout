import { log } from "../utils/logger.js";
import { config } from "../../config/config.js";

/**
 * Rotating Helius API key manager.
 *
 * Helius free tier is aggressively rate-limited. Scout can be configured with multiple
 * keys and will rotate them round-robin, tracking transient failures and 429 rate-limits
 * per key. When a key is rate-limited, it is temporarily disabled; the next request uses
 * the next healthy key.
 *
 * Configuration options (in order of precedence):
 *
 *   1. HELIUS_API_KEY="key1,key2,key3"
 *   2. HELIUS_API_KEY_1, HELIUS_API_KEY_2, ... up to HELIUS_API_KEY_10
 *
 * If only one key is provided, the manager degrades gracefully to a pass-through.
 *
 * Backoff windows (configurable via env):
 *   - RATE_LIMIT_COOLDOWN_MS (default 60s) after a 429.
 *   - FAILURE_COOLDOWN_MS     (default 30s) after any other retryable failure.
 *   - MAX_FAILURES_PER_KEY    (default 5)   before a key is disabled until reset.
 */

const RATE_LIMIT_COOLDOWN_MS = config.env.rateLimitCooldownMs;
const FAILURE_COOLDOWN_MS = config.env.failureCooldownMs;
const MAX_FAILURES_PER_KEY = config.env.maxFailuresPerKey;

class HeliusKeyManager {
  constructor() {
    this.keys = this._loadKeys();
    this.index = 0;
    this.stats = new Map();
    for (const key of this.keys) {
      this.stats.set(key, { failures: 0, rateLimitedUntil: 0, failedUntil: 0, lastUsed: 0, successes: 0 });
    }
    if (this.keys.length === 0) {
      log("helius_keys_warn", "No HELIUS_API_KEY configured — premium Helius API calls will fail");
    } else {
      log("helius_keys", `Loaded ${this.keys.length} Helius API key(s)`);
    }
  }

  _loadKeys() {
    const raw = config.env.heliusApiKey;
    const keys = [];
    if (raw) {
      for (const part of raw.split(",")) {
        const k = part.trim();
        if (k && !keys.includes(k)) keys.push(k);
      }
    }
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`HELIUS_API_KEY_${i}`]?.trim();
      if (k && !keys.includes(k)) keys.push(k);
    }
    return keys;
  }

  /** Total keys available. */
  get count() {
    return this.keys.length;
  }

  /** All keys (masked for logging). */
  get summary() {
    return this.keys.map((k) => {
      const s = this.stats.get(k);
      return {
        prefix: `${k.slice(0, 4)}…${k.slice(-4)}`,
        healthy: this._isHealthy(k),
        failures: s.failures,
        successes: s.successes,
        rateLimitedUntil: s.rateLimitedUntil,
        failedUntil: s.failedUntil,
      };
    });
  }

  _isHealthy(key) {
    const s = this.stats.get(key);
    const now = Date.now();
    if (now < s.rateLimitedUntil) return false;
    if (now < s.failedUntil) return false;
    if (s.failures >= MAX_FAILURES_PER_KEY) return false;
    return true;
  }

  /**
   * Pick the next healthy key using round-robin.
   * Throws if no key is healthy.
   */
  nextKey() {
    if (this.keys.length === 0) throw new Error("No Helius API keys configured");

    let attempts = 0;
    while (attempts < this.keys.length) {
      const key = this.keys[this.index % this.keys.length];
      this.index = (this.index + 1) % this.keys.length;
      if (this._isHealthy(key)) {
        const s = this.stats.get(key);
        s.lastUsed = Date.now();
        return key;
      }
      attempts++;
    }

    // No healthy keys — try to reset anyone whose cooldown expired but hit max failures.
    const now = Date.now();
    for (const key of this.keys) {
      const s = this.stats.get(key);
      if (now >= s.rateLimitedUntil && now >= s.failedUntil) {
        s.failures = 0;
        s.lastUsed = Date.now();
        return key;
      }
    }

    throw new Error(`All ${this.keys.length} Helius API keys are unhealthy`);
  }

  /** Mark a key as rate-limited. */
  markRateLimited(key, retryAfterSeconds = null) {
    const s = this.stats.get(key);
    if (!s) return;
    const cooldown = retryAfterSeconds
      ? Math.min(Math.max(retryAfterSeconds * 1000, RATE_LIMIT_COOLDOWN_MS), 300_000)
      : RATE_LIMIT_COOLDOWN_MS;
    s.rateLimitedUntil = Date.now() + cooldown;
    s.failures++;
    log("helius_keys_warn", `Key ${this._mask(key)} rate-limited, cooling down ${cooldown}ms (failure ${s.failures}/${MAX_FAILURES_PER_KEY})`);
  }

  /** Mark a key as failed for a generic retryable reason. */
  markFailed(key) {
    const s = this.stats.get(key);
    if (!s) return;
    s.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
    s.failures++;
    log("helius_keys_warn", `Key ${this._mask(key)} failed, cooling down ${FAILURE_COOLDOWN_MS}ms (failure ${s.failures}/${MAX_FAILURES_PER_KEY})`);
  }

  /** Mark a key as successful. */
  markSuccess(key) {
    const s = this.stats.get(key);
    if (!s) return;
    s.successes++;
    if (s.failures > 0) s.failures = Math.max(0, s.failures - 1);
  }

  _mask(key) {
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }
}

const manager = new HeliusKeyManager();

/** Get the singleton key manager instance. */
export function getHeliusKeyManager() {
  return manager;
}

/** Get the next healthy API key. */
export function nextHeliusKey() {
  return manager.nextKey();
}

/** Mark the current key rate-limited. */
export function markHeliusRateLimited(key, retryAfterSeconds) {
  return manager.markRateLimited(key, retryAfterSeconds);
}

/** Mark the current key failed. */
export function markHeliusFailed(key) {
  return manager.markFailed(key);
}

/** Mark the current key successful. */
export function markHeliusSuccess(key) {
  return manager.markSuccess(key);
}
