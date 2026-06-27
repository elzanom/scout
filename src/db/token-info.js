import { getDb } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

const COLS = [
  "mint", "symbol", "launchpad", "graduated", "graduated_at", "holder_count", "organic_score",
  "is_verified", "created_at", "fdv", "mcap", "dev", "circ_supply", "total_supply", "audit",
  "tags", "bundler_rate", "is_honeypot", "rug_ratio", "top10_holder_rate", "renounced_mint",
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
