// Backfill a single wallet's Meteora activity history (optional manual, SPEC dev flow).
//   node scripts/backfill.js --wallet <address> [--days 90]
import { initDb, closeDb } from "../src/db/index.js";
import { backfillWalletActivity } from "../src/collector/helius-history.js";
import { log } from "../src/utils/logger.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const wallet = arg("--wallet");
const days = Number(arg("--days") || 90);
if (!wallet) {
  console.error("usage: node scripts/backfill.js --wallet <address> [--days 90]");
  process.exit(1);
}

initDb();
const events = await backfillWalletActivity(wallet, { days, maxTx: 1000 });
log("backfill", `${wallet.slice(0, 8)}…: ${events.length} Meteora activity event(s) over ${days}d`);
closeDb();
