import fs from "fs";
import path from "path";
import { config } from "../../config/config.js";
import { log } from "../utils/logger.js";
import { getDb } from "../db/index.js";
import { getPositionsByWallet, positionStats } from "../db/positions.js";
import { getWallet } from "../db/wallets.js";
import { getCachedScreenedPool } from "../screener/pool-screener.js";
import { fetchWalletPortfolioTotal, fetchWalletPositionHistory } from "../screener/metrics-fetcher.js";

const INSIGHTS_DIR = path.join(config.dataset.exportPath ? path.dirname(config.dataset.exportPath) : ".", "insights");

const DEFAULT_PROMPT = `You are an expert Meteora DLMM liquidity-provider strategist.

Analyze the wallet below. Describe:
1. Its overall LP strategy (range width, holding time, token preferences, single-sided vs balanced).
2. What has worked well and what has failed.
3. Risk patterns (concentration, out-of-range positions, drawdowns).
4. Concrete, actionable recommendations for the next 3 positions this wallet should take.

Use the provided metrics and position history. Be specific and data-driven.`;

function dexscreenerUrl(poolAddress) {
  return `https://dexscreener.com/solana/${poolAddress}`;
}

function gmgnUrl(tokenMintOrPool) {
  return `https://gmgn.ai/defi/quotation/v1/sol/${tokenMintOrPool}`;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_SYMBOLS = new Set(["sol", "wsol"]);

function isSolToken(token) {
  if (!token) return false;
  const mint = String(token?.address || "").toLowerCase();
  const symbol = String(token?.symbol || "").toLowerCase();
  return mint === SOL_MINT.toLowerCase() || SOL_SYMBOLS.has(symbol);
}

function isSolPair(tokenPair) {
  if (!tokenPair) return false;
  const parts = String(tokenPair).toLowerCase().split("/");
  return parts.some((p) => SOL_SYMBOLS.has(p.trim()));
}

function tokenLifetime(positions) {
  const byToken = new Map();
  for (const p of positions) {
    const token = p.token_pair?.split("/")[0] || "UNKNOWN";
    const acc = byToken.get(token) || {
      token_symbol: token,
      pool_count: new Set(),
      positions: [],
      deposits_usd: 0,
      fees_usd: 0,
      pnl_usd: 0,
      wins: 0,
      losses: 0,
    };
    acc.pool_count.add(p.pool_address);
    acc.positions.push(p);
    acc.deposits_usd += Number(p.capital_usd) || 0;
    acc.fees_usd += Number(p.fees_earned_usd) || 0;
    acc.pnl_usd += Number(p.pnl_usd) || 0;
    if (p.status === "closed") {
      if (Number(p.pnl_usd) > 0) acc.wins += 1;
      else acc.losses += 1;
    }
    byToken.set(token, acc);
  }

  return [...byToken.values()]
    .map((t) => ({
      token_symbol: t.token_symbol,
      pool_count: t.pool_count.size,
      positions_count: t.positions.length,
      deposits_usd: Number(t.deposits_usd.toFixed(2)),
      fees_usd: Number(t.fees_usd.toFixed(2)),
      pnl_usd: Number(t.pnl_usd.toFixed(2)),
      pnl_pct: t.deposits_usd > 0 ? Number(((t.pnl_usd / t.deposits_usd) * 100).toFixed(2)) : null,
      win_rate: t.wins + t.losses > 0 ? Number((t.wins / (t.wins + t.losses)).toFixed(3)) : null,
      wins: t.wins,
      losses: t.losses,
    }))
    .sort((a, b) => b.positions_count - a.positions_count)
    .slice(0, 100);
}

function positionDetail(p) {
  const poolScreen = getCachedScreenedPool(p.pool_address);
  return {
    id: p.id,
    pool_address: p.pool_address,
    token_pair: p.token_pair,
    status: p.status,
    entry_at: p.entry_timestamp ? new Date(p.entry_timestamp * 1000).toISOString() : null,
    exit_at: p.exit_timestamp ? new Date(p.exit_timestamp * 1000).toISOString() : null,
    duration_hours: p.duration_hours,
    bin_lower: p.bin_lower,
    bin_upper: p.bin_upper,
    bin_range_width: p.bin_range_width,
    capital_usd: p.capital_usd,
    fees_earned_usd: p.fees_earned_usd,
    pnl_usd: p.pnl_usd,
    pnl_pct: p.pnl_pct,
    fee_yield: p.fee_yield,
    is_profitable: p.is_profitable,
    dexscreener_url: dexscreenerUrl(p.pool_address),
    gmgn_url: gmgnUrl(p.pool_address),
    pool_screen: poolScreen
      ? {
          tvl: poolScreen.pool?.tvl,
          volume_24h: poolScreen.pool?.volume_window,
          fee_apr: poolScreen.pool?.fee_apr,
          degen_score: poolScreen.pool?.degen_score,
          organic_score: poolScreen.pool?.organic_score,
        }
      : null,
  };
}

function enrichWithMeteora(walletAddress, positions) {
  // Meteora position IDs are real account addresses (not stubs). Tag them.
  return positions.map((p) => ({
    ...p,
    has_meteora_detail: /^[A-Za-z0-9]{43,44}$/.test(p.id),
  }));
}

export async function buildWalletInsight(address, { includeOpen = true, includeClosed = true } = {}) {
  const wallet = getWallet(address);
  if (!wallet) throw new Error(`Wallet ${address} not found`);

  const positions = getPositionsByWallet(address);
  const stats = positionStats(address);

  let meteoraTotal = null;
  try {
    meteoraTotal = await fetchWalletPortfolioTotal(address);
  } catch (err) {
    log("insights_warn", `fetchWalletPortfolioTotal ${address.slice(0, 8)}: ${err.message}`);
  }

  let meteoraPositions = [];
  try {
    const history = await fetchWalletPositionHistory(address, {
      status: "all",
      daysBack: config.discovery.evaluationBackfillDays,
      pageSize: 100,
    });
    meteoraPositions = config.screening.requireSolPair
      ? history.positions.filter((p) => isSolPair(`${p.tokenXSymbol}/${p.tokenYSymbol}`))
      : history.positions;
  } catch (err) {
    log("insights_warn", `fetchWalletPositionHistory ${address.slice(0, 8)}: ${err.message}`);
  }

  let filtered = positions.filter((p) => {
    if (p.status === "open" && !includeOpen) return false;
    if (p.status === "closed" && !includeClosed) return false;
    return true;
  });
  if (config.screening.requireSolPair) {
    filtered = filtered.filter((p) => isSolPair(p.token_pair));
  }

  const enrichedPositions = enrichWithMeteora(address, filtered);
  const lifetime = tokenLifetime(enrichedPositions);

  return {
    wallet_address: address,
    generated_at: new Date().toISOString(),
    prompt: DEFAULT_PROMPT,
    summary: {
      status: wallet.status,
      score: wallet.score,
      win_rate: wallet.win_rate,
      total_positions: wallet.total_positions,
      open_positions: wallet.open_positions,
      pool_count: wallet.pool_count,
      total_pnl_usd: wallet.total_pnl_usd,
      total_fees_usd: wallet.total_fees_usd,
      avg_fee_yield: wallet.avg_fee_yield,
      preferred_strategy: wallet.preferred_strategy,
      preferred_range_style: wallet.preferred_range_style,
      tags: wallet.tags ? JSON.parse(wallet.tags) : [],
      realized_pnl_meteora: meteoraTotal?.totalPnlUsd ?? null,
      total_closed_positions_meteora: config.screening.requireSolPair
        ? meteoraPositions.filter((p) => p.isClosed).length
        : (meteoraTotal?.totalClosedPositions ?? null),
      position_stats: stats,
    },
    token_lifetime: lifetime,
    positions: enrichedPositions.map(positionDetail),
    meteora_positions_count: meteoraPositions.length,
  };
}

export function exportWalletInsightJson(insight, outDir = INSIGHTS_DIR) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${insight.wallet_address}.json`);
  fs.writeFileSync(file, JSON.stringify(insight, null, 2));
  log("insights", `exported wallet insight JSON → ${file}`);
  return file;
}

export function exportWalletInsightCsv(insight, outDir = INSIGHTS_DIR) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${insight.wallet_address}.csv`);

  const rows = insight.token_lifetime.map((t) => ({
    wallet_address: insight.wallet_address,
    wallet_status: insight.summary.status,
    wallet_score: insight.summary.score,
    wallet_win_rate: insight.summary.win_rate,
    token_symbol: t.token_symbol,
    pool_count: t.pool_count,
    positions_count: t.positions_count,
    deposits_usd: t.deposits_usd,
    fees_usd: t.fees_usd,
    pnl_usd: t.pnl_usd,
    pnl_pct: t.pnl_pct,
    win_rate: t.win_rate,
    wins: t.wins,
    losses: t.losses,
    dexscreener_url: dexscreenerUrl(t.pool_count === 1 ? insight.positions.find((p) => p.token_pair?.startsWith(t.token_symbol))?.pool_address || "" : ""),
    gmgn_url: gmgnUrl(t.token_symbol),
  }));

  const cols = [
    "wallet_address", "wallet_status", "wallet_score", "wallet_win_rate",
    "token_symbol", "pool_count", "positions_count",
    "deposits_usd", "fees_usd", "pnl_usd", "pnl_pct",
    "win_rate", "wins", "losses",
    "dexscreener_url", "gmgn_url",
  ];

  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(","));

  fs.writeFileSync(file, lines.join("\n") + "\n");
  log("insights", `exported wallet insight CSV → ${file}`);
  return file;
}

