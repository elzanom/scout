import { log } from "../utils/logger.js";

// better-sqlite3 PRAGMAs: WAL for concurrent readers while the writer runs,
// NORMAL sync for throughput (WAL keeps durability acceptable), FK enforcement,
// and a busy_timeout so short lock contention doesn't throw.
const PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "foreign_keys = ON",
  "busy_timeout = 5000",
];

const DDL = `
-- Candidate / tracked / top / rejected wallets (SPEC wallets)
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  alias TEXT,
  source TEXT,                 -- 'manual' | 'pool_discovery' | 'tx_mining' | 'follow_winner'
  discovered_from TEXT,        -- pool address or wallet address that led to discovery
  first_seen INTEGER,
  last_active INTEGER,
  total_positions INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  win_rate REAL DEFAULT 0,
  total_pnl_usd REAL DEFAULT 0,
  total_fees_usd REAL DEFAULT 0,
  avg_fee_yield REAL DEFAULT 0,
  avg_duration_hours REAL DEFAULT 0,
  score REAL DEFAULT 0,
  score_updated INTEGER,
  status TEXT DEFAULT 'candidate',   -- 'candidate' | 'tracked' | 'top' | 'rejected'
  is_tracked INTEGER DEFAULT 0,
  is_top_wallet INTEGER DEFAULT 0,
  evaluation_count INTEGER DEFAULT 0,
  last_evaluated INTEGER,
  reject_reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Provenance log: every time a wallet is discovered, from any source (SPEC wallet_discovery_log)
CREATE TABLE IF NOT EXISTS wallet_discovery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT,
  discovery_source TEXT,       -- 'pool_discovery' | 'tx_mining' | 'follow_winner' | 'manual'
  source_detail TEXT,          -- pool address, tx signature, or wallet referrer
  discovered_at INTEGER DEFAULT (unixepoch())
);

-- Reconstructed LP positions: entry -> exit (SPEC positions)
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,         -- {wallet}_{pool}_{entry_timestamp}
  wallet_address TEXT,
  pool_address TEXT,
  token_pair TEXT,             -- e.g. 'SOL/USDC'
  entry_timestamp INTEGER,
  entry_price REAL,
  bin_step INTEGER,
  bin_lower INTEGER,
  bin_upper INTEGER,
  bin_range_width REAL,
  amount_token_x REAL,
  amount_token_y REAL,
  capital_usd REAL,
  entry_tx TEXT,
  exit_timestamp INTEGER,
  exit_price REAL,
  exit_tx TEXT,
  fees_earned_usd REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  fee_yield REAL,
  duration_hours REAL,
  is_profitable INTEGER,
  close_reason TEXT,           -- 'manual' | 'oor' | 'stop_loss' | 'take_profit'
  status TEXT DEFAULT 'open',  -- 'open' | 'closed'
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (wallet_address) REFERENCES wallets(address)
);

-- Market context snapshots per pool per timestamp (SPEC market_snapshots)
CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT,
  timestamp INTEGER,
  fee_apr REAL,
  volume_24h REAL,
  tvl REAL,
  fee_tvl_ratio REAL,
  active_bin INTEGER,
  price REAL,
  token_price REAL,
  token_price_change_24h REAL,
  token_volatility_24h REAL,
  token_volume_24h REAL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Emitted signals (SPEC signals). validation_reasons stored as JSON-in-TEXT.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT,
  token_pair TEXT,
  trigger_type TEXT,           -- 'wallet_entry' | 'pool_metric'
  triggered_by TEXT,           -- wallet address or 'screener'
  wallet_score REAL,
  pool_score REAL,
  combined_confidence REAL,
  validation_reasons TEXT,     -- JSON array
  suggested_bin_step INTEGER,
  suggested_range_lower INTEGER,
  suggested_range_upper INTEGER,
  fee_apr REAL,
  volume_24h REAL,
  tvl REAL,
  status TEXT DEFAULT 'pending', -- 'pending' | 'sent' | 'expired' | 'rejected'
  created_at INTEGER DEFAULT (unixepoch())
);

-- Per-mint token metadata + security (mostly static): launchpad, graduation, audit, holders,
-- age, deployer + GMGN-style risk (bundler/honeypot/rug/top10/renounced). Cached here and
-- JOINed into the training dataset at export (refreshed periodically, not per-snapshot).
CREATE TABLE IF NOT EXISTS token_info (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  launchpad TEXT,
  graduated INTEGER,                 -- bonding curve graduated (pump.fun etc.)
  graduated_at INTEGER,
  holder_count INTEGER,
  organic_score REAL,
  is_verified INTEGER,
  created_at INTEGER,                -- token creation (unix sec)
  fdv REAL,
  mcap REAL,
  dev TEXT,                          -- deployer address
  circ_supply REAL,
  total_supply REAL,
  price_usd REAL,                    -- best-effort spot price from token_info source
  audit TEXT,                        -- JSON of audit flags
  tags TEXT,
  bundler_rate REAL,                 -- GMGN risk
  is_honeypot INTEGER,
  rug_ratio REAL,
  top10_holder_rate REAL,
  renounced_mint INTEGER,
  renounced_freeze INTEGER,
  creator_holding_pct REAL,          -- GMGN dev.creator_token_balance / total_supply (creator concentration)
  source TEXT,                       -- which source last populated (jupiter|birdeye|gmgn)
  fetched_at INTEGER
);

-- Labeled training records: features at entry -> outcome at close (SPEC record-builder,
-- no DDL given in SPEC; designed here from SPEC 594-607 label/feature fields).
CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT,
  wallet_address TEXT,
  pool_address TEXT,
  -- LABEL (what Laminar learns)
  was_profitable INTEGER,
  pnl_usd REAL,
  pnl_pct REAL,
  fee_earned_usd REAL,
  fee_yield REAL,
  duration_hours REAL,
  -- FEATURES (what was visible at entry)
  pool_fee_apr REAL,
  pool_volume_24h REAL,
  pool_tvl REAL,
  fee_tvl_ratio REAL,
  pool_bin_step INTEGER,
  token_pair TEXT,
  token_volatility_24h REAL,
  token_price_change_24h REAL,
  volume_vs_7d_avg REAL,
  days_since_pool_created REAL,
  bin_range_width REAL,
  capital_usd REAL,
  wallet_score_at_entry REAL,
  wallet_wr_at_entry REAL,
  hour_of_day INTEGER,
  day_of_week INTEGER,
  wallet_discovery_source TEXT,
  -- Darwinian signal snapshot (mirrors Laminar signal-weights.js)
  sig_organic_score REAL,
  sig_fee_tvl_ratio REAL,
  sig_volume REAL,
  sig_mcap REAL,
  sig_holder_count REAL,
  sig_smart_wallets_present INTEGER,
  sig_narrative_quality TEXT,
  sig_study_win_rate REAL,
  sig_hive_consensus REAL,
  sig_volatility REAL,
  sig_entry_mcap REAL,
  sig_entry_tvl REAL,
  sig_entry_volume REAL,
  signal_snapshot TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (position_id) REFERENCES positions(id)
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_wallets_status              ON wallets(status);
CREATE INDEX IF NOT EXISTS idx_wallets_is_top_wallet       ON wallets(is_top_wallet) WHERE is_top_wallet = 1;
CREATE INDEX IF NOT EXISTS idx_positions_wallet_status     ON positions(wallet_address, status);
CREATE INDEX IF NOT EXISTS idx_positions_pool_status       ON positions(pool_address, status);
CREATE INDEX IF NOT EXISTS idx_positions_wallet_entry      ON positions(wallet_address, entry_timestamp);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_pool_ts    ON market_snapshots(pool_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_status_created      ON signals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_discovery_log_wallet ON wallet_discovery_log(wallet_address);
CREATE INDEX IF NOT EXISTS idx_training_records_position   ON training_records(position_id);

-- Darwinian signal weights learned from closed-position outcomes
CREATE TABLE IF NOT EXISTS signal_weights (
  signal TEXT PRIMARY KEY,
  weight REAL DEFAULT 1.0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS signal_weight_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recalculated_at INTEGER DEFAULT (unixepoch()),
  window_size INTEGER,
  win_count INTEGER,
  loss_count INTEGER,
  changes TEXT -- JSON array of { signal, from, to, lift, action }
);

CREATE INDEX IF NOT EXISTS idx_signal_weight_history_at ON signal_weight_history(recalculated_at);

-- Chart indicators (RSI/supertrend/MACD/Bollinger) per pool per timeframe. Populated by
-- src/collector/chart-indicators.js (optional feed; absent rows are simply missing entries).
-- Used by Laminar's chart preset logic for entry/exit signal selection.
CREATE TABLE IF NOT EXISTS chart_indicators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT NOT NULL,
  snapshot_id INTEGER,
  timeframe TEXT NOT NULL,             -- '5m' | '15m' | '1h' | '4h' | '1d'
  timestamp INTEGER NOT NULL,
  rsi_14 REAL,
  supertrend_signal TEXT,              -- 'up' | 'down'
  supertrend_value REAL,
  macd_signal REAL,
  macd_histogram REAL,
  bollinger_upper REAL,
  bollinger_lower REAL,
  entry_preset TEXT,
  exit_preset TEXT,
  open_price REAL,
  high_price REAL,
  low_price REAL,
  close_price REAL,
  volume REAL,
  fetched_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (snapshot_id) REFERENCES market_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chart_indicators_pool_tf ON chart_indicators(pool_address, timeframe, timestamp);
CREATE INDEX IF NOT EXISTS idx_chart_indicators_snapshot ON chart_indicators(snapshot_id);
`;

