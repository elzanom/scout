#!/usr/bin/env node
/**
 * Sync Scout learning outputs into a Laminar agent folder.
 *
 * What it copies/merges:
 *   1. smart-wallets.json       → merge, preserve manual wallets, mark Scout origin
 *   2. lessons.json             → append performance + lessons
 *   3. signal-weights.json      → update weights (with backup)
 *   4. pool-memory.json         → merge per-pool deploy histories
 *   5. decision-log.json        → prepend decision traces
 *
 * Default is DRY-RUN. Use --apply to write files.
 *
 * Usage:
 *   node scripts/sync-to-laminar.js [--target ../laminar-vps-snapshot] [--apply] [--max-records 5000] [--max-lessons 1000] [--min-score 60] [--max-pool-deploys 20]
 */
import fs from "fs";
import path from "path";
import { initDb, closeDb } from "../src/db/index.js";
import { exportLaminarTrainingOutputs } from "../src/dataset/laminar-export.js";
import { log } from "../src/utils/logger.js";
import { repoPath } from "../repo-root.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_TARGET_DIR = "./laminar-vps-snapshot";
const SCOUT_ORIGIN_MARKER = "scout_top";

const TARGET_FILES = {
  smartWallets: "smart-wallets.json",
  lessons: "lessons.json",
  signalWeights: "signal-weights.json",
  poolMemory: "pool-memory.json",
  decisionLog: "decision-log.json",
};

const apply = process.argv.includes("--apply");
const targetDir = path.resolve(arg("--target") || repoPath(DEFAULT_TARGET_DIR));
const maxRecords = Math.max(0, Number(arg("--max-records") || 5000));
const maxLessons = Math.max(0, Number(arg("--max-lessons") || 1000));
const minWalletScore = Math.max(0, Number(arg("--min-score") ?? 60));
const maxPoolDeploys = Math.max(1, Number(arg("--max-pool-deploys") || 20));

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("sync_laminar_warn", `failed to parse ${file}: ${err.message}`);
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      log("sync_laminar_warn", `failed to parse line in ${file}: ${err.message}`);
    }
  }
  return out;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.scout-backup-${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function filterPerformance(performance) {
  const cutoff = maxRecords > 0 ? performance.slice(0, maxRecords) : performance;
  return cutoff.filter((p) => (p.wallet_score ?? 0) >= minWalletScore);
}

function lessonPosition(lesson) {
  if (lesson.position) return lesson.position;
  if (typeof lesson.id === "string" && lesson.id.includes("_")) {
    return lesson.id.split("_").slice(0, -1).join("_");
  }
  return null;
}

function filterLessons(lessons, perfPositions) {
  const positions = new Set(perfPositions);
  const matched = lessons.filter((l) => {
    const pos = lessonPosition(l);
    return pos && positions.has(pos);
  });
  return maxLessons > 0 ? matched.slice(0, maxLessons) : matched;
}

// ─── 1. Smart Wallets ──────────────────────────────────────────────────────
function syncSmartWallets(scout) {
  const file = path.join(targetDir, TARGET_FILES.smartWallets);
  const laminar = readJson(file, { wallets: [] });
  if (!Array.isArray(laminar.wallets)) laminar.wallets = [];

  const manual = laminar.wallets.filter((w) => w._origin !== SCOUT_ORIGIN_MARKER);
  const manualAddresses = new Set(manual.map((w) => w.address));
  const seen = new Set(manualAddresses);
  const merged = [...manual];
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < scout.wallets.length; i++) {
    const w = scout.wallets[i];
    if (seen.has(w.address)) {
      skipped++;
      continue;
    }
    seen.add(w.address);
    merged.push({
      name: w.name,
      address: w.address,
      category: w.category || "scout_top",
      type: w.type || "lp",
      addedAt: w.addedAt || new Date().toISOString(),
      _origin: SCOUT_ORIGIN_MARKER,
    });
    added++;
  }

  return {
    file,
    applied: apply,
    summary: `smart-wallets: ${manual.length} manual preserved, ${added} added, ${skipped} already present (total ${merged.length})`,
    write: () => {
      backupFile(file);
      writeJson(file, { wallets: merged });
    },
  };
}

