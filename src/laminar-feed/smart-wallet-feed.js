/**
 * Laminar smart-wallet feed — exports Scout top wallets into a format Laminar can consume.
 * Does NOT modify the laminar-vps-snapshot folder; it writes a standalone JSON file and
 * exposes the same data via the webui API (/api/laminar/smart-wallets).
 */
import fs from "fs";
import path from "path";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getTopWallets } from "../wallets/wallet-ranker.js";

const DEFAULT_LIMIT = 100;

function deriveName(wallet, index) {
  return wallet.alias
    ? `scout:${wallet.alias}`
    : `scout:top${index + 1}:${wallet.address.slice(0, 6)}`;
}

export function buildSmartWalletFeed({ limit = DEFAULT_LIMIT, minScore = 0 } = {}) {
  const tops = getTopWallets({ limit }).filter((w) => (minScore ? w.score >= minScore : true));
  const wallets = tops.map((w, i) => ({
    name: deriveName(w, i),
    address: w.address,
    category: "scout_top",
    type: "lp",
    score: w.score,
    win_rate: w.win_rate,
    total_positions: w.total_positions,
    addedAt: new Date().toISOString(),
  }));
  return { generated_at: new Date().toISOString(), count: wallets.length, wallets };
}

export function writeSmartWalletFeed() {
  const feed = buildSmartWalletFeed({
    limit: config.tiers.topWalletLimit || DEFAULT_LIMIT,
    minScore: config.tiers.topWalletMinScore ?? 0,
  });
  const target = config.output.laminarFeedPath;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(feed, null, 2));
  log("laminar_feed", `wrote ${feed.count} top wallet(s) → ${target}`);
  return { path: target, ...feed };
}
