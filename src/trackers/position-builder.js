import { log } from "../utils/logger.js";
import { studyTopLPers, runConcurrent } from "../discovery/pool-discovery.js";
import { fetchWalletPortfolio } from "../screener/metrics-fetcher.js";
import { upsertPosition } from "../db/positions.js";
import { getWallet } from "../db/wallets.js";

// Cap pools per wallet to bound LPAgent cost (mirrors the evaluator's breadth cap).
const MAX_POOLS = 6;

/**
 * Refresh a wallet's reconstructed LP positions (entry→exit) from Meteora: its current open
 * pools (portfolio/open) ∪ discovered_from, each studied via LPAgent topPositions. Upserts into
 * the positions table (idempotent by position id). Use this to keep positions fresh for the
 * dataset / orchestrator independent of the scoring evaluator.
 *
 * NOTE: overlaps with the evaluator's position gathering by design — the evaluator builds
 * positions inline during scoring; this is the standalone refresher for non-scoring contexts.
 *
 * @param {string} address
 * @returns {Promise<number>} positions upserted
 */
export async function refreshWalletPositions(address) {
  const wallet = getWallet(address);
  if (!wallet) {
    log("position_warn", `unknown wallet ${address?.slice(0, 8)}`);
    return 0;
  }

  const pools = new Set();
  if (wallet.discovered_from) pools.add(wallet.discovered_from);
  try {
    const portfolio = await fetchWalletPortfolio(address);
    for (const p of portfolio.pools.slice(0, MAX_POOLS)) pools.add(p.poolAddress);
  } catch (err) {
    log("position_warn", `portfolio ${address?.slice(0, 8)}: ${err.message}`);
  }
  if (pools.size === 0) return 0;

  let count = 0;
  await runConcurrent([...pools], 3, async (poolAddr) => {
    try {
      const studied = await studyTopLPers({ pool_address: poolAddr, limit: 20 });
      const owner = studied.owners.find((o) => o.address === address);
      if (!owner) return; // not a top-20 LPer here
      for (const p of owner.positions) {
        try {
          upsertPosition(p);
          count++;
        } catch (err) {
          log("position_warn", `upsert ${p.id}: ${err.message}`);
        }
      }
    } catch (err) {
      log("position_warn", `study ${poolAddr?.slice(0, 8)}: ${err.message}`);
    }
  });

  log("positions", `refresh ${address.slice(0, 8)}…: ${count} position(s) upserted across ${pools.size} pool(s)`);
  return count;
}
