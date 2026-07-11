import { config } from "../../config/config.js";
import { getDb } from "../db/index.js";
import { getTopWallets } from "../wallets/wallet-ranker.js";

/**
 * Co-entry correlation boost: when 2+ top wallets open positions in the same pool within a
 * short window, the pool has independent confirmation from multiple proven LPs. This is one of
 * the strongest signals we have — diverse top wallets converging on the same pool usually
 * means the pool has a valid setup (good fees, trending token, asymmetric yield).
 *
 * Boost formula (capped):
 *   bonus = min((co_entries - 1) * perWallet, ceiling)
 *
 * So: 1 top wallet → 0 bonus (already counted by base confidence). 2 → perWallet. 3 → 2×perWallet.
 *
 * Gating:
 * - `coEntryBoostEnabled` flag — opt-in (off by default).
 * - `coEntryMinTopWallets` — minimum top-wallet count before boost activates (default 20).
 *   This prevents false co-entry signals when the top list is too small (any 2 top wallets
 *   in the same pool would look correlated, even if random).
 *
 * Counts top wallets that:
 * - opened ANY position in this pool within `windowHours`
 * - have `is_top_wallet = 1` (live top list, not historical)
 * - is the wallet being validated (the trigger) — i.e. boost = totalOtherTopWalletsInWindow
 *
 * @param {string} poolAddress
 * @param {{ excludeWallet?: string, now?: number }} opts
 * @returns {{ active: boolean, coEntries: number, bonus: number, reason: string }}
 */
export function getCoEntryBoost(poolAddress, { excludeWallet, now } = {}) {
  const cfg = config.signals || {};
  const enabled = cfg.coEntryBoostEnabled === true;
  if (!enabled) return { active: false, coEntries: 0, bonus: 0, reason: "disabled" };

  const minTopWallets = Number(cfg.coEntryMinTopWallets) || 20;
  const windowHours = Number(cfg.coEntryWindowHours) || 4;
  const perWallet = Number(cfg.coEntryBonusPerWallet) || 0.10;
  const ceiling = Number(cfg.coEntryBoostCeiling) || 0.30;

  const topCount = getTopWallets({ limit: 1000 }).length;
  if (topCount < minTopWallets) {
    return { active: false, coEntries: 0, bonus: 0, reason: `top_count_${topCount}_below_${minTopWallets}` };
  }

  const ts = Math.floor((now || Date.now()) / 1000);
  const windowSec = windowHours * 3600;
  const params = [poolAddress, ts - windowSec, ts];
  let excludeClause = "";
  if (excludeWallet) {
    excludeClause = " AND p.wallet_address != ?";
    params.push(excludeWallet);
  }
  const row = getDb().prepare(
    `SELECT COUNT(DISTINCT p.wallet_address) AS n
       FROM positions p
       JOIN wallets w ON w.address = p.wallet_address
      WHERE p.pool_address = ?
        AND p.entry_timestamp IS NOT NULL
        AND p.entry_timestamp BETWEEN ? AND ?
        AND w.is_top_wallet = 1${excludeClause}`,
  ).get(...params);
  const coEntries = Number(row?.n || 0);
  if (coEntries < 2) return { active: true, coEntries, bonus: 0, reason: coEntries === 0 ? "no_co_entries" : "single_wallet" };

  const bonus = Math.min((coEntries - 1) * perWallet, ceiling);
  return { active: true, coEntries, bonus, reason: `co_entry_${coEntries}_wallets` };
}