// ─── Additive column migrations (idempotent ALTER TABLE ADD COLUMN) ───────────
// Rich market metrics captured into market_snapshots from the Meteora pool object
// (momentum, LP flow, activity, structure, token health, pool age). All come from the
// single pool-detail fetch — no extra API calls. Adding more here auto-flows to the
// training dataset via the entry-snapshot JOIN in dataset/exporter.js.
const SNAPSHOT_COLS = [
  // momentum / change % (ML trend gold)
  ["volume_change_pct", "REAL"], ["tvl_change_pct", "REAL"], ["active_tvl_change_pct", "REAL"],
  ["fee_change_pct", "REAL"], ["fee_active_tvl_ratio_change_pct", "REAL"], ["swap_count_change_pct", "REAL"],
  ["holders_change_pct", "REAL"], ["positions_created_change_pct", "REAL"], ["unique_lps_change_pct", "REAL"],
  ["unique_traders_change_pct", "REAL"], ["net_deposits_change_pct", "REAL"],
  // LP flow direction (net entering vs exiting)
  ["net_deposits", "REAL"], ["total_deposits", "REAL"], ["total_withdraws", "REAL"],
  // activity counts
  ["swap_count", "REAL"], ["unique_traders", "REAL"], ["unique_lps", "REAL"], ["total_lps", "REAL"],
  ["positions_created", "REAL"], ["active_positions", "REAL"], ["active_positions_pct", "REAL"], ["open_positions", "REAL"],
  // pool structure / fee
  ["pool_fee_pct", "REAL"], ["dynamic_fee_pct", "REAL"], ["min_price", "REAL"], ["max_price", "REAL"],
  ["price_trend", "TEXT"], ["has_farm", "INTEGER"], ["permanent_lock_liquidity_pct", "REAL"],
  ["volume_tvl_ratio", "REAL"], ["volume_active_tvl_ratio", "REAL"],
  // base-token health
  ["base_holders", "INTEGER"], ["base_fdv", "REAL"], ["base_mcap", "REAL"], ["base_dev_balance_pct", "REAL"],
  ["base_top_holders_pct", "REAL"], ["base_organic_score", "REAL"], ["base_is_verified", "INTEGER"],
  ["base_has_freeze_auth", "INTEGER"], ["base_has_mint_auth", "INTEGER"],
  ["pool_created_at", "INTEGER"], ["base_created_at", "INTEGER"], ["days_since_pool_created", "REAL"],
  // multi-source enrichment
  ["base_mint", "TEXT"], ["sol_price_usd", "REAL"],
  // buy/sell trade direction (Birdeye, 5min cache/mint)
  ["buy_volume_24h_usd", "REAL"], ["sell_volume_24h_usd", "REAL"],
  ["buy_count_24h", "REAL"], ["sell_count_24h", "REAL"],
  ["buy_sell_ratio_24h", "REAL"],
  // 1h timeframe (parallel Meteora fetch — "freshly hot" vs "long-hot" detection)
  ["volume_1h", "REAL"], ["fee_apr_1h", "REAL"],
  ["volume_change_pct_1h", "REAL"], ["swap_count_change_pct_1h", "REAL"],
];
const TRAINING_COLS = [
  ["entry_snapshot_id", "INTEGER"],
  ["wallet_preferred_strategy", "TEXT"], ["wallet_preferred_range_style", "TEXT"],
  ["signal_snapshot", "TEXT"], // JSON of staged Darwinian signals at entry
];
const WALLETS_COLS = [
  ["preferred_strategy", "TEXT"], ["preferred_range_style", "TEXT"], // from Agent Meridian studyTopLPers
  ["tags", "TEXT"], // JSON array of computed tags
  ["open_positions", "INTEGER"], // count of currently open positions
  ["pool_count", "INTEGER"], // distinct pools ever LPed
  ["last_active_position_at", "INTEGER"], // timestamp of most recent position entry/exit
];
const TOKEN_INFO_COLS = [
  ["creator_holding_pct", "REAL"], // GMGN dev.creator_token_balance / total_supply
  ["price_usd", "REAL"],           // best-effort spot price from token_info source
];
const POSITIONS_COLS = [
  ["token_x_mint", "TEXT"], // base token mint (for readable pair formatting)
  ["token_y_mint", "TEXT"], // quote token mint (usually SOL or USDC)
];

function addColumn(db, table, col, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e; // already migrated — ignore
  }
}

/** Additive migrations: rich snapshot columns + training_records.entry_snapshot_id. */
export function runMigrations(db) {
  for (const [col, type] of SNAPSHOT_COLS) addColumn(db, "market_snapshots", col, type);
  for (const [col, type] of TRAINING_COLS) addColumn(db, "training_records", col, type);
  for (const [col, type] of WALLETS_COLS) addColumn(db, "wallets", col, type);
  for (const [col, type] of TOKEN_INFO_COLS) addColumn(db, "token_info", col, type);
  for (const [col, type] of POSITIONS_COLS) addColumn(db, "positions", col, type);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_training_records_snapshot ON training_records(entry_snapshot_id)");
  } catch { /* index may pre-exist */ }
}

/**
 * Apply PRAGMAs + create all tables/indexes (idempotent), then run additive migrations.
 * @param {import("better-sqlite3").Database} db
 * @returns {string[]} list of table names
 */
export function initSchema(db) {
  for (const pragma of PRAGMAS) db.pragma(pragma);
  db.exec(DDL);
  runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  log("db", `schema ready: ${tables.join(", ")}`);
  return tables;
}

export { DDL, PRAGMAS };
