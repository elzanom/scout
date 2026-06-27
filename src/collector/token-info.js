import { randomUUID } from "node:crypto";
import { log } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { config } from "../../config/config.js";
import { upsertTokenInfo } from "../db/token-info.js";

const JUP_DATAPI = "https://datapi.jup.ag/v1";
const BIRDEYE = "https://public-api.birdeye.so/defi";
const GMGN = "https://openapi.gmgn.ai";

// Disable keyed sources after persistent auth failure (until restart) to avoid 401 spam.
let birdeyeOk = true;
let gmgnOk = !!process.env.GMGN_API_KEY;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const toUnixSec = (v) => {
  const n = v ? Date.parse(v) : null;
  return Number.isFinite(n) ? Math.floor(n / 1000) : num(v) ? Number(v) : null;
};

/** Jupiter (free, no key) — primary metadata: launchpad, graduation, holders, age, audit. */
async function fetchJupiter(mint) {
  return withRetry(async () => {
    const res = await fetch(`${JUP_DATAPI}/assets/search?query=${encodeURIComponent(mint)}`);
    if (!res.ok) { const e = new Error(`jupiter ${res.status}`); e.status = res.status; throw e; }
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];
    return arr.find((a) => a?.id === mint) || arr[0] || null;
  });
}

/** Birdeye (gated by BIRDEYE_API_KEY) — token overview + security. Null if no/invalid key. */
async function fetchBirdeye(mint) {
  if (!birdeyeOk || !config.env.birdeyeApiKey) return null;
  try {
    return await withRetry(async () => {
      const res = await fetch(`${BIRDEYE}/token_overview?address=${mint}&chain=solana`, {
        headers: { "x-api-key": config.env.birdeyeApiKey },
      });
      if (res.status === 401) { birdeyeOk = false; log("tokeninfo_warn", "Birdeye 401 — key invalid, disabling for this run"); return null; }
      if (!res.ok) { const e = new Error(`birdeye ${res.status}`); e.status = res.status; throw e; }
      const d = await res.json();
      return d?.data || d || null;
    });
  } catch (e) { log("tokeninfo_warn", `Birdeye ${mint.slice(0, 8)}: ${e.message}`); return null; }
}

/**
 * GMGN (gated by GMGN_API_KEY) — token info + security/risk.
 * Endpoint: /v1/token/info?chain=sol&address={mint} (NOT path-param, that's 404).
 * Auth: X-APIKEY header + client_id (random UUID) + timestamp query params required;
 * without client_id the gateway returns 401 "missing api key or client_id".
 * Returns nested { stat:{bundler/top10/rug/sniper/...rates}, wallet_tags_stat:{bundler_wallets,...},
 *   dev:{creator_address,...}, launchpad, launchpad_status, migrated_timestamp, ... }.
 * Birdeye is used for mcap/fdv/security-when-allowed; GMGN for launchpad, dev, wallet tags, risk rates.
 */
async function fetchGmgn(mint) {
  if (!gmgnOk) return null;
  try {
    return await withRetry(async () => {
      const url = `${GMGN}/v1/token/info?chain=sol&address=${mint}` +
        `&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${randomUUID()}`;
      const res = await fetch(url, {
        headers: { "X-APIKEY": process.env.GMGN_API_KEY, "Content-Type": "application/json" },
      });
      if (res.status === 401 || res.status === 403) { gmgnOk = false; log("tokeninfo_warn", `GMGN ${res.status} — key issue, disabling`); return null; }
      if (!res.ok) { const e = new Error(`gmgn ${res.status}`); e.status = res.status; throw e; }
      const j = await res.json();
      return j?.data || j || null;
    });
  } catch (e) { log("tokeninfo_warn", `GMGN ${mint.slice(0, 8)}: ${e.message}`); return null; }
}

/**
 * Enrich token_info for a mint from all available sources (Jupiter always; Birdeye + GMGN when
 * valid keys present). Field sourcing:
 *   - Birdeye token_overview: market data (mcap, fdv, holder, supplies) — reliable.
 *   - Jupiter: identity + audit (launchpad, organicScore, dev, tags, createdAt).
 *   - GMGN /v1/token/info: launchpad + graduated + dev + wallet_tags_stat + stat.{bundler,
 *     top10, entrapment, sniper, dev_team, fresh, bot_degen} + fee_distribution.is_locked.
 * Risk cols (is_honeypot, renounced_mint, renounced_freeze) stay null without Birdeye premium
 * (the user's plan tier blocks /defi/token_security).
 */
