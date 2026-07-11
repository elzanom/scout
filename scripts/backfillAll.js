// Bulk backfill all top + tracked wallets: Helius TX history + position_events timeline.
//
// Default behaviour (no flags):
//   - wallets: status IN ('top','tracked') OR is_top_wallet=1
//   - days: config.collection.backfillDays (default 30)
//   - Helius TX backfill: backfillWalletActivity(wallet, { days, maxTx: 1500 })
//   - position_events backfill: syncPositionEvents() for each position without an event ledger
//   - pacing: 1.5s between wallets (Helius multi-key rotates; respect rate limits)
//
// Flags:
//   --days N            Helius lookback window (default: config.collection.backfillDays)
//   --top-only          only top wallets (is_top_wallet=1), skip tracked
//   --limit N           process at most N wallets
//   --events-only       skip Helius TX backfill, only sync position_events
//   --tx-only           skip position_events backfill, only run Helius TX
//   --wallet <addr>     single wallet override (skips DB list)
//
// Usage:
//   node scripts/backfillAll.js                    # full sweep, defaults
//   node scripts/backfillAll.js --days 90          # wider lookback
//   node scripts/backfillAll.js --top-only --limit 20
//   node scripts/backfillAll.js --events-only      # only populate position_events from existing positions
import { initDb, closeDb, getDb } from "../src/db/index.js";
import { listWallets } from "../src/db/wallets.js";
import { backfillWalletActivity } from "../src/collector/helius-history.js";
import { syncPositionEvents } from "../src/collector/position-history.js";
import { log } from "../src/utils/logger.js";
import { sleep } from "../src/utils/retry.js";
import { config } from "../config/config.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name) {
  return process.argv.indexOf(name) >= 0;
}

const days = Number(arg("--days")) || config.collection.backfillDays;
const topOnly = flag("--top-only");
const eventsOnly = flag("--events-only");
const txOnly = flag("--tx-only");
const limit = Number(arg("--limit")) || 0;
const singleWallet = arg("--wallet");
const walletSleepMs = 1500;

initDb();

let wallets;
if (singleWallet) {
  wallets = [singleWallet];
} else {
  // listWallets default limit=100; pass a large bound so a fresh discovery state still gets
  // all top/tracked rows in one query.
  const all = listWallets({ limit: 10000 });
  wallets = all
    .filter((w) => (topOnly ? !!w.is_top_wallet : (w.is_top_wallet || w.status === "tracked")))
    .map((w) => w.address);
  if (limit > 0) wallets = wallets.slice(0, limit);
}

if (!wallets.length) {
  console.error("[backfillAll] no wallets to process (top list may be empty). Run discovery first.");
  closeDb();
  process.exit(1);
}

console.log(`[backfillAll] starting: wallets=${wallets.length} days=${days} topOnly=${topOnly} txOnly=${txOnly} eventsOnly=${eventsOnly}`);
log("backfill_all", `start: ${wallets.length} wallet(s), ${days}d window, topOnly=${topOnly}, txOnly=${txOnly}, eventsOnly=${eventsOnly}`);

let txTotal = 0;
let txSuccess = 0;
let txSkipped = 0;
let eventsSynced = 0;
let eventsFailed = 0;
const t0 = Date.now();

for (let i = 0; i < wallets.length; i++) {
  const wallet = wallets[i];
  const tag = `[${i + 1}/${wallets.length}] ${wallet.slice(0, 8)}…`;

  // 1) Helius TX backfill (unless events-only)
  if (!eventsOnly) {
    txTotal++;
    try {
      const events = await backfillWalletActivity(wallet, { days, maxTx: 1500, pageSize: 100 });
      if (events.length > 0) txSuccess++;
      else txSkipped++;
      console.log(`${tag} tx: ${events.length} Meteora event(s) over ${days}d`);
    } catch (err) {
      console.error(`${tag} tx FAILED: ${err.message}`);
    }
  }

  // 2) position_events backfill (unless tx-only)
  if (!txOnly) {
    const positions = getDb().prepare(
      `SELECT id FROM positions
       WHERE wallet_address = ?
         AND NOT EXISTS (SELECT 1 FROM position_events pe WHERE pe.position_id = positions.id)
       ORDER BY COALESCE(exit_timestamp, entry_timestamp) DESC`,
    ).all(wallet);
    if (positions.length) {
      console.log(`${tag} events: ${positions.length} position(s) without ledger, syncing…`);
      let posOk = 0;
      let posErr = 0;
      for (const p of positions) {
        try {
          await syncPositionEvents(p.id);
          posOk++;
          eventsSynced++;
          // tiny pause between position calls to keep Meteora happy (1 call/pos)
          await sleep(200);
        } catch (err) {
          posErr++;
          eventsFailed++;
          log("backfill_all_warn", `${tag} pos ${p.id?.slice(0, 8)}: ${err.message}`);
        }
      }
      console.log(`${tag} events: ${posOk} synced, ${posErr} failed`);
    }
  }

  // Pace between wallets (Helius multi-key rotates, but stay gentle)
  if (i < wallets.length - 1 && walletSleepMs > 0) {
    await sleep(walletSleepMs);
  }
}

const durationMs = Date.now() - t0;
const summary = {
  wallets: wallets.length,
  days,
  tx: { total: txTotal, withEvents: txSuccess, empty: txSkipped },
  positionEvents: { synced: eventsSynced, failed: eventsFailed },
  durationSec: Math.round(durationMs / 1000),
};
console.log("\n[backfillAll] done:", JSON.stringify(summary, null, 2));
log("backfill_all", `done: ${JSON.stringify(summary)}`);
closeDb();
