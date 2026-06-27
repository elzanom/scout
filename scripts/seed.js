// Import seed wallets into the DB (optional bootstrap, SPEC §9).
//   node scripts/seed.js --file seed-wallets.txt
import { repoPath } from "../repo-root.js";
import { initDb, closeDb } from "../src/db/index.js";
import { loadSeedWallets } from "../src/wallets/seed-wallets.js";
import { log } from "../src/utils/logger.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg("--file") || repoPath("seed-wallets.txt");
initDb();
const res = loadSeedWallets(file);
log("seed", `done: ${res.loaded} loaded, ${res.skipped} skipped`);
closeDb();
