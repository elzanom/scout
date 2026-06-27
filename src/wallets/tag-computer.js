/**
 * Compute human-readable tags for a wallet from its positions + aggregate metrics.
 * These tags are persisted in `wallets.tags` (JSON array) and rendered in the UI.
 *
 * Rules are calibrated to real DLMM LP data (win-rate ~0.3-0.5 for typical active LPs,
 * with elite wallets sitting above 0.6).
 */

const TAG_RULES = [
  // ── Win-rate labels ─────────────────────────────────────────────────────────
  {
    key: "GODLIKE-WR",
    test: ({ win_rate }) => win_rate >= 0.9,
  },
  {
    key: "HIGH-WINRATE",
    test: ({ win_rate }) => win_rate >= 0.65,
  },
  {
    key: "SOLID-TRADER",
    test: ({ win_rate, total_positions }) => win_rate >= 0.5 && total_positions >= 10,
  },

  // ── Activity / consistency ──────────────────────────────────────────────────
  {
    key: "ACTIVE-NOW",
    test: ({ open_positions }) => open_positions >= 1,
  },
  {
    key: "VETERAN",
    test: ({ total_positions }) => total_positions >= 50,
  },

  // ── Diversification ─────────────────────────────────────────────────────────
  {
    key: "MULTI-POOL-DEGEN",
    test: ({ pool_count, total_positions }) => pool_count >= 5 && total_positions >= pool_count * 2,
  },
  {
    key: "ONE-POOL-WHALE",
    test: ({ pool_count, total_positions, capital_avg }) => pool_count === 1 && total_positions >= 10 && capital_avg >= 1000,
  },

  // ── Capital / size ──────────────────────────────────────────────────────────
  {
    key: "BIG-POSITION",
    test: ({ capital_avg }) => capital_avg >= 5000,
  },
  {
    key: "SMALL-POSITION",
    test: ({ capital_avg }) => capital_avg != null && capital_avg > 0 && capital_avg < 250,
  },

  // ── Profitability ───────────────────────────────────────────────────────────
  {
    key: "PROFITABLE",
    test: ({ total_pnl_usd }) => total_pnl_usd > 0,
  },
  {
    key: "FEE-PRINTER",
    test: ({ total_fees_usd, total_positions }) => total_fees_usd / Math.max(1, total_positions) >= 200,
  },

  // ── Range style (derived from positions; LPAgent preferred_range_style is kept
  //    separately in `wallets.preferred_range_style`).
  {
    key: "TIGHT-RANGE",
    test: ({ avg_bin_width }) => avg_bin_width != null && avg_bin_width <= 30,
  },
  {
    key: "WIDE-RANGE",
    test: ({ avg_bin_width }) => avg_bin_width != null && avg_bin_width >= 150,
  },

  // ── Time preference ─────────────────────────────────────────────────────────
  {
    key: "SCALPER",
    test: ({ avg_duration_hours }) => avg_duration_hours != null && avg_duration_hours <= 12,
  },
  {
    key: "HODL-LP",
    test: ({ avg_duration_hours }) => avg_duration_hours != null && avg_duration_hours >= 168,
  },
];

/**
 * Build a tag context from position rows + aggregate metrics.
 * @param {object} metrics — aggregate metrics (win_rate, total_positions, ...)
 * @param {object[]} positions — wallet's positions from the DB
 */
function buildContext(metrics, positions = []) {
  const closed = positions.filter((p) => p.status === "closed");
  const widths = positions.map((p) => p.bin_range_width).filter((v) => Number.isFinite(v) && v > 0);
  const capitals = positions.map((p) => p.capital_usd).filter((v) => Number.isFinite(v) && v > 0);

  const avg_bin_width = widths.length ? widths.reduce((s, x) => s + x, 0) / widths.length : null;
  const capital_avg = capitals.length ? capitals.reduce((s, x) => s + x, 0) / capitals.length : null;

  const open_positions = positions.filter((p) => p.status === "open").length;
  const pool_count = new Set(positions.map((p) => p.pool_address)).size;

  const last_entry = Math.max(
    0,
    ...positions.map((p) => p.entry_timestamp).filter(Boolean),
  );
  const last_exit = Math.max(
    0,
    ...closed.map((p) => p.exit_timestamp).filter(Boolean),
  );
  const last_active_position_at = Math.max(last_entry, last_exit) || null;

  return {
    ...metrics,
    open_positions,
    pool_count,
    avg_bin_width,
    capital_avg,
    last_active_position_at,
  };
}

/**
 * Return a sorted array of wallet tags given metrics + positions.
 * @param {object} metrics
 * @param {object[]} positions
 * @returns {string[]}
 */
export function computeWalletTags(metrics, positions = []) {
  const ctx = buildContext(metrics, positions);
  const tags = [];
  for (const rule of TAG_RULES) {
    try {
      if (rule.test(ctx)) tags.push(rule.key);
    } catch {
      // ignore malformed rule
    }
  }
  return tags;
}

/**
 * Convenience: derive the extra columns that `updateWalletMetrics` persists
 * alongside the base metrics.
 */
export function deriveWalletExtras(metrics, positions = []) {
  const ctx = buildContext(metrics, positions);
  return {
    tags: computeWalletTags(metrics, positions),
    open_positions: ctx.open_positions,
    pool_count: ctx.pool_count,
    last_active_position_at: ctx.last_active_position_at,
  };
}