// ─── 2. Lessons ────────────────────────────────────────────────────────────
function syncLessons(scout) {
  const file = path.join(targetDir, TARGET_FILES.lessons);
  const laminar = readJson(file, { lessons: [], performance: [] });
  if (!Array.isArray(laminar.lessons)) laminar.lessons = [];
  if (!Array.isArray(laminar.performance)) laminar.performance = [];

  const filteredPerf = filterPerformance(scout.performance);
  const filteredLessons = filterLessons(scout.lessons, filteredPerf.map((p) => p.position));
  const filteredLessonPositions = new Set(filteredLessons.map(lessonPosition).filter(Boolean));

  const existingPerfIds = new Set(laminar.performance.map((p) => p.position));
  const existingLessonPositions = new Set(
    laminar.lessons.filter((l) => l.sourceType === "scout_performance").map((l) => l.position).filter(Boolean),
  );
  let lessonsAdded = 0;
  let perfAdded = 0;

  for (const perf of filteredPerf) {
    if (!existingPerfIds.has(perf.position)) {
      laminar.performance.push(perf);
      perfAdded++;
    }
  }

  for (const lesson of filteredLessons) {
    const pos = lessonPosition(lesson);
    if (!pos || !filteredLessonPositions.has(pos)) continue;
    if (!existingLessonPositions.has(pos)) {
      laminar.lessons.push(lesson);
      lessonsAdded++;
    }
  }

  return {
    file,
    applied: apply,
    summary: `lessons: ${lessonsAdded} new lessons, ${perfAdded} new performance records (score >= ${minWalletScore}, max perf ${maxRecords || "unlimited"}, max lessons ${maxLessons || "unlimited"})`,
    write: () => {
      backupFile(file);
      writeJson(file, laminar);
    },
  };
}

// ─── 3. Signal Weights ─────────────────────────────────────────────────────
function syncSignalWeights(scout) {
  const file = path.join(targetDir, TARGET_FILES.signalWeights);
  const laminar = readJson(file, {
    weights: Object.fromEntries(Object.keys(scout.weights).map((k) => [k, 1.0])),
    history: [],
  });

  const changes = scout.history?.[0]?.changes || [];
  const merged = {
    weights: { ...laminar.weights, ...scout.weights },
    last_recalc: scout.last_recalc,
    recalc_count: (laminar.recalc_count || 0) + 1,
    history: [...(laminar.history || []), ...(scout.history || [])].slice(-20),
    _meta: scout._meta,
  };

  return {
    file,
    applied: apply,
    summary: `signal-weights: ${changes.length} adjustments, ${Object.keys(merged.weights).length} signals`,
    write: () => {
      backupFile(file);
      writeJson(file, merged);
    },
  };
}

