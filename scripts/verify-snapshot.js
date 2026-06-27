// Verify collectPoolSnapshot inserts the newly-added columns (buy/sell from Birdeye,
// 1h metrics from Meteora, etc.) — checks schema migration, end-to-end insert, DB readback.
import "dotenv/config";
import { initDb, getDb, closeDb } from "../src/db/index.js";
import { collectPoolSnapshot } from "../src/collector/snapshots.js";

async function main() {
  initDb();

  // Confirm the columns actually exist in market_snapshots (proves migration ran)
  const cols = getDb().prepare("PRAGMA table_info(market_snapshots)").all().map((r) => r.name);
  const required = [
    "buy_volume_24h_usd", "sell_volume_24h_usd", "buy_count_24h", "sell_count_24h", "buy_sell_ratio_24h",
    "volume_1h", "fee_apr_1h", "volume_change_pct_1h", "swap_count_change_pct_1h",
  ];
  const missing = required.filter((c) => !cols.includes(c));
  console.log("schema check:", missing.length === 0 ? "OK (all required cols present)" : `MISSING: ${missing.join(", ")}`);

  // Pick a real pool with an open position (so it gets snapshot'd in cron) or fall back to a known Meteora pool
  let pool = getDb().prepare("SELECT DISTINCT pool_address FROM positions WHERE status = 'open' LIMIT 1").get()?.pool_address
    || getDb().prepare("SELECT DISTINCT pool_address FROM market_snapshots WHERE pool_address IS NOT NULL LIMIT 1").get()?.pool_address;
  if (!pool) {
    // fall back: fetch a pool from Meteora discovery
    const r = await fetch("https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=pool_type%3Ddlmm");
    const j = await r.json();
    pool = j?.data?.[0]?.pool_address;
  }
  console.log(`pool: ${pool}\n`);

  console.log("--- running collectPoolSnapshot ---");
  const snap = await collectPoolSnapshot(pool);
  if (!snap) { console.error("snapshot returned null"); process.exit(1); }

  console.log("\n--- new snapshot fields ---");
  for (const k of [...required, "base_mint", "sol_price_usd"]) {
    console.log(`  ${k}:`, JSON.stringify(snap[k]));
  }

  // Read back from DB to prove the row was stored
  const row = getDb().prepare("SELECT * FROM market_snapshots WHERE id = last_insert_rowid()").get();
  console.log("\n--- DB row readback (last insert) ---");
  for (const k of required) console.log(`  ${k}:`, JSON.stringify(row[k]));

  // Count how many columns are non-null across all snapshot cols (snapshot completeness signal)
  const present = required.filter((k) => row[k] != null).length;
  console.log(`\nfield fill: ${present}/${required.length} populated`);
  closeDb();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });