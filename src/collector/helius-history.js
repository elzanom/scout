import { log } from "../utils/logger.js";
import { sleep } from "../utils/retry.js";
import { parseActivityEvent } from "./tx-parser.js";
import { heliusApiGet } from "../rpc/helius-router.js";

/**
 * Fetch one page of a wallet's enhanced transaction history from Helius.
 * Uses the deprecated Enhanced Transactions `/v0/addresses/{addr}/transactions` endpoint,
 * which still operates and returns rich, instruction-bearing TX objects. `before` paginates
 * to older signatures. Migration to getTransactionsForAddress is low-priority future work.
 *
 * This stays on the premium Helius API; the public pump.helius-rpc.com proxy cannot serve
 * enhanced transaction history.
 *
 * The underlying router rotates through multiple HELIUS_API_KEYs when configured, failing
 * over automatically on rate-limit or transient errors.
 */
function fetchPage(wallet, { before, limit }) {
  const query = { limit };
  if (before) query.before = before;
  return heliusApiGet(`/v0/addresses/${wallet}/transactions`, query, { maxAttempts: 5 });
}

/**
 * Backfill a wallet's Meteora DLMM activity from Helius history. Returns WalletActivity[]
 * filtered to Meteora, newest-first, bounded by `days` and `maxTx`. Pages are delayed to be
 * gentle on Helius rate limits.
 *
 * @param {string} wallet
 * @param {{ days?: number, maxTx?: number, pageSize?: number, knownPools?: Set<string>, sleepMs?: number }} opts
 * @returns {Promise<object[]>}
 */
export async function backfillWalletActivity(wallet, opts = {}) {
  const {
    days = config.collection.backfillDays,
    maxTx = 1000,
    pageSize = 100,
    knownPools,
    sleepMs = 150,
  } = opts;

  const cutoffMs = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const events = [];
  let before = null;
  let scanned = 0;

  while (scanned < maxTx) {
    const page = await fetchPage(wallet, { before, limit: Math.min(pageSize, maxTx - scanned) });
    if (!Array.isArray(page) || page.length === 0) break;

    let oldestThisPage = before;
    for (const tx of page) {
      const ev = parseActivityEvent(tx, { knownPools });
      if (!ev) continue;
      scanned++;
      // Pages are newest-first — once we cross the age cutoff, stop scanning further back.
      if (ev.timestamp && cutoffMs && ev.timestamp * 1000 < cutoffMs) {
        return finalize(wallet, events, scanned);
      }
      if (ev.isMeteora) events.push(ev);
      if (ev.signature) oldestThisPage = ev.signature;
    }

    before = oldestThisPage;
    if (!before || page.length < pageSize) break;
    if (sleepMs > 0) await sleep(sleepMs);
  }

  return finalize(wallet, events, scanned);
}

function finalize(wallet, events, scanned) {
  log("history", `backfill ${wallet.slice(0, 8)}…: ${scanned} tx scanned → ${events.length} Meteora activity`);
  return events;
}
