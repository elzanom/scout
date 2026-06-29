import { getDb } from "../db/index.js";
import { getStateCache } from "../webui/state-cache.js";
import { sendMessage, sendHTML } from "./telegram.js";
import { getWeightsSummary } from "../signals/weights.js";

const now = () => Math.floor(Date.now() / 1000);

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "?";
  return `${(n * 100).toFixed(1)}%`;
}

function shorten(addr, head = 8, tail = 4) {
  if (!addr) return "?";
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function handleBotCommand(text) {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/start":
    case "/help":
      return sendMessage(
        "Laminar Scout commands:\n" +
        "/status — scout summary\n" +
        "/wallets [all|candidate|tracked|rejected|top|new] — wallet list\n" +
        "/top — top wallets\n" +
        "/signals — recent signals\n" +
        "/weights — Darwinian signal weights"
      );

    case "/status": {
      const s = getStateCache();
      return sendMessage(
        `📊 Scout Status\n` +
        `Wallets: ${s.wallets} (top: ${s.topWallets})\n` +
        `Positions: ${s.openPositions} open / ${s.closedPositions} closed\n` +
        `Signals today: ${s.signalsToday}\n` +
        `Snapshots: ${s.snapshots}\n` +
        `Latest snapshot: ${s.latestSnapshotAt ? new Date(s.latestSnapshotAt * 1000).toLocaleString() : "—"}`
      );
    }

    case "/wallets": {
      const status = args[0] || null;
      const db = getDb();
      const base = "SELECT address, status, score, win_rate, total_positions, total_pnl_usd, evaluation_count, last_evaluated FROM wallets";
      let sql = base;
      const params = [];
      let title = "📋 Wallets";
      let orderBy = "score DESC";

      if (status === "new" || status === "fresh") {
        // Freshly discovered candidates that have never been evaluated.
        sql += " WHERE status = 'candidate' AND (evaluation_count IS NULL OR evaluation_count = 0)";
        orderBy = "first_seen DESC";
        title = "👶 Fresh Candidates";
      } else if (status && ["candidate", "tracked", "top", "rejected"].includes(status.toLowerCase())) {
        sql += " WHERE status = ?";
        params.push(status.toLowerCase());
        if (status.toLowerCase() === "candidate") {
          // Newest evaluations first, so the report varies cycle-to-cycle.
          orderBy = "last_evaluated DESC, score DESC";
          title = "⚪ Candidate Wallets";
        } else {
          title = `📋 ${status.charAt(0).toUpperCase() + status.slice(1)} Wallets`;
        }
      }
      sql += ` ORDER BY ${orderBy} LIMIT 20`;
      const rows = db.prepare(sql).all(...params);
      if (!rows.length) return sendMessage("No wallets found.");
      const lines = rows.map((w) => {
        const evalNote = w.status === "candidate" && w.evaluation_count
          ? ` | evals ${w.evaluation_count}`
          : "";
        return `<code>${escapeHtml(w.address)}</code>\n` +
          `${w.status} | score ${w.score?.toFixed(1) ?? "?"} | WR ${fmtPct(w.win_rate)} | pos ${w.total_positions ?? 0} | PNL ${fmtUsd(w.total_pnl_usd)}${evalNote}`;
      });
      return sendHTML(`${title}\n\n${lines.join("\n\n")}`);
    }

    case "/top": {
      const rows = getDb().prepare(
        "SELECT address, score, win_rate, total_positions, total_pnl_usd FROM wallets WHERE is_top_wallet = 1 ORDER BY score DESC LIMIT 20"
      ).all();
      if (!rows.length) return sendMessage("No top wallets yet.");
      const lines = rows.map((w) =>
        `<code>${escapeHtml(w.address)}</code>\n` +
        `score ${w.score?.toFixed(1) ?? "?"} | WR ${fmtPct(w.win_rate)} | pos ${w.total_positions ?? 0} | PNL ${fmtUsd(w.total_pnl_usd)}`
      );
      return sendHTML(`⭐ Top Wallets\n\n${lines.join("\n\n")}`);
    }

    case "/signals": {
      const rows = getDb().prepare(
        "SELECT pool_address, token_pair, combined_confidence, triggered_by, created_at FROM signals ORDER BY created_at DESC LIMIT 10"
      ).all();
      if (!rows.length) return sendMessage("No signals yet.");
      const lines = rows.map((s) =>
        `${escapeHtml(s.token_pair || "—")} | conf ${s.combined_confidence?.toFixed(2) ?? "?"} | ${new Date(s.created_at * 1000).toLocaleString()}\n` +
        `wallet: <code>${escapeHtml(s.triggered_by || "—")}</code>\n` +
        `pool:   <code>${escapeHtml(s.pool_address || "—")}</code>`
      );
      return sendHTML(`🎯 Recent Signals\n\n${lines.join("\n\n")}`);
    }

    case "/weights": {
      const summary = getWeightsSummary();
      return sendMessage("⚖️ Signal Weights\n\n" + summary);
    }

    default:
      return sendMessage("Unknown command. Try /help");
  }
}

export async function sendDailySummary() {
  const db = getDb();
  const s = getStateCache();
  const startOfDay = now() - 86400;

  const newWallets = db.prepare("SELECT COUNT(*) AS c FROM wallets WHERE created_at >= ?").get(startOfDay).c;
  const openToday = db.prepare("SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND entry_timestamp >= ?").get(startOfDay).c;
  const closedToday = db.prepare("SELECT COUNT(*) AS c FROM positions WHERE status = 'closed' AND exit_timestamp >= ?").get(startOfDay).c;
  const signalsToday = db.prepare("SELECT COUNT(*) AS c FROM signals WHERE created_at >= ?").get(startOfDay).c;
  const topList = db.prepare("SELECT address, score, win_rate, total_positions FROM wallets WHERE is_top_wallet = 1 ORDER BY score DESC LIMIT 5").all();

  let lines = [
    `📅 Daily Scout Summary`,
    ``,
    `New wallets: ${newWallets}`,
    `Top wallets: ${s.topWallets}`,
    `Positions opened today: ${openToday}`,
    `Positions closed today: ${closedToday}`,
    `Signals today: ${signalsToday}`,
    `Latest snapshot: ${s.latestSnapshotAt ? new Date(s.latestSnapshotAt * 1000).toLocaleString() : "—"}`,
  ];

  if (topList.length) {
    lines.push("", "⭐ Top wallets:");
    for (const w of topList) {
      lines.push(`<code>${escapeHtml(w.address)}</code>`);
      lines.push(`score ${w.score?.toFixed(1) ?? "?"} | WR ${fmtPct(w.win_rate)} | pos ${w.total_positions ?? 0}`);
    }
  }

  return sendHTML(lines.join("\n"));
}
