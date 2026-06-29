import { getDb } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

const COLS = [
  "mint", "symbol", "launchpad", "graduated", "graduated_at", "holder_count", "organic_score",
  "is_verified", "created_at", "fdv", "mcap", "dev", "circ_supply", "total_supply", "price_usd",
  "audit", "tags", "bundler_rate", "is_honeypot", "rug_ratio", "top10_holder_rate", "renounced_mint",
  "renounced_freeze", "creator_holding_pct", "source", "fetched_at",
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const scalar = (v) => {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
};

/** Upsert token metadata + security (Jupiter primary; Birdeye/GMGN gated). */
export function upsertTokenInfo(info) {
  const sets = COLS.filter((c) => c !== "mint").map((c) => `${c} = @${c}`).join(", ");
  const row = {
    mint: info.mint,
    symbol: info.symbol ?? null,
    launchpad: info.launchpad ?? null,
    graduated: scalar(info.graduated),
    graduated_at: num(info.graduated_at),
    holder_count: num(info.holder_count),
    organic_score: num(info.organic_score),
    is_verified: scalar(info.is_verified),
    created_at: num(info.created_at),
    fdv: num(info.fdv),
    mcap: num(info.mcap),
    dev: info.dev ?? null,
    circ_supply: num(info.circ_supply),
    total_supply: num(info.total_supply),
    price_usd: num(info.price_usd),
    audit: info.audit ?? null,
    tags: info.tags ?? null,
    bundler_rate: num(info.bundler_rate),
    is_honeypot: scalar(info.is_honeypot),
    rug_ratio: num(info.rug_ratio),
    top10_holder_rate: num(info.top10_holder_rate),
    renounced_mint: scalar(info.renounced_mint),
    renounced_freeze: scalar(info.renounced_freeze),
    creator_holding_pct: num(info.creator_holding_pct),
    source: info.source ?? null,
    fetched_at: info.fetched_at ?? now(),
  };
  getDb().prepare(
    `INSERT INTO token_info (${COLS.join(", ")}) VALUES (@${COLS.join(", @")})
     ON CONFLICT(mint) DO UPDATE SET ${sets}`,
  ).run(row);
}

export function getTokenInfo(mint) {
  return getDb().prepare(`SELECT * FROM token_info WHERE mint = ?`).get(mint);
}

/** Mints known from snapshots that are stale (or not yet enriched), for the refresh cycle. */
export function listStaleMints({ maxAgeSec, limit = 100 } = {}) {
  const cutoff = maxAgeSec != null ? now() - maxAgeSec : 0;
  return getDb().prepare(
    `SELECT DISTINCT s.base_mint AS mint FROM market_snapshots s
     LEFT JOIN token_info t ON t.mint = s.base_mint
     WHERE s.base_mint IS NOT NULL AND (t.mint IS NULL OR t.fetched_at < ?)
     LIMIT ?`,
  ).all(cutoff, limit).map((r) => r.mint);
}

export function tokenInfoCount() {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM token_info`).get().c;
}

/**
 * Build a readable token pair like "TOKEN/SOL" from stored mints + token_info symbols.
 * Falls back to shortened mint addresses if symbols are unknown.
 * @param {{ token_x_mint?: string, token_y_mint?: string, token_pair?: string }} pos
 * @returns {string}
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** True if `s` looks like a Solana base58 mint address (32-44 chars, no spaces). */
function looksLikeMint(s) {
  if (!s) return false;
  if (/\s/.test(s)) return false;
  return s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

export function formatTokenPair(pos) {
  if (!pos) return "";
  const rawPair = String(pos.token_pair || "");

  // If the stored token_pair already looks like readable symbols, prefer it.
  const rawParts = rawPair.split("/");
  if (rawParts.length === 2 && !looksLikeMint(rawParts[0]) && !looksLikeMint(rawParts[1])) {
    return rawPair;
  }

  let xMint = pos.token_x_mint || "";
  let yMint = pos.token_y_mint || "";

  // Fallback: parse legacy token_pair like "mintX/mintY".
  if ((!xMint || !yMint) && rawParts.length === 2) {
    if (!xMint) xMint = rawParts[0];
    if (!yMint) yMint = rawParts[1];
  }

  if (!xMint && !yMint) return rawPair;

  const shorten = (m) => (m ? `${m.slice(0, 4)}…${m.slice(-4)}` : "?");
  const resolve = (m) => {
    if (!m) return "?";
    if (!looksLikeMint(m)) return m; // already a symbol
    if (m === SOL_MINT) return "SOL";
    const info = getTokenInfo(m);
    return info?.symbol || shorten(m);
  };
  return `${resolve(xMint)}/${resolve(yMint)}`;
}
