import { getDb } from "../db/index.js";

let cache = {
  startedAt: Math.floor(Date.now() / 1000),
  lastDiscoveryAt: null,
  lastScreeningAt: null,
  lastSnapshotAt: null,
  lastRankingAt: null,
  lastSignalAt: null,
  lastTokenInfoAt: null,
};

export function getStateCache() {
  let db;
  try {
    db = getDb();
  } catch {
    return { ...cache, dbReady: false };
  }

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM wallets) AS wallets,
      (SELECT COUNT(*) FROM wallets WHERE is_top_wallet = 1) AS top_wallets,
      (SELECT COUNT(*) FROM positions WHERE status = 'open') AS open_positions,
      (SELECT COUNT(*) FROM positions WHERE status = 'closed') AS closed_positions,
      (SELECT COUNT(*) FROM signals WHERE date(created_at, 'unixepoch') = date('now')) AS signals_today,
      (SELECT COUNT(*) FROM market_snapshots) AS snapshots,
      (SELECT COUNT(*) FROM token_info) AS token_info_rows,
      (SELECT MAX(timestamp) FROM market_snapshots) AS latest_snapshot_at,
      (SELECT pool_address FROM market_snapshots ORDER BY timestamp DESC LIMIT 1) AS latest_snapshot_pool
  `).get();

  return {
    ...cache,
    dbReady: true,
    wallets: counts.wallets ?? 0,
    topWallets: counts.top_wallets ?? 0,
    openPositions: counts.open_positions ?? 0,
    closedPositions: counts.closed_positions ?? 0,
    signalsToday: counts.signals_today ?? 0,
    snapshots: counts.snapshots ?? 0,
    tokenInfoRows: counts.token_info_rows ?? 0,
    latestSnapshotAt: counts.latest_snapshot_at ?? null,
    latestSnapshotPool: counts.latest_snapshot_pool ?? null,
  };
}

export function touchCycle(name) {
  const key = `last${name.charAt(0).toUpperCase()}${name.slice(1)}At`;
  cache[key] = Math.floor(Date.now() / 1000);
}

export function touchSignal() {
  cache.lastSignalAt = Math.floor(Date.now() / 1000);
}
