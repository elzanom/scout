import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { withHeliusRetry } from "../utils/retry.js";
import { discoverPools } from "../screener/pool-screener.js";
import { upsertWallet, logDiscovery } from "../db/wallets.js";

// Agent Meridian (public API wrapper around LPAgent analytics). No account required.
const AGENT_MERIDIAN_API = process.env.AGENT_MERIDIAN_API_URL || "https://api.agentmeridian.xyz/api";
const AGENT_MERIDIAN_PUBLIC_KEY = process.env.PUBLIC_API_KEY || "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

// Cache + circuit-breaker tuning.
const CACHE_TTL_MS = 15 * 60 * 1000;       // 15 minutes
const CIRCUIT_OPEN_MS = 10 * 60 * 1000;    // 10 minutes
const CIRCUIT_FAILURE_THRESHOLD = 3;       // consecutive failures before opening

// Global rate limiter: max concurrent in-flight requests to Agent Meridian.
// Their upstream is flaky under burst; keep this low (default 2) with a small
// delay between dispatches to avoid thundering-herd 500s.
const AM_MAX_IN_FLIGHT = Math.max(1, Number(process.env.AGENT_MERIDIAN_MAX_IN_FLIGHT) || 2);
const AM_DISPATCH_DELAY_MS = Math.max(0, Number(process.env.AGENT_MERIDIAN_DISPATCH_DELAY_MS) || 150);

const cache = new Map();
const failures = new Map();
const circuitOpenUntil = new Map();
const hardFailedPools = new Set();         // pools that returned 5xx >= threshold; skipped entirely
let inFlight = 0;
const dispatchQueue = [];

/** Cache key for a studyTopLPers call. */
function cacheKey(pool, limit) {
  return `${pool}:${limit}`;
}

/** Is the circuit open (tripped) for this pool? */
function isCircuitOpen(pool) {
  const until = circuitOpenUntil.get(pool);
  if (!until) return false;
  if (Date.now() >= until) {
    circuitOpenUntil.delete(pool);
    failures.delete(pool);
    return false;
  }
  return true;
}

/** Record a failure; trip the circuit when threshold is crossed. */
function recordFailure(pool, err) {
  const count = (failures.get(pool) || 0) + 1;
  failures.set(pool, count);
  if (count >= CIRCUIT_FAILURE_THRESHOLD) {
    const until = Date.now() + CIRCUIT_OPEN_MS;
    circuitOpenUntil.set(pool, until);
    hardFailedPools.add(pool);
    log("discovery_warn", `Agent Meridian circuit OPEN for ${pool.slice(0, 8)}… after ${count} failures (${err.message})`);
  }
}

/** Record a success; reset failure counter. */
function recordSuccess(pool) {
  failures.delete(pool);
}

/** True if this pool is permanently blacklisted from study calls. */
export function isPoolStudyBlacklisted(pool) {
  return hardFailedPools.has(pool);
}