export async function enrichTokenInfo(mint) {
  if (!mint) return null;

  let j = null;
  try { j = await fetchJupiter(mint); } catch (e) { log("tokeninfo_warn", `jupiter ${mint.slice(0, 8)}: ${e.message}`); }
  const [b, g] = await Promise.all([fetchBirdeye(mint), fetchGmgn(mint)]);

  const stat = g?.stat || {};
  const wts = g?.wallet_tags_stat || {};
  const devObj = g?.dev || {};
  const feeDist = g?.fee_distribution?.platform_data || {};

  // Creator concentration: dev.creator_token_balance / total_supply (best-effort proxy for top1
  // holder when creator still holds; 0 when sold/closed). null when GMGN data insufficient.
  const creatorBal = num(devObj.creator_token_balance);
  const totalSupGmgn = num(g?.total_supply);
  const creatorHoldingPct = creatorBal != null && totalSupGmgn != null && totalSupGmgn > 0
    ? creatorBal / totalSupGmgn
    : null;

  // GMGN uses "migrated" for pump.fun bonding-curve graduation (launchpad_status field).
  const gmgnGraduated = g?.launchpad_status === "migrated" ? 1 : null;

  const info = {
    mint,
    symbol: j?.symbol || g?.symbol || b?.symbol || null,
    launchpad: j?.launchpad || g?.launchpad || g?.launchpad_platform || null,
    graduated: gmgnGraduated ?? (j?.graduatedPool || j?.graduatedAt ? 1 : null),
    graduated_at: toUnixSec(g?.migrated_timestamp) ?? toUnixSec(j?.graduatedAt),
    holder_count: num(stat.holder_count) ?? num(g?.holder_count) ?? num(j?.holderCount) ?? num(b?.holder) ?? null,
    organic_score: num(j?.organicScore) ?? null,
    is_verified: j?.isVerified ? 1 : null,
    created_at: toUnixSec(g?.creation_timestamp) ?? toUnixSec(g?.open_timestamp) ?? toUnixSec(j?.createdAt),
    fdv: num(j?.fdv) ?? num(g?.fdv) ?? num(b?.fdv) ?? null,
    mcap: num(j?.mcap) ?? num(g?.mcap) ?? num(b?.marketCap) ?? null,
    dev: devObj.creator_address || j?.dev || null,
    circ_supply: num(j?.circSupply) ?? num(g?.circulating_supply) ?? num(b?.circulatingSupply) ?? null,
    total_supply: num(j?.totalSupply) ?? num(g?.total_supply) ?? num(b?.totalSupply) ?? null,
    audit: JSON.stringify({
      ...(j?.audit || {}),
      gmgn_stat: {
        bundler_rate: stat.top_bundler_trader_percentage,
        top10_holder_rate: stat.top_10_holder_rate,
        entrapment: stat.top_entrapment_trader_percentage,
        sniper_hold: stat.top70_sniper_hold_rate,
        bot_degen_rate: stat.bot_degen_rate,
        fresh_wallet_rate: stat.fresh_wallet_rate,
        dev_team_hold_rate: stat.dev_team_hold_rate,
        locked_ratio: g?.locked_ratio,
      },
      fee_locked: feeDist.is_locked,
    }),
    tags: JSON.stringify(wts),  // bundler_wallets, sniper_wallets, smart_wallets, renowned_wallets, ...
    // Risk metrics — from GMGN `stat` (percentages as strings, num() coerces):
    bundler_rate: num(stat.top_bundler_trader_percentage),
    is_honeypot: null,  // not exposed in GMGN /v1/token/info; needs Birdeye premium tier
    rug_ratio: num(stat.top_entrapment_trader_percentage),  // proxy: % of top entrapment traders
    top10_holder_rate: num(stat.top_10_holder_rate),
    renounced_mint: null,  // not exposed here; needs Birdeye premium tier
    renounced_freeze: feeDist.is_locked != null ? (feeDist.is_locked ? 1 : 0) : null,  // best-effort: fee authority locked
    creator_holding_pct: creatorHoldingPct,
    source: ["jupiter", b && "birdeye", g && "gmgn"].filter(Boolean).join("+"),
    fetched_at: Math.floor(Date.now() / 1000),
  };

  upsertTokenInfo(info);
  return info;
}

/** Whether the keyed sources are currently active (for logging). */
export function sourceStatus() {
  return { jupiter: true, birdeye: birdeyeOk && !!config.env.birdeyeApiKey, gmgn: gmgnOk };
}
