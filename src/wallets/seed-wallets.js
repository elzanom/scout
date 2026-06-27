import fs from "fs";
import { log } from "../utils/logger.js";
import { upsertWallet, logDiscovery } from "../db/wallets.js";

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Load seed wallets from a file — one address per line, optional alias after whitespace
 * (`#` starts a comment line). Each new address is inserted as a 'manual' candidate. This is
 * the optional bootstrap path (SPEC §9) for when you want known-good wallets fast instead of
 * waiting for organic discovery.
 *
 * @param {string} file absolute path to the seed file
 * @returns {{ loaded: number, skipped: number }}
 */
export function loadSeedWallets(file) {
  if (!file || !fs.existsSync(file)) {
    log("seed", `seed file not found: ${file || "(none)"}`);
    return { loaded: 0, skipped: 0 };
  }

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let loaded = 0;
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [address, ...rest] = line.split(/\s+/);
    const alias = rest.join(" ") || null;
    if (!PUBKEY_RE.test(address)) {
      skipped++;
      continue;
    }
    const { isNew } = upsertWallet({ address, source: "manual", alias, discovered_from: null });
    logDiscovery({ wallet_address: address, discovery_source: "manual", source_detail: "seed-file" });
    if (isNew) loaded++;
    else skipped++;
  }

  log("seed", `seed load from ${file}: ${loaded} new, ${skipped} skipped/dup`);
  return { loaded, skipped };
}
