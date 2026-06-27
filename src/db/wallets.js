import { getDb } from "./index.js";

const now = () => Math.floor(Date.now() / 1000);

/**
 * Insert a wallet as 'candidate' if it is new (preserving nothing to overwrite),
 * then touch last_active regardless. Returns the row and whether it was newly created.
 */
export function upsertWallet({ address, source = "manual", discovered_from = null, alias = null }) {
  const db = getDb();
  const ts = now();
  const info = db.prepare(
    `INSERT OR IGNORE INTO wallets (address, alias, source, discovered_from, first_seen, last_active, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
  ).run(address, alias, source, discovered_from, ts, ts, ts, ts);
  db.prepare(`UPDATE wallets SET last_active = ?, updated_at = ? WHERE address = ?`).run(ts, ts, address);
  return { row: getWallet(address), isNew: info.changes > 0 };
}

/** Record a discovery event (provenance). */
export function logDiscovery({ wallet_address, discovery_source, source_detail }) {
  getDb().prepare(
    `INSERT INTO wallet_discovery_log (wallet_address, discovery_source, source_detail)
     VALUES (?, ?, ?)`,
  ).run(wallet_address, discovery_source, source_detail);
}

export function getWallet(address) {
  return getDb().prepare(`SELECT * FROM wallets WHERE address = ?`).get(address);
}

/**
 * List wallets with optional filters. `notEvaluatedSince` is a unix-seconds cutoff
 * (only wallets never evaluated, or last evaluated before it) — used by re-evaluation.
 */
export function listWallets({ status, is_top_wallet, notEvaluatedSince, limit = 100 } = {}) {
  const db = getDb();
  const where = [];
  const params = {};
  if (status) {
    where.push("status = @status");
    params.status = status;
  }
  if (is_top_wallet !== undefined) {
    where.push("is_top_wallet = @itw");
    params.itw = is_top_wallet ? 1 : 0;
  }
  if (notEvaluatedSince !== undefined) {
    where.push("(last_evaluated IS NULL OR last_evaluated < @since)");
    params.since = notEvaluatedSince;
  }
  params.limit = limit;
  const sql = `SELECT * FROM wallets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score DESC LIMIT @limit`;
  return db.prepare(sql).all(params);
}

/** Persist aggregate performance metrics + computed score + tags. */
export function updateWalletMetrics(address, metrics) {
  getDb().prepare(
    `UPDATE wallets SET
       total_positions = @total_positions, win_count = @win_count, loss_count = @loss_count,
       win_rate = @win_rate, total_pnl_usd = @total_pnl_usd, total_fees_usd = @total_fees_usd,
       avg_fee_yield = @avg_fee_yield, avg_duration_hours = @avg_duration_hours,
       score = @score, score_updated = @score_updated,
       tags = @tags, open_positions = @open_positions, pool_count = @pool_count,
       last_active_position_at = @last_active_position_at, updated_at = @updated_at
     WHERE address = @address`,
  ).run({
    total_positions: metrics.total_positions ?? 0,
    win_count: metrics.win_count ?? 0,
    loss_count: metrics.loss_count ?? 0,
    win_rate: metrics.win_rate ?? 0,
    total_pnl_usd: metrics.total_pnl_usd ?? 0,
    total_fees_usd: metrics.total_fees_usd ?? 0,
    avg_fee_yield: metrics.avg_fee_yield ?? 0,
    avg_duration_hours: metrics.avg_duration_hours ?? 0,
    score: metrics.score ?? 0,
    score_updated: now(),
    tags: metrics.tags ? JSON.stringify(metrics.tags) : null,
    open_positions: metrics.open_positions ?? 0,
    pool_count: metrics.pool_count ?? 0,
    last_active_position_at: metrics.last_active_position_at ?? null,
    updated_at: now(),
    address,
  });
}

/** Set tier/status. Top promotion is handled by Phase 5 wallet-filter; here is_tracked/top default off. */
export function setWalletTier(address, { status, is_tracked = false, is_top_wallet = false, reject_reason = null }) {
  getDb().prepare(
    `UPDATE wallets SET status = ?, is_tracked = ?, is_top_wallet = ?, reject_reason = ?, updated_at = ? WHERE address = ?`,
  ).run(status, is_tracked ? 1 : 0, is_top_wallet ? 1 : 0, reject_reason, now(), address);
}

/** Increment evaluation_count + set last_evaluated. */
export function bumpEvaluation(address) {
  getDb().prepare(
    `UPDATE wallets SET evaluation_count = evaluation_count + 1, last_evaluated = ?, updated_at = ? WHERE address = ?`,
  ).run(now(), now(), address);
}

/** Persist LPAgent-derived LP strategy tags (preferred strategy + range style). */
export function updateWalletStrategy(address, { preferred_strategy, preferred_range_style }) {
  getDb().prepare(
    `UPDATE wallets SET preferred_strategy = ?, preferred_range_style = ?, updated_at = ? WHERE address = ?`,
  ).run(preferred_strategy ?? null, preferred_range_style ?? null, now(), address);
}
