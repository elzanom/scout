import { getDb } from "../db/index.js";

/** The current top-wallet whitelist (is_top_wallet=1), ranked by score. */
export function getTopWallets({ limit = 100 } = {}) {
  return getDb().prepare(
    `SELECT * FROM wallets WHERE is_top_wallet = 1 ORDER BY score DESC LIMIT ?`,
  ).all(limit);
}

/** Tracked wallets ranked by score (the candidate pool for top promotion). */
export function rankTrackedByScore({ limit = 100 } = {}) {
  return getDb().prepare(
    `SELECT * FROM wallets WHERE status = 'tracked' ORDER BY score DESC LIMIT ?`,
  ).all(limit);
}

/** Generic ranked list (any status, or all) by score — for dashboards / re-ranking. */
export function getRankedWallets({ status, limit = 100 } = {}) {
  if (status) {
    return getDb().prepare(
      `SELECT * FROM wallets WHERE status = ? ORDER BY score DESC LIMIT ?`,
    ).all(status, limit);
  }
  return getDb().prepare(`SELECT * FROM wallets ORDER BY score DESC LIMIT ?`).all(limit);
}

/** Count wallets grouped by status (quick tier census). */
export function tierCounts() {
  const rows = getDb().prepare(
    `SELECT status, COUNT(*) AS n FROM wallets GROUP BY status`,
  ).all();
  const out = {};
  for (const r of rows) out[r.status] = r.n;
  out.top = getDb().prepare(`SELECT COUNT(*) AS n FROM wallets WHERE is_top_wallet = 1`).get().n;
  return out;
}
