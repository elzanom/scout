import fs from "fs";
import path from "path";
import { ZipArchive } from "archiver";
import { getDb } from "../db/index.js";
import { config } from "../../config/config.js";
import { getStateCache, touchCycle } from "./state-cache.js";
import { loadWeights, getWeightsSummary } from "../signals/weights.js";
import { buildWalletInsight, exportWalletInsights } from "../dataset/insights.js";
import { buildSmartWalletFeed, writeSmartWalletFeed } from "../laminar-feed/smart-wallet-feed.js";
import { exportLaminarTrainingOutputs } from "../dataset/laminar-export.js";
import { formatTokenPair } from "../db/token-info.js";
import { repoPath } from "../../repo-root.js";

const VERSION = "0.1.0";
const DEFAULT_LIMIT = 100;

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, { error: "not found" }, 404);
}

function getDbSafe() {
  try { return getDb(); } catch { return null; }
}

function parseQuery(url) {
  const q = {};
  for (const [k, v] of url.searchParams) q[k] = v;
  return q;
}

function limitOffset(q, defaults = { limit: 50, max: 50_000 }) {
  const limit = Math.min(parseInt(q.limit, 10) || defaults.limit, defaults.max);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { limit, offset };
}

export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const q = parseQuery(url);
  const db = getDbSafe();

  if (!db) return json(res, { error: "database not ready" }, 503);

  try {
    switch (url.pathname) {
      case "/api/health":
        return json(res, { ok: true, db: true, uptime: process.uptime(), version: VERSION });

      case "/api/state":
        return json(res, getStateCache());

      case "/api/wallets": {
        const { limit, offset } = limitOffset(q);
        const where = [];
        const params = { limit, offset };
        if (q.status) { where.push("status = @status"); params.status = q.status; }
        if (q.is_top === "1" || q.is_top === "true") { where.push("is_top_wallet = 1"); }
        if (q.is_top === "0" || q.is_top === "false") { where.push("is_top_wallet = 0"); }
        const sql = `SELECT * FROM wallets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score DESC LIMIT @limit OFFSET @offset`;
        return json(res, { wallets: db.prepare(sql).all(params) });
      }

      case "/api/wallets/":
      case "/api/wallets": {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 2) {
          const address = segments[1];
          const wallet = db.prepare("SELECT * FROM wallets WHERE address = ?").get(address);
          if (!wallet) return notFound(res);
          const positions = db.prepare("SELECT * FROM positions WHERE wallet_address = ? ORDER BY entry_timestamp DESC LIMIT 100").all(address).map((p) => ({ ...p, token_pair: formatTokenPair(p), token_pair_raw: p.token_pair }));
          const discovery = db.prepare("SELECT * FROM wallet_discovery_log WHERE wallet_address = ? ORDER BY discovered_at DESC LIMIT 50").all(address);
          return json(res, { wallet, positions, discovery_log: discovery });
        }
        break;
      }

      case "/api/positions": {
        const { limit, offset } = limitOffset(q);
        const where = [];
        const params = { limit, offset };
        if (q.status) { where.push("status = @status"); params.status = q.status; }
        if (q.wallet) { where.push("wallet_address = @wallet"); params.wallet = q.wallet; }
        if (q.pool) { where.push("pool_address = @pool"); params.pool = q.pool; }
        const sql = `SELECT * FROM positions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY entry_timestamp DESC LIMIT @limit OFFSET @offset`;
        const rows = db.prepare(sql).all(params);
        const positions = rows.map((p) => ({ ...p, token_pair: formatTokenPair(p), token_pair_raw: p.token_pair }));
        return json(res, { positions });
      }

      case "/api/signals": {
        const { limit, offset } = limitOffset(q);
        const params = { limit, offset };
        const where = [];
        if (q.status) { where.push("status = @status"); params.status = q.status; }
        const sql = `SELECT * FROM signals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`;
        return json(res, { signals: db.prepare(sql).all(params) });
      }

      case "/api/snapshots": {
        const { limit, offset } = limitOffset(q, { limit: 50, max: 500 });
        const params = { limit, offset };
        const where = [];
        if (q.pool) { where.push("pool_address = @pool"); params.pool = q.pool; }
        const sql = `SELECT * FROM market_snapshots ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`;
        return json(res, { snapshots: db.prepare(sql).all(params) });
      }

      case "/api/pools": {
        const rows = db.prepare(`
          SELECT pool_address, MAX(timestamp) AS latest_at, COUNT(*) AS snapshot_count
          FROM market_snapshots
          GROUP BY pool_address
          ORDER BY latest_at DESC
          LIMIT 200
        `).all();
        const enriched = rows.map((r) => {
          const latest = db.prepare("SELECT * FROM market_snapshots WHERE pool_address = ? ORDER BY timestamp DESC LIMIT 1").get(r.pool_address);
          return { ...r, latest };
        });
        return json(res, { pools: enriched });
      }

      case "/api/logs": {
        const lines = Math.min(parseInt(q.lines, 10) || 100, 500);
        const level = q.level;
        const today = new Date().toISOString().split("T")[0];
        const logFile = repoPath("logs", `scout-${today}.log`);
        if (!fs.existsSync(logFile)) return json(res, { logs: [] });
        let tail = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
        if (level) tail = tail.filter((l) => l.includes(`[${level.toUpperCase()}]`));
        const parsed = tail.slice(-lines).map((line) => {
          const m = line.match(/^\[(.+?)\] \[(.+?)\] (.+)$/);
          return m ? { timestamp: m[1], level: m[2].toLowerCase(), message: m[3] } : { timestamp: "", level: "info", message: line };
        });
        return json(res, { logs: parsed });
      }

      case "/api/control/restart": {
        if (req.method !== "POST") return json(res, { error: "method not allowed" }, 405);
        const secret = process.env.DASHBOARD_SECRET || "";
        if (secret) {
          const provided = req.headers["x-dashboard-secret"] || q.secret;
          if (provided !== secret) return json(res, { error: "unauthorized" }, 401);
        }
        setTimeout(() => {
          process.emit("SIGTERM");
        }, 100);
        return json(res, { ok: true, message: "SIGTERM sent — respawn via PM2/manual" });
      }

      case "/api/config": {
        return json(res, {
          discovery: config.discovery,
          tiers: config.tiers,
          screening: config.screening,
          signals: config.signals,
          collection: config.collection,
          output: { mode: config.output.mode, signalPath: config.output.signalPath },
          dataset: config.dataset,
        });
      }

      case "/api/weights": {
        return json(res, { weights: loadWeights(), summary: getWeightsSummary() });
      }

      case "/api/insights": {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 2) {
          const address = segments[1];
          const includeOpen = q.includeOpen !== "false";
          const includeClosed = q.includeClosed !== "false";
          try {
            const insight = await buildWalletInsight(address, { includeOpen, includeClosed });
            return json(res, { insight });
          } catch (err) {
            const status = err.message?.includes("not found") ? 404 : 500;
            return json(res, { error: err.message }, status);
          }
        }

        const statuses = q.statuses ? q.statuses.split(",").filter(Boolean) : ["top", "tracked"];
        const limit = Math.min(parseInt(q.limit, 10) || 50, 500);
        const format = ["json", "csv", "jsonl", "all"].includes(q.format) ? q.format : "json";
        try {
          const result = await exportWalletInsights({ statuses, limit, format });
          return json(res, { ok: true, format, exported: result });
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      case "/api/laminar/smart-wallets": {
        if (req.method === "POST") {
          try {
            const result = writeSmartWalletFeed();
            return json(res, { ok: true, ...result });
          } catch (err) {
            return json(res, { error: err.message }, 500);
          }
        }
        const limit = Math.min(parseInt(q.limit, 10) || DEFAULT_LIMIT, 500);
        const minScore = Number(q.min_score ?? config.tiers.topWalletMinScore ?? 0);
        return json(res, buildSmartWalletFeed({ limit, minScore }));
      }

      case "/api/laminar/training": {
        if (req.method === "POST") {
          try {
            const result = await exportLaminarTrainingOutputs();
            return json(res, { ok: true, ...result });
          } catch (err) {
            return json(res, { error: err.message }, 500);
          }
        }
        return json(res, { error: "method not allowed" }, 405);
      }

      case "/api/laminar/training/zip": {
        if (req.method !== "POST" && req.method !== "GET") {
          return json(res, { error: "method not allowed" }, 405);
        }
        try {
          // Always refresh training outputs before zipping so the download is current.
          const exported = await exportLaminarTrainingOutputs();
          const files = [
            exported.lessonsPath,
            exported.performancePath,
            exported.messagesPath,
            exported.weightsPath,
            exported.poolMemoryPath,
            exported.tuningJsonPath,
            exported.tuningPromptPath,
            config.dataset.exportPath,
          ].filter(Boolean).filter((p) => fs.existsSync(p));

          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = `laminar-scout-training-${timestamp}.zip`;

          res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${filename}"`,
          });

          const archive = new ZipArchive({ zlib: { level: 6 } });
          archive.on("error", (err) => {
            log("api_zip_error", err.message);
            if (!res.headersSent) json(res, { error: err.message }, 500);
          });
          archive.on("warning", (warn) => log("api_zip_warn", warn.message));
          archive.pipe(res);

          for (const filePath of files) {
            const name = path.basename(filePath);
            archive.file(filePath, { name });
          }

          // Include a small manifest so Laminar/Vipera knows what each file is.
          const manifest = {
            generated_at: new Date().toISOString(),
            source: "laminar-scout",
            files: files.map((p) => path.basename(p)),
            note: "For manual tuning, start with laminar-tuning-prompt.txt and laminar-tuning-summary.json. Use laminar-messages.jsonl only for fine-tuning. Skip decision-traces.jsonl unless debugging.",
          };
          archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

          await archive.finalize();
          return;
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      default:
        return notFound(res);
    }
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
}
