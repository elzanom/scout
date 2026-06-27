import { log } from "../utils/logger.js";

const _staged = new Map();
const _stagedByBaseMint = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000;

function normalizeKey(value) {
  return value ? String(value).trim() : null;
}

function cleanupStale() {
  const now = Date.now();
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
    }
  }
}

export function stageSignals(poolAddress, signals) {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;

  const baseMint = normalizeKey(signals?.base_mint || signals?.baseMint);
  _staged.set(poolKey, {
    ...signals,
    base_mint: baseMint || signals?.base_mint || null,
    staged_at: Date.now(),
  });
  if (baseMint) _stagedByBaseMint.set(baseMint, poolKey);
}

export function getAndClearStagedSignals(poolAddress, baseMint = null) {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : null;
    data = poolKey ? _staged.get(poolKey) : null;
  }

  if (!data) return null;
  _staged.delete(poolKey);
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }
  const { staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolKey.slice(0, 8)}: ${Object.keys(signals).filter((k) => signals[k] != null).length} signals`);
  return signals;
}

export function getStagedPools() {
  cleanupStale();
  return [..._staged.keys()];
}
