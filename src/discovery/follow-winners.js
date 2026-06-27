import { log } from "../utils/logger.js";
import { studyTopLPers, runConcurrent } from "./pool-discovery.js";
import { fetchWalletPortfolio } from "../screener/metrics-fetcher.js";
import { upsertWallet, logDiscovery } from "../db/wallets.js";
import { getTopWallets } from "../wallets/wallet-ranker.js";

/**
 * Follow-winners (SPEC §2c): for each top wallet, study the pools it is active in and insert the
 * OTHER top LPers there as 'follow_winner' candidates — wallets that provide liquidity alongside
 * proven winners (co-occurrence). Co-occurrence is by shared pool; the ±24h entry-window filter
 * is a refinement for once position entry-timestamps are broadly populated.
 *
 * @param {{ topLimit?: number, poolLimit?: number, ownerLimit?: number }} opts
 */
export async function runFollowWinners({ topLimit = 20, poolLimit = 6, ownerLimit = 20 } = {}) {
  const tops = getTopWallets({ limit: topLimit });
  let newCandidates = 0;

  for (const top of tops) {
    const pools = new Set();
    try {
      const portfolio = await fetchWalletPortfolio(top.address);
      for (const p of portfolio.pools.slice(0, poolLimit)) pools.add(p.poolAddress);
    } catch (err) {
      log("follow_warn", `portfolio ${top.address?.slice(0, 8)}…: ${err.message}`);
      continue;
    }
    if (!pools.size) continue;

    await runConcurrent([...pools], 3, async (poolAddr) => {
      try {
        const studied = await studyTopLPers({ pool_address: poolAddr, limit: ownerLimit });
        for (const o of studied.owners) {
          if (!o.address || o.address === top.address) continue; // skip the top wallet itself
          const { isNew } = upsertWallet({
            address: o.address,
            source: "follow_winner",
            discovered_from: top.address,
          });
          if (isNew) {
            logDiscovery({ wallet_address: o.address, discovery_source: "follow_winner", source_detail: top.address });
            newCandidates++;
          }
        }
      } catch (err) {
        log("follow_warn", `study ${poolAddr?.slice(0, 8)}… for ${top.address?.slice(0, 8)}…: ${err.message}`);
      }
    });
  }

  log("follow", `follow-winners: ${newCandidates} new candidate(s) from co-occurrence with ${tops.length} top wallet(s)`);
  return { top_wallets: tops.length, new_candidates: newCandidates };
}
