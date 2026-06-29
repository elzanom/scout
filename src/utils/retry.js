import { log } from "./logger.js";

/** Promise-based delay. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status, retryOnStatus) {
  return retryOnStatus.includes(Number(status));
}

function isNetworkError(error) {
  if (!error) return false;
  const msg = String(error.message || error.code || "");
  return /^(ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up|aborted)/i.test(msg);
}

function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250); // 0..250ms to decorrelate parallel retries
  return Math.min(maxDelayMs, exp + jitter);
}

/**
 * Run `fn` with exponential-backoff retry. The callback receives the 1-based attempt
 * number so it can adapt (e.g. pagination). Retries when the thrown error carries a
 * `.status` in `retryOnStatus`, or looks like a transient network error. Any other
 * error rejects immediately (no point retrying a 400).
 *
 * Errors may carry `.retryAfter` (seconds) to override the computed backoff downward/up.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} opts
 * @param {number} [opts.maxAttempts=4]
 * @param {number} [opts.baseDelayMs=500]
 * @param {number} [opts.maxDelayMs=30000]
 * @param {number[]} [opts.retryOnStatus=[429,500,502,503,504]]
 * @param {(err: Error, attempt: number, waitMs: number) => void} [opts.onRetry]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 4,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    retryOnStatus = [429, 500, 502, 503, 504],
    onRetry,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      const retryable = isRetryableStatus(status, retryOnStatus)
        || (status == null && isNetworkError(error));
      const isLast = attempt >= maxAttempts;
      if (!retryable || isLast) throw error;

      let waitMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      // Honor Retry-After (seconds) header when present, as a hard floor.
      const retryAfter = Number(error?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = Math.min(maxDelayMs, Math.max(waitMs, retryAfter * 1000));
      }
      if (typeof onRetry === "function") onRetry(error, attempt, waitMs);
      log("warn", `retry ${attempt + 1}/${maxAttempts} after ${waitMs}ms: ${error?.status ?? "net"} ${error?.message || ""}`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * Helius / Agent Meridian-aware retry. On HTTP 429 — or the Agent Meridian rate-limit message
 * ("Rate limit exceeded. Please wait 60 seconds …") — it tags the error with
 * `retryAfter = 60` so the underlying `withRetry` backs off at least 60 seconds,
 * matching meridian's behavior (tools/study.js).
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} [opts] forwarded to withRetry (sensible Helius defaults)
 */
export async function withHeliusRetry(fn, opts = {}) {
  const wrapped = async (attempt) => {
    try {
      return await fn(attempt);
    } catch (error) {
      const msg = String(error?.message || "");
      const rateLimited = Number(error?.status) === 429 || /wait 60 seconds|rate limit/i.test(msg);
      if (rateLimited && !Number.isFinite(Number(error?.retryAfter))) {
        error.retryAfter = 60;
        error.status = Number(error.status) || 429;
      }
      throw error;
    }
  };
  return withRetry(wrapped, {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 90_000,
    ...opts,
  });
}
