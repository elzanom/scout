import { log } from "../utils/logger.js";
import { upsertWallet, logDiscovery, getWallet } from "../db/wallets.js";
import { processWalletEntry } from "../signals/validator.js";

/**
 * Build the Helius-webhook activity handler that implements tx-mining + real-time signals.
 * Wire it via `onActivity(makeTxMiningHandler())` in the orchestrator. For each WalletActivity:
 *   - unknown wallet → insert as a 'tx_mining' candidate (+ discovery log).
 *   - known wallet → touch last_active.
 *   - top wallet seen in a pool → real-time signal validation/emit (processWalletEntry), the
 *     event-driven counterpart of the polling signal-scan cycle.
 *
 * Active only when a Helius webhook is registered to POST this scout's /webhook/helius endpoint
 * (filtered to the Meteora DLMM program — Helius does not type Meteora events, so filter by
 * program-account inclusion at registration time).
 */
export function makeTxMiningHandler() {
  return async (events) => {
    for (const ev of events) {
      const wallet = ev.wallet;
      if (!wallet) continue;

      const existing = getWallet(wallet);
      if (!existing) {
        const detail = ev.pools?.[0] || ev.signature || "global-meteora-tx";
        const { isNew } = upsertWallet({ address: wallet, source: "tx_mining", discovered_from: detail });
        if (isNew) {
          logDiscovery({ wallet_address: wallet, discovery_source: "tx_mining", source_detail: detail });
          log("txmining", `new candidate ${wallet.slice(0, 8)}… (tx_mining)`);
        }
      } else {
        upsertWallet({ address: wallet, source: "tx_mining" }); // touch last_active (source preserved)
      }

      // Real-time signal: a TOP wallet entering a pool we can identify from the activity.
      if (existing?.is_top_wallet && ev.pools?.length) {
        for (const pool of ev.pools) {
          try {
            await processWalletEntry(wallet, pool);
          } catch (err) {
            log("txmining_warn", `signal ${wallet.slice(0, 8)}… @ ${pool.slice(0, 8)}…: ${err.message}`);
          }
        }
      }
    }
  };
}