/** Enqueue a thunk through a global concurrency limiter + small dispatch delay. */
async function limited(fn) {
  if (inFlight < AM_MAX_IN_FLIGHT) {
    inFlight += 1;
    try {
      await sleep(AM_DISPATCH_DELAY_MS);
      return await fn();
    } finally {
      inFlight -= 1;
      if (dispatchQueue.length) {
        const next = dispatchQueue.shift();
        limited(next.fn).then(next.resolve).catch(next.reject);
      }
    }
  }
  return new Promise((resolve, reject) => {
    dispatchQueue.push({ fn, resolve, reject });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET one Agent Meridian path with retry + global concurrency gate. */
async function lpGet(path) {
  return limited(() => withHeliusRetry(async () => {
    const res = await fetch(`${AGENT_MERIDIAN_API}${path}`, { headers: { "x-api-key": AGENT_MERIDIAN_PUBLIC_KEY } });
    if (!res.ok) {
      const e = new Error(res.status === 429
        ? "Rate limit exceeded. Please wait 60 seconds before studying this pool again."
        : `Agent Meridian ${path} ${res.status}`);
      e.status = res.status;
      e.retryAfter = res.headers.get("retry-after");
      throw e;
    }
    return res.json();
  }));
}

/** Map an Agent Meridian topPosition into scout's positions-row shape. */
function mapPosition(p, poolAddress) {
  const entry = p.createdAt ? Math.floor(Date.parse(p.createdAt) / 1000) : null;
  const exit = p.closedAt ? Math.floor(Date.parse(p.closedAt) / 1000) : null;
  return {
    id: p.position || `${p.owner}_${poolAddress}_${entry || 0}`,
    wallet_address: p.owner,
    pool_address: poolAddress,
    token_pair: p.pairName,
    token_x_mint: null,
    token_y_mint: null,
    entry_timestamp: entry,
    exit_timestamp: exit,
    bin_lower: p.lowerBinId ?? null,
    bin_upper: p.upperBinId ?? null,
    bin_range_width: p.widthBins ?? null,
    capital_usd: p.inputValue ?? null,
    fees_earned_usd: p.feeUsd ?? null,
    pnl_usd: p.pnlUsd ?? null,
    pnl_pct: p.pnlPct ?? null,
    fee_yield: p.feePercent ?? null,
    duration_hours: entry && exit ? (exit - entry) / 3600 : null,
    is_profitable: p.pnlUsd != null ? (p.pnlUsd > 0 ? 1 : 0) : null,
    status: p.closedAt ? "closed" : "open",
  };
}

/**
 * Study a pool's top LPers via Agent Meridian. Returns a scout-shaped owner list, each with an
 * `aggregate` (from /top-lp, covers top-20) and `positions` (from /top-lp historicalOwners,
 * covers top-3 historical owners). Ported from meridian tools/study.js.
 *
 * Results are cached for `CACHE_TTL_MS`. A per-pool circuit breaker trips after
 * `CIRCUIT_FAILURE_THRESHOLD` consecutive failures and stays open for `CIRCUIT_OPEN_MS`,
 * returning the last cached result if available.
 *
 * @param {{ pool_address: string, limit?: number, bypassCache?: boolean }} args
 * @returns {Promise<{ pool: string, pool_name: string|null, overview: object, owners: Array }>}
 */
export async function studyTopLPers({ pool_address, limit = 20, bypassCache = false } = {}) {
  if (!pool_address) throw new Error("pool_address required");
  const key = cacheKey(pool_address, limit);
  const cached = cache.get(key);

  if (!bypassCache && cached && Date.now() < cached.expiresAt) {
    log("discovery", `studyTopLPers ${pool_address.slice(0, 8)}… cache hit`);
    return cached.value;
  }

  if (hardFailedPools.has(pool_address)) {
    if (cached) {
      log("discovery_warn", `studyTopLPers ${pool_address.slice(0, 8)}… hard-failed pool, serving stale cache`);
      return cached.value;
    }
    const e = new Error(`Agent Meridian permanently skipped for ${pool_address}`);
    e.status = 503;
    throw e;
  }

  if (isCircuitOpen(pool_address)) {
    if (cached) {
      log("discovery_warn", `studyTopLPers ${pool_address.slice(0, 8)}… circuit open, serving stale cache`);
      return cached.value;
    }
    const e = new Error(`Agent Meridian circuit open for ${pool_address}`);
    e.status = 503;
    throw e;
  }

  try {
    const poolData = await lpGet(`/top-lp/${pool_address}`);

    const topLpers = Array.isArray(poolData?.topLpers) ? poolData.topLpers : [];
    const histMap = new Map(
      (Array.isArray(poolData?.historicalOwners) ? poolData.historicalOwners : [])
        .map((o) => [o.owner, o]),
    );

    const owners = topLpers.slice(0, Math.max(1, limit)).map((tl) => {
      const h = histMap.get(tl.owner);
      return {
        address: tl.owner,
        aggregate: {
          total_pnl_usd: tl.totalPnlUsd,
          total_fees_usd: tl.totalFeeUsd,
          fee_percent: tl.feePercent,
          roi_pct: tl.roiPct,
          apr_pct: tl.aprPct,
          total_positions: tl.totalLp,
          avg_age_hours: tl.avgAgeHours,
          pnl_per_inflow_pct: tl.pnlPerInflowPct,
          win_rate_pct: tl.winRatePct, // unreliable (often 0) — evaluator ignores for scoring
          first_activity: tl.firstActivity,
          last_activity: tl.lastActivity,
          avg_pnl_pct: h?.avgPnlPct,
          avg_fee_percent: h?.avgFeePercent,
          avg_hold_hours: h?.avgHoldHours,
          preferred_strategy: h?.preferredStrategy,
          preferred_range_style: h?.preferredRangeStyle,
        },
        positions: Array.isArray(h?.topPositions) ? h.topPositions.map((p) => mapPosition(p, pool_address)) : [],
      };
    });

    const result = {
      pool: pool_address,
      pool_name: poolData?.overview?.name || null,
      overview: poolData?.overview || {},
      owners,
    };

    cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    recordSuccess(pool_address);
    return result;
  } catch (err) {
    recordFailure(pool_address, err);
    if (cached) {
      log("discovery_warn", `studyTopLPers ${pool_address.slice(0, 8)}… failed (${err.message}), serving stale cache`);
      return cached.value;
    }
    throw err;
  }
}

/** Run `concurrency` async fns over items, preserving order of completion. */
export async function runConcurrent(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** Study a list of screened pools and insert their top LPers as candidates into `acc`. */
async function studyAndCollect(pools, { ownerLimit, concurrency }, acc) {
  await runConcurrent(pools, concurrency, async (pool) => {
    try {
      const studied = await studyTopLPers({ pool_address: pool.pool, limit: ownerLimit, bypassCache: false });
      acc.studiedPools.push({ pool: pool.pool, name: pool.name, owners: studied.owners.length });
      acc.studiedOwners += studied.owners.length;
      for (const owner of studied.owners) {
        if (!owner.address) continue;
        const { isNew } = upsertWallet({
          address: owner.address,
          source: "pool_discovery",
          discovered_from: pool.pool,
        });
        if (isNew) {
          logDiscovery({ wallet_address: owner.address, discovery_source: "pool_discovery", source_detail: pool.pool });
          acc.newCandidates++;
          acc.newWallets.add(owner.address);
        }
      }
    } catch (err) {
      acc.errors.push({ pool: pool.pool, error: err.message });
      log("discovery_warn", `studyTopLPers ${pool.pool?.slice(0, 8)} failed: ${err.message}`);
    }
  });
}

/**
 * Discovery cycle, two passes:
 *  1. trending — small/mid trending pools (default screening; signal use-case).
 *  2. established — high-TVL/blue-chip pools (where elite, high-WR LPs sit), via a screening
 *     override. Disabled if config.discovery.establishedEnabled is false.
 * Each pass: discoverPools → study top LPers → insert new candidates.
 *
 * @param {{ poolLimit?: number, ownerLimit?: number, concurrency?: number }} opts
 */
export async function runPoolDiscovery({ poolLimit = 10, ownerLimit = 20, concurrency = 2 } = {}) {
  const acc = { studiedOwners: 0, newCandidates: 0, studiedPools: [], newWallets: new Set(), errors: [] };
  const allPassedPools = [];

  const passes = [{ name: "trending", screening: undefined, limit: poolLimit }];
  if (config.discovery.establishedEnabled) {
    passes.push({
      name: "established",
      screening: {
        minTvl: config.discovery.establishedMinTvl,
        maxTvl: config.discovery.establishedMaxTvl,
        maxMcap: config.discovery.establishedMaxMcap,
      },
      limit: poolLimit,
    });
  }

  for (const pass of passes) {
    let pools = [];
    try {
      const r = await discoverPools({ page_size: Math.max(pass.limit, 20), screening: pass.screening });
      pools = r.pools.slice(0, pass.limit);
      allPassedPools.push(...pools);
    } catch (err) {
      log("discovery_warn", `${pass.name} discoverPools failed: ${err.message}`);
      continue;
    }
    log("discovery", `${pass.name} pass: studying ${pools.length} pool(s)`);
    await studyAndCollect(pools, { ownerLimit, concurrency: Math.min(concurrency, 2) }, acc);
  }

  log("discovery", `pool-discovery done: ${acc.newCandidates} new candidate(s) from ${acc.studiedOwners} studied owner(s)`);
  return {
    studied_owners: acc.studiedOwners,
    new_candidates: acc.newCandidates,
    passed_pools: allPassedPools,
    studied_pools: acc.studiedPools,
    new_wallets: [...acc.newWallets],
    errors: acc.errors,
  };
}
