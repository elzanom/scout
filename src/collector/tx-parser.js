// Pure normalizer: Helius enhanced transaction -> scout WalletActivity event.
// Under the hybrid collector this is a *trigger* layer — it detects that a wallet
// interacted with Meteora DLMM, but does NOT decode instruction internals (bins,
// amounts, position mint). The ground-truth position/PnL data is fetched separately
// from Meteora APIs (Phase 3 wallet-evaluator / Phase 5 position-builder).

// Verified on-chain 2026-06-26 via live Helius history: the Meteora DLMM program actually
// invoked by LP transactions is LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo (meridian's
// constant — correct). CLAUDE.md/SPEC list LBUZKhRxPF3XUpBCjp4YzTKgLLjeyaddwrzQLnG4V1Kh,
// which does NOT appear in real TX; it's kept below only as a fallback in case of variants.
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const METEORA_PROGRAM_IDS = new Set([
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // verified DLMM mainnet
  "LBUZKhRxPF3XUpBCjp4YzTKgLLjeyaddwrzQLnG4V1Kh", // CLAUDE.md value (fallback variant)
]);

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Collect every account address referenced anywhere in a Helius enhanced TX:
 * accountData, instruction programIds/accounts, and transfer endpoints.
 * Defensive — Helius shape varies between the (deprecated) Enhanced TX API and webhooks.
 */
export function extractAccounts(tx) {
  const set = new Set();
  if (!tx || typeof tx !== "object") return set;
  for (const a of asArray(tx.accountData)) if (a?.account) set.add(a.account);
  for (const i of asArray(tx.instructions)) {
    if (i?.programId) set.add(i.programId);
    for (const acc of asArray(i?.accounts)) if (acc) set.add(acc);
  }
  for (const t of asArray(tx.nativeTransfers)) {
    if (t?.fromUserAccount) set.add(t.fromUserAccount);
    if (t?.toUserAccount) set.add(t.toUserAccount);
  }
  for (const t of asArray(tx.tokenTransfers)) {
    if (t?.fromUserAccount) set.add(t.fromUserAccount);
    if (t?.toUserAccount) set.add(t.toUserAccount);
    if (t?.mint) set.add(t.mint);
  }
  return set;
}

/** Is this TX touching Meteora DLMM — via a known program id, or a known pool among its accounts? */
export function detectMeteora(tx, knownPools) {
  const accounts = extractAccounts(tx);
  for (const id of METEORA_PROGRAM_IDS) if (accounts.has(id)) return true;
  if (knownPools && knownPools.size) {
    for (const acc of accounts) if (knownPools.has(acc)) return true;
  }
  return false;
}

/**
 * Pool addresses among the TX's accounts.
 *  - If `knownPools` is provided, returns the intersection (existing behavior).
 *  - Otherwise, for Meteora DLMM `INITIALIZE_POSITION` events, infers the pool address
 *    from accountData: the non-program, non-wallet, non-mint account that is *not* the
 *    Meteora program id, fee payer, or native transfer endpoints. This lets history
 *    backfill discover which pools a wallet has LP'd even before those pools are in DB.
 */
export function extractPools(tx, knownPools) {
  const accounts = extractAccounts(tx);
  if (knownPools && knownPools.size) {
    return [...accounts].filter((a) => knownPools.has(a));
  }

  // No known-pool set -> try to infer a Meteora DLMM pool address from accountData.
  const accountData = asArray(tx?.accountData);
  if (!accountData.length) return [];

  const type = tx?.type;
  const isInitializePosition = type === "INITIALIZE_POSITION";
  // Some older Helius shapes put program-specific events under instructions[].
  const hasMeteoraEvent = isInitializePosition || asArray(tx?.events)
    .some((e) => e?.name === "InitializePosition" || e?.type === "INITIALIZE_POSITION");
  if (!isInitializePosition && !hasMeteoraEvent) return [];

  const feePayer = tx?.feePayer || tx?.fee_payer;
  const exclude = new Set([feePayer, ...METEORA_PROGRAM_IDS]);
  for (const t of asArray(tx.nativeTransfers)) {
    if (t?.fromUserAccount) exclude.add(t.fromUserAccount);
    if (t?.toUserAccount) exclude.add(t.toUserAccount);
  }
  for (const t of asArray(tx.tokenTransfers)) {
    if (t?.fromUserAccount) exclude.add(t.fromUserAccount);
    if (t?.toUserAccount) exclude.add(t.toUserAccount);
    if (t?.mint) exclude.add(t.mint);
  }

  // prefer accountData entries that look like a position/pool: writable account after
  // the program id row, not signer, not token program, not ATA program, not sysvar.
  const SYS_PROGRAMS = new Set([
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbBqPxpzNyKQdFD98z9jDSkT8WAJ9pMsX",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "SysvarRent111111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111",
    "AddressLookupTab1e1111111111111111111111111",
  ]);
  const poolLikes = [];
  for (const a of accountData) {
    const acc = a?.account;
    if (!acc || acc.length < 32 || exclude.has(acc)) continue;
    if (SYS_PROGRAMS.has(acc)) continue;
    if (METEORA_PROGRAM_IDS.has(acc)) continue;
    // signer wallet / token mint heuristic
    if (a?.signer || a?.writable === false) continue;
    poolLikes.push(acc);
  }
  // dedupe while preserving order
  return [...new Set(poolLikes)];
}

function firstSignature(tx) {
  if (typeof tx?.signature === "string") return tx.signature;
  if (Array.isArray(tx?.signatures) && tx.signatures[0]) return tx.signatures[0];
  return null;
}

/**
 * Normalize one Helius enhanced transaction into a WalletActivity event.
 * @param {object} tx
 * @param {{ knownPools?: Set<string>, assumeMeteora?: boolean }} opts
 * @returns {{ wallet: string|null, signature: string|null, timestamp: number|null, isMeteora: boolean, pools: string[], source: string|null, type: string|null } | null}
 */
export function parseActivityEvent(tx, opts = {}) {
  if (!tx || typeof tx !== "object") return null;
  const wallet = tx.feePayer || tx.fee_payer || null;
  const signature = firstSignature(tx);
  const timestamp = Number(tx.timestamp ?? tx.blockTime ?? tx.time ?? 0) || null;
  if (!wallet && !signature) return null;

  const knownPools = opts.knownPools;
  const isMeteora = opts.assumeMeteora === true ? true : detectMeteora(tx, knownPools);
  const pools = extractPools(tx, knownPools);

  return {
    wallet,
    signature,
    timestamp,
    isMeteora,
    pools,
    source: tx.source || null,
    type: tx.type || null,
  };
}

/** Parse a webhook body (array or single enhanced TX) → WalletActivity[]. */
export function parseWebhookPayload(body, opts = {}) {
  const arr = Array.isArray(body) ? body : body ? [body] : [];
  const events = [];
  for (const tx of arr) {
    const ev = parseActivityEvent(tx, opts);
    if (ev) events.push(ev);
  }
  return events;
}
