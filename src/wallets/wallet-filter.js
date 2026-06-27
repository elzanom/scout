import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { rankTrackedByScore } from "./wallet-ranker.js";
import { sendHTML } from "../notifier/telegram.js";

const now = () => Math.floor(Date.now() / 1000);

/**
 * Tracked → top transition (SPEC §3): promote the top-N tracked wallets by score to
 * is_top_wallet=1, demote any current top wallet that fell out of the ranking. Capped at
 * config.tiers.topWalletLimit. Transactional. Returns { promoted, demoted, topCount }.
 */
export function promoteTopWallets({ limit } = {}) {
  const cap = limit ?? config.tiers.topWalletLimit;
  const minScore = config.tiers.topWalletMinScore ?? 0;
  const ranked = rankTrackedByScore({ limit: cap });
  // Elite floor: only tracked wallets at/above topWalletMinScore enter the signal-driving
  // top whitelist (keeps signals high-quality as the tracked pool grows).
  const eligible = minScore > 0 ? ranked.filter((w) => w.score >= minScore) : ranked;
  const topIds = new Set(eligible.map((w) => w.address));

  const promoteStmt = getDb().prepare(
    `UPDATE wallets SET is_top_wallet = 1, updated_at = ? WHERE address = ? AND is_top_wallet = 0`,
  );
  const demoteStmt = getDb().prepare(
    `UPDATE wallets SET is_top_wallet = 0, updated_at = ? WHERE address = ? AND is_top_wallet = 1`,
  );

  let promoted = 0;
  let demoted = 0;
  let previousTop = [];
  const tx = getDb().transaction(() => {
    for (const w of ranked) {
      if (promoteStmt.run(now(), w.address).changes) promoted++;
    }
    // demote any currently-top wallet no longer in the ranking
    previousTop = getDb().prepare(`SELECT address FROM wallets WHERE is_top_wallet = 1`).all();
    for (const w of previousTop) {
      if (!topIds.has(w.address) && demoteStmt.run(now(), w.address).changes) demoted++;
    }
  });
  tx();

  log("rank", `promoteTopWallets: ${promoted} promoted, ${demoted} demoted (top=${eligible.length}/${ranked.length} tracked, minScore=${minScore}, cap=${cap})`);

  if (promoted > 0 || demoted > 0) {
    notifyPromotionChange(ranked, previousTop, topIds).catch((e) => log("telegram_warn", `promotion alert failed: ${e.message}`));
  }

  return { promoted, demoted, topCount: eligible.length };
}

async function notifyPromotionChange(ranked, previousTop, topIds) {
  const previousSet = new Set((previousTop || []).map((w) => w.address));
  const rankedSet = new Set(ranked.map((w) => w.address));
  const promoted = ranked.filter((w) => !previousSet.has(w.address));
  const demoted = (previousTop || []).filter((w) => !topIds.has(w.address));

  if (!promoted.length && !demoted.length) return;

  const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmtPct = (n) => n != null ? `${(n * 100).toFixed(1)}%` : "?";
  const lines = ["⭐ Top Wallet Changes"];

  if (promoted.length) {
    lines.push("", `Promoted (${promoted.length}):`);
    for (const w of promoted) {
      lines.push(`<code>${escapeHtml(w.address)}</code>`);
      lines.push(`score ${w.score?.toFixed(1) ?? "?"} | WR ${fmtPct(w.win_rate)} | pos ${w.total_positions ?? 0}`);
    }
  }

  if (demoted.length) {
    lines.push("", `Demoted (${demoted.length}):`);
    for (const w of demoted) {
      lines.push(`<code>${escapeHtml(w.address)}</code>`);
    }
  }

  await sendHTML(lines.join("\n"));
}

/**
 * Re-evaluation sweep (SPEC: rejected wallets can rise again): flip rejected wallets whose
 * last evaluation is older than reEvaluateIntervalHours back to 'candidate', so the evaluator
 * re-considers them on the next cycle. Returns the count re-queued.
 */
export function sweepReEvaluation() {
  const cutoff = now() - config.discovery.reEvaluateIntervalHours * 3600;
  const info = getDb().prepare(
    `UPDATE wallets SET status = 'candidate', reject_reason = NULL, updated_at = ?
     WHERE status = 'rejected' AND (last_evaluated IS NULL OR last_evaluated < ?)`,
  ).run(now(), cutoff);
  if (info.changes) log("rank", `sweepReEvaluation: ${info.changes} rejected → candidate`);
  return info.changes;
}

/**
 * Periodic ranking cycle (scheduled by the Phase 7 orchestrator):
 *   1. re-queue stale rejected wallets for re-evaluation,
 *   2. refresh the top-wallet whitelist from current tracked scores.
 */
export function runRankingCycle() {
  const requeued = sweepReEvaluation();
  const promotion = promoteTopWallets();
  return { requeued, ...promotion };
}
