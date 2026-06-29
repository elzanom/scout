// Sync Scout top wallets into Laminar's smart-wallets.json.
//   node scripts/sync-smart-wallets.js [--limit 50] [--target ../laminar-vps-snapshot]
// Safe to re-run: merges new wallets, preserves existing names/categories, removes stale
// wallets that are no longer in Scout's top list (unless they were added manually).
import fs from "fs";
import path from "path";
import { initDb, closeDb } from "../src/db/index.js";
import { getTopWallets } from "../src/wallets/wallet-ranker.js";
import { log } from "../src/utils/logger.js";
import { repoPath } from "../repo-root.js";
import { config } from "../config/config.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_TARGET_DIR = "../laminar-vps-snapshot";
const SMART_WALLETS_FILE = "smart-wallets.json";
const SCOUT_ORIGIN_MARKER = "scout_top";

function loadLaminarWallets(targetDir) {
  const file = path.resolve(targetDir, SMART_WALLETS_FILE);
  if (!fs.existsSync(file)) return { file, data: { wallets: [] } };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.wallets)) data.wallets = [];
    return { file, data };
  } catch (err) {
    log("sync_smart_warn", `failed to parse ${file}: ${err.message} — starting fresh`);
    return { file, data: { wallets: [] } };
  }
}

function saveLaminarWallets(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function deriveName(wallet, index) {
  return wallet.alias
    ? `scout:${wallet.alias}`
    : `scout:top${index + 1}:${wallet.address.slice(0, 6)}`;
}

function main() {
  initDb();

  const limit = Math.max(1, Math.min(500, Number(arg("--limit") || config.tiers.topWalletLimit || 100)));
  const targetDir = path.resolve(arg("--target") || repoPath(DEFAULT_TARGET_DIR));
  const minScore = Number(arg("--min-score") ?? config.tiers.topWalletMinScore ?? 0);

  const { file, data } = loadLaminarWallets(targetDir);

  // Preserve wallets that did NOT originate from Scout (manual/user-managed).
  const manual = data.wallets.filter((w) => w._origin !== SCOUT_ORIGIN_MARKER);
  const manualAddresses = new Set(manual.map((w) => w.address));

  // Fetch Scout top wallets.
  const tops = getTopWallets({ limit }).filter((w) => (minScore ? w.score >= minScore : true));

  // Build merged list: manual first, then Scout top wallets not already present manually.
  const seen = new Set(manualAddresses);
  const merged = [...manual];
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < tops.length; i++) {
    const w = tops[i];
    if (seen.has(w.address)) {
      skipped++;
      continue;
    }
    seen.add(w.address);
    merged.push({
      name: deriveName(w, i),
      address: w.address,
      category: "scout_top",
      type: "lp",
      score: w.score,
      win_rate: w.win_rate,
      total_positions: w.total_positions,
      addedAt: new Date().toISOString(),
      _origin: SCOUT_ORIGIN_MARKER,
    });
    added++;
  }

  data.wallets = merged;
  saveLaminarWallets(file, data);

  const removed = data.wallets.length - manual.length - added; // approximate stale count
  log("sync_smart", `synced ${tops.length} Scout top wallets → ${file}: added=${added}, skipped=${skipped}, manual_preserved=${manual.length}`);

  closeDb();
}

main();
