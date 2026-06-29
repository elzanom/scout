import fs from "fs";
import { log } from "../utils/logger.js";
import { repoPath } from "../../repo-root.js";
import { withRetry } from "../utils/retry.js";

const USER_CONFIG_PATH = repoPath("scout-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _offset = 0;
let _polling = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (err) {
    log("telegram_warn", `Invalid scout-config.json; chatId not loaded: ${err.message}`);
  }
  return fromConfig || fromEnv || null;
}

export function loadChatId() {
  chatId = resolveChatId();
}

loadChatId();

export function isEnabled() {
  return !!TOKEN && !!chatId;
}

async function postTelegram(method, body, raw = false) {
  if (!TOKEN || (!chatId && !raw)) return null;
  const payload = raw ? body : { chat_id: chatId, ...body };
  try {
    return await withRetry(async () => {
      const res = await fetch(`${BASE}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        if (res.status === 401) log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN`);
        else log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
        return null;
      }
      return await res.json();
    });
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!isEnabled()) return null;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html) {
  if (!isEnabled()) return null;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!isEnabled()) return null;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  if (chatId && incomingChatId !== String(chatId)) return false;
  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }
  return true;
}

async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) log("telegram_error", `Poll error: ${e.message}`);
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help", description: "Show commands" },
  { command: "status", description: "Scout state summary" },
  { command: "wallets", description: "List wallets by status" },
  { command: "top", description: "Top wallets" },
  { command: "signals", description: "Recent signals" },
  { command: "weights", description: "Darwinian signal weights" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set — inbound bot commands disabled.");
  }
  _polling = true;
  poll(onMessage);
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function notifySignal(signal) {
  if (!isEnabled()) return null;
  const pair = signal.token_pair || "—";
  const wallet = signal.trigger?.wallet || signal.triggered_by || "—";
  const pool = signal.pool || signal.pool_address || "—";
  const feeApr = signal.pool_metrics?.fee_apr ?? signal.fee_apr ?? null;
  const tvl = signal.pool_metrics?.tvl ?? signal.tvl ?? null;
  const volume = signal.pool_metrics?.volume_24h ?? signal.volume_24h ?? null;
  const html =
    `🎯 <b>New Scout Signal</b>\n\n` +
    `Pair: <b>${escapeHtml(pair)}</b>\n` +
    `Confidence: <b>${(signal.confidence ?? signal.combined_confidence ?? "?")}</b>\n` +
    `Wallet score: ${signal.trigger?.wallet_score ?? signal.wallet_score ?? "?"}\n` +
    `Pool score: ${signal.pool_score ?? "?"}\n\n` +
    `Wallet:\n<code>${escapeHtml(wallet)}</code>\n\n` +
    `Pool:\n<code>${escapeHtml(pool)}</code>\n\n` +
    `Fee APR: ${feeApr != null ? (feeApr * 100).toFixed(1) + "%" : "?"}\n` +
    `TVL: ${tvl != null ? "$" + Number(tvl).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "?"}\n` +
    `Volume 24h: ${volume != null ? "$" + Number(volume).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "?"}`;
  return sendHTML(html);
}

export async function sendAlert(title, details) {
  if (!isEnabled()) return null;
  const html =
    `⚠️ <b>${escapeHtml(title)}</b>\n\n` +
    details.map((d) => escapeHtml(d)).join("\n");
  return sendHTML(html);
}

export async function notifyError(context, error) {
  return sendAlert("Scout Error", [
    `Context: ${context}`,
    `Error: ${error?.message || error}`,
    `Time: ${new Date().toISOString()}`,
  ]);
}