// ─── 4. Pool Memory ────────────────────────────────────────────────────────
function syncPoolMemory(scout) {
  const file = path.join(targetDir, TARGET_FILES.poolMemory);
  const laminar = readJson(file, {});
  let addedPools = 0;
  let addedDeploys = 0;

  for (const [pool, entry] of Object.entries(scout)) {
    if (pool.startsWith("_")) continue;
    if (!laminar[pool]) {
      laminar[pool] = {
        ...entry,
        deploys: (entry.deploys || []).slice(-maxPoolDeploys),
      };
      addedPools++;
      addedDeploys += laminar[pool].deploys.length;
      continue;
    }
    const existing = laminar[pool];
    const seen = new Set((existing.deploys || []).map((d) => `${d.deployed_at}_${d.closed_at}_${d.position || ""}`));
    const incomingDeploys = (entry.deploys || []).slice(-maxPoolDeploys);
    for (const d of incomingDeploys) {
      const key = `${d.deployed_at}_${d.closed_at}_${d.position || ""}`;
      if (!seen.has(key)) {
        existing.deploys.push(d);
        seen.add(key);
        addedDeploys++;
      }
    }
    existing.total_deploys = existing.deploys.length;
    const withPnl = existing.deploys.filter((d) => d.pnl_pct != null);
    if (withPnl.length > 0) {
      existing.avg_pnl_pct = Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
      existing.win_rate = Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
    }
    existing.last_deployed_at = existing.deploys[existing.deploys.length - 1]?.closed_at || null;
    existing.last_outcome = (withPnl[withPnl.length - 1]?.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
  }

  return {
    file,
    applied: apply,
    summary: `pool-memory: ${addedPools} new pools, ${addedDeploys} new deploys`,
    write: () => {
      backupFile(file);
      writeJson(file, laminar);
    },
  };
}

// ─── 5. Decision Log ───────────────────────────────────────────────────────
function syncDecisionLog(traces) {
  const file = path.join(targetDir, TARGET_FILES.decisionLog);
  const laminar = readJson(file, { decisions: [] });
  if (!Array.isArray(laminar.decisions)) laminar.decisions = [];

  const existingIds = new Set(laminar.decisions.map((d) => d.id));
  let added = 0;
  const newDecisions = [];

  for (const trace of traces) {
    if (!existingIds.has(trace.id)) {
      newDecisions.push({
        id: trace.id,
        ts: trace.ts,
        type: trace.decision?.type || "note",
        actor: trace.actor || "SCOUT_SCREENER",
        pool: trace.inputs?.candidate_pools?.[0] || null,
        pool_name: trace.inputs?.candidate_pools?.[0] || null,
        position: trace._scout?.position || null,
        summary: trace.decision?.summary || "Scout-derived trace",
        reason: trace.final_content || null,
        risks: [],
        metrics: {
          pnl_usd: trace._scout?.pnl_usd,
          pnl_pct: trace._scout?.pnl_pct,
          close_reason: trace._scout?.close_reason,
          duration_hours: trace._scout?.duration_hours,
        },
        rejected: trace.inputs?.filtered || [],
      });
      added++;
    }
  }

  const maxDecisions = Math.max(100, maxRecords || 5000);
  laminar.decisions = [...newDecisions, ...laminar.decisions].slice(0, maxDecisions);

  return {
    file,
    applied: apply,
    summary: `decision-log: ${added} new traces (kept ${laminar.decisions.length} total)`,
    write: () => {
      backupFile(file);
      writeJson(file, laminar);
    },
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  initDb();
  try {
    log("sync_laminar", `target=${targetDir} mode=${apply ? "APPLY" : "dry-run"}`);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`target directory does not exist: ${targetDir}`);
    }

    const scout = exportLaminarTrainingOutputs();
    const scoutLessons = scout.lessonsPath ? readJson(scout.lessonsPath, { lessons: [], performance: [] }) : { lessons: [], performance: [] };
    const scoutWeights = scout.weightsPath ? readJson(scout.weightsPath, {}) : {};
    const scoutPoolMemory = scout.poolMemoryPath ? readJson(scout.poolMemoryPath, {}) : {};
    const scoutTraces = scout.tracesPath ? readJsonl(scout.tracesPath).filter((t) => t._scout) : [];
    const smartWalletFeed = (await import("../src/laminar-feed/smart-wallet-feed.js")).buildSmartWalletFeed();

    const results = [
      syncSmartWallets(smartWalletFeed),
      syncLessons(scoutLessons),
      syncSignalWeights(scoutWeights),
      syncPoolMemory(scoutPoolMemory),
      syncDecisionLog(scoutTraces),
    ];

    for (const r of results) {
      log("sync_laminar", r.summary);
      if (apply) r.write();
    }

    if (!apply) {
      log("sync_laminar", "dry-run complete — no files written. Use --apply to persist.");
    } else {
      log("sync_laminar", "sync complete — files written + backups created (.scout-backup-<ts>)");
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  log("sync_laminar_error", err.message);
  process.exit(1);
});