export function exportWalletInsightJsonl(insight, outDir = INSIGHTS_DIR) {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${insight.wallet_address}.jsonl`);

  const lines = [];
  for (const p of insight.positions) {
    const example = {
      messages: [
        { role: "system", content: DEFAULT_PROMPT },
        { role: "user", content: JSON.stringify({
            wallet: insight.summary,
            position: p,
            token_context: insight.token_lifetime.find((t) => p.token_pair?.startsWith(t.token_symbol)),
          }) },
        { role: "assistant", content: JSON.stringify({
            profitable: p.is_profitable === 1,
            pnl_usd: p.pnl_usd,
            pnl_pct: p.pnl_pct,
            reasoning: p.is_profitable === 1
              ? `Profitable ${p.token_pair} position: fees $${p.fees_earned_usd?.toFixed(2)} outweighed IL.`
              : `Unprofitable ${p.token_pair} position: IL exceeded fees.`,
          }) },
      ],
    };
    lines.push(JSON.stringify(example));
  }

  fs.writeFileSync(file, lines.join("\n") + "\n");
  log("insights", `exported wallet insight JSONL → ${file}`);
  return file;
}

export async function exportWalletInsights({
  outDir = INSIGHTS_DIR,
  statuses = ["tracked", "top"],
  limit = 100,
  format = "json",
} = {}) {
  const wallets = getDb()
    .prepare(`SELECT address FROM wallets WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY score DESC LIMIT ${limit}`)
    .all(...statuses);

  const result = { json: [], csv: [], jsonl: [], errors: [] };
  for (const { address } of wallets) {
    try {
      const insight = await buildWalletInsight(address);
      if (format === "json" || format === "all") result.json.push(exportWalletInsightJson(insight, outDir));
      if (format === "csv" || format === "all") result.csv.push(exportWalletInsightCsv(insight, outDir));
      if (format === "jsonl" || format === "all") result.jsonl.push(exportWalletInsightJsonl(insight, outDir));
    } catch (err) {
      log("insights_warn", `exportWalletInsights ${address.slice(0, 8)}: ${err.message}`);
      result.errors.push({ address, error: err.message });
    }
  }

  log("insights", `exported ${result.json.length} wallet(s) → ${outDir}`);
  return result;
}