/** Discovery report: pools that passed screening and were studied. */
export async function notifyPools({ pass, studied, newCandidates, errors = [] }) {
  if (!isEnabled()) return null;
  const poolsText = Array.isArray(pass) && pass.length
    ? pass.slice(0, 10).map((p) => `• ${escapeHtml(p.name || p.pool || "unknown")} — TVL $${Number(p.tvl || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join("\n")
    : "No pools passed screening.";
  const html =
    `🏊 <b>Pool Discovery Report</b>\n\n` +
    `Passed screening: <b>${pass?.length ?? 0}</b>\n` +
    `Studied: <b>${studied ?? 0}</b> pool(s)\n` +
    `New candidates: <b>${newCandidates ?? 0}</b> wallet(s)\n\n` +
    `Top pools:\n${poolsText}`;
  return sendHTML(html);
}

/** Wallet discovery report: newly found candidate wallets. */
export async function notifyWallets({ newWallets = [], source = "pool_discovery" }) {
  if (!isEnabled() || !newWallets.length) return null;
  const list = newWallets.slice(0, 15).map((w) => `• <code>${escapeHtml(w)}</code>`).join("\n");
  const html =
    `👛 <b>Wallet Discovery Report</b> — <i>${escapeHtml(source)}</i>\n\n` +
    `New candidates: <b>${newWallets.length}</b>\n\n` +
    list +
    (newWallets.length > 15 ? `\n<i>...and ${newWallets.length - 15} more</i>` : "");
  return sendHTML(html);
}

/** Wallet performance report: evaluation outcomes. */
export async function notifyPerformance({ summary = {}, details = [], pool, name } = {}) {
  if (!isEnabled() || !details.length) return null;
  const poolLine = pool ? `Pool: <b>${escapeHtml(name || pool.slice(0, 12))}</b>\n` : "";
  const statuses = Object.keys(summary).length
    ? Object.entries(summary).map(([k, v]) => `${escapeHtml(k)}: <b>${v}</b>`).join(" | ") + "\n\n"
    : "";
  const list = details.slice(0, 15).map((d) => {
    const emoji = d.status === "tracked" ? "🟢" : d.status === "top" ? "🏆" : d.status === "rejected" ? "🔴" : d.status === "error" ? "⚠️" : "⚪";
    const perf = d.status === "error"
      ? `error: ${escapeHtml(d.error || "unknown")}`
      : `score ${d.score ?? "?"}, wr ${d.win_rate != null ? (d.win_rate * 100).toFixed(0) + "%" : "?"}, pos ${d.positions ?? "?"}, fee ${d.fee_yield != null ? Number(d.fee_yield).toFixed(1) : "?"}`;
    return `${emoji} <code>${escapeHtml(d.address?.slice(0, 12) || "unknown")}…</code> — ${perf}`;
  }).join("\n");
  const html =
    `📊 <b>Wallet Performance Report</b>\n\n` +
    poolLine +
    statuses +
    `${list}` +
    (details.length > 15 ? `\n<i>...and ${details.length - 15} more</i>` : "");
  return sendHTML(html);
}

/** Per-pool report: pool passed screening + study result. */
export async function notifyPoolStudy({ pool, name, tvl, volume, feeApr, owners, newWallets, errors }) {
  if (!isEnabled()) return null;
  const tvlStr = tvl != null ? `$${Number(tvl).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "?";
  const volStr = volume != null ? `$${Number(volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "?";
  const feeStr = feeApr != null ? `${(feeApr * 100).toFixed(1)}%` : "?";
  const newList = newWallets?.length
    ? newWallets.slice(0, 10).map((w) => `• <code>${escapeHtml(w)}</code>`).join("\n")
    : "<i>No new wallets</i>";
  const errorText = errors?.length ? `\n⚠️ Errors: ${escapeHtml(errors.join("; ").slice(0, 200))}` : "";
  const html =
    `🏊 <b>Pool Study</b>\n\n` +
    `Pool: <b>${escapeHtml(name || pool?.slice(0, 12) || "unknown")}</b>\n` +
    `TVL: ${tvlStr} | Vol: ${volStr} | Fee APR: ${feeStr}\n` +
    `Top LPers studied: <b>${owners ?? 0}</b>\n` +
    `New wallets: <b>${newWallets?.length ?? 0}</b>\n\n` +
    `${newList}` +
    errorText;
  return sendHTML(html);
}

/** Per-pool wallet discovery report (lightweight companion to notifyPoolStudy). */
export async function notifyPoolWalletDiscovery({ pool, name, newWallets }) {
  if (!isEnabled() || !newWallets?.length) return null;
  const list = newWallets.slice(0, 15).map((w) => `• <code>${escapeHtml(w)}</code>`).join("\n");
  const html =
    `👛 <b>New Wallets from Pool</b> — ${escapeHtml(name || pool?.slice(0, 12) || "unknown")}\n\n` +
    `Count: <b>${newWallets.length}</b>\n\n` +
    list +
    (newWallets.length > 15 ? `\n<i>...and ${newWallets.length - 15} more</i>` : "");
  return sendHTML(html);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
