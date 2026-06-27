import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { REPO_ROOT, repoPath } from "../repo-root.js";

export { REPO_ROOT, repoPath };

dotenv.config({ path: repoPath(".env") });

const CONFIG_PATH = repoPath("scout-config.json");

/**
 * SPEC-exact flat defaults — `scout-config.json` mirrors these (see
 * config/scout-config.example.json / SPEC.md). The user-facing config file stays
 * flat; this module maps it into a nested `config` object for ergonomic access.
 */
const DEFAULTS_FLAT = {
  // Wallet Discovery
  discoveryEnabled: true,
  discoveryIntervalMinutes: 60,
  poolDiscoveryEnabled: true,
  txMiningEnabled: false,
  followWinnersEnabled: false,
  maxWalletCandidatesPerCycle: 100,
  minPositionsToEvaluate: 10,
  evaluationBackfillDays: 30,
  reEvaluateIntervalHours: 168,
  // Established-pool discovery pass (where elite LPs sit — high TVL/blue-chip pools the
  // trending screener excludes). Runs in addition to the trending pass.
  establishedEnabled: true,
  establishedMinTvl: 100000,
  establishedMaxTvl: 2000000,
  establishedMaxMcap: 5000000000,
  // Wallet Tier Thresholds (calibrated to real DLMM LP data — SPEC's 0.65/20/45 were aspirational
  // and rejected ~all LPs; real net win-rate for active LPs is ~0.3-0.5)
  minWalletScore: 40,
  minWinRate: 0.40,
  minTotalPositions: 10,
  minFeeYield: 0.5,
  topWalletLimit: 100,
  topWalletMinScore: 60, // data-calibrated: elite cut for the signal-driving top whitelist
  autoPromoteToTracked: true,
  autoDemoteTopWallet: true,
  // Pool Screening
  minFeeActiveTvlRatio: 0.05,
  minTvl: 10000,
  maxTvl: 150000,
  minVolume: 500,
  minOrganic: 60,
  minBinStep: 80,
  maxBinStep: 125,
  minTokenFeesSol: 30,
  // Pool Screening — discovery-API query + validation extras (mirror meridian config.screening).
  // Not listed in scout-config.example.json, so these defaults apply; overridable via scout-config.json.
  timeframe: "5m",
  category: "trending",
  minQuoteOrganic: 60,
  minHolders: 500,
  minMcap: 150000,
  maxMcap: 10000000,
  excludeHighSupplyConcentration: true,
  allowedLaunchpads: [], // [] = no allow-list
  blockedLaunchpads: [], // e.g. ["letsbonk.fun", "pump.fun"]
  minTokenAgeHours: null, // null = no minimum
  maxTokenAgeHours: null, // null = no maximum
  // Signal Validation
  minCombinedConfidence: 0.70,
  signalExpiryMinutes: 60,
  // Collection
  backfillDays: 90,
  snapshotIntervalMinutes: 15,
  walletRankUpdateIntervalMinutes: 60,
  screeningIntervalMinutes: 30,
  // Output
  signalOutputMode: "file",
  signalOutputPath: "./signals-output.json",
  signalApiEndpoint: "",
  // Dataset Export
  datasetExportPath: "./dataset/training-records.csv",
  autoExportOnClose: true,
  // Seed (opsional)
  seedWalletsFile: "",
  seedWalletsOnStartup: false,
};

function loadUserConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const clean = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key.trim().startsWith("//")) continue; // strip SPEC's "// Section" comment keys
      clean[key] = value;
    }
    return clean;
  } catch (err) {
    console.error(`[config] failed to parse ${CONFIG_PATH}: ${err.message} — using defaults`);
    return {};
  }
}

/** Resolve a repo-relative path (e.g. "./signals-output.json") to an absolute one under REPO_ROOT. */
function resolvePath(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  return repoPath(p);
}

const m = { ...DEFAULTS_FLAT, ...loadUserConfig() };

export const config = {
  discovery: {
    enabled: m.discoveryEnabled,
    intervalMinutes: m.discoveryIntervalMinutes,
    poolDiscoveryEnabled: m.poolDiscoveryEnabled,
    txMiningEnabled: m.txMiningEnabled,
    followWinnersEnabled: m.followWinnersEnabled,
    maxWalletCandidatesPerCycle: m.maxWalletCandidatesPerCycle,
    minPositionsToEvaluate: m.minPositionsToEvaluate,
    evaluationBackfillDays: m.evaluationBackfillDays,
    reEvaluateIntervalHours: m.reEvaluateIntervalHours,
    establishedEnabled: m.establishedEnabled,
    establishedMinTvl: m.establishedMinTvl,
    establishedMaxTvl: m.establishedMaxTvl,
    establishedMaxMcap: m.establishedMaxMcap,
  },
  tiers: {
    minWalletScore: m.minWalletScore,
    minWinRate: m.minWinRate,
    minTotalPositions: m.minTotalPositions,
    minFeeYield: m.minFeeYield,
    topWalletLimit: m.topWalletLimit,
    topWalletMinScore: m.topWalletMinScore,
    autoPromoteToTracked: m.autoPromoteToTracked,
    autoDemoteTopWallet: m.autoDemoteTopWallet,
  },
  screening: {
    minFeeActiveTvlRatio: m.minFeeActiveTvlRatio,
    minTvl: m.minTvl,
    maxTvl: m.maxTvl,
    minVolume: m.minVolume,
    minOrganic: m.minOrganic,
    minBinStep: m.minBinStep,
    maxBinStep: m.maxBinStep,
    minTokenFeesSol: m.minTokenFeesSol,
    // discovery-API query + validation extras
    timeframe: m.timeframe,
    category: m.category,
    minQuoteOrganic: m.minQuoteOrganic,
    minHolders: m.minHolders,
    minMcap: m.minMcap,
    maxMcap: m.maxMcap,
    excludeHighSupplyConcentration: m.excludeHighSupplyConcentration,
    allowedLaunchpads: m.allowedLaunchpads,
    blockedLaunchpads: m.blockedLaunchpads,
    minTokenAgeHours: m.minTokenAgeHours,
    maxTokenAgeHours: m.maxTokenAgeHours,
  },
  signals: {
    minCombinedConfidence: m.minCombinedConfidence,
    expiryMinutes: m.signalExpiryMinutes,
  },
  collection: {
    backfillDays: m.backfillDays,
    snapshotIntervalMinutes: m.snapshotIntervalMinutes,
    walletRankUpdateIntervalMinutes: m.walletRankUpdateIntervalMinutes,
    screeningIntervalMinutes: m.screeningIntervalMinutes,
  },
  output: {
    mode: m.signalOutputMode,
    signalPath: resolvePath(m.signalOutputPath),
    apiEndpoint: m.signalApiEndpoint,
  },
  dataset: {
    exportPath: resolvePath(m.datasetExportPath),
    autoExportOnClose: m.autoExportOnClose,
  },
  seed: {
    walletsFile: m.seedWalletsFile ? resolvePath(m.seedWalletsFile) : m.seedWalletsFile,
    onStartup: m.seedWalletsOnStartup,
  },
  env: {
    heliusApiKey: process.env.HELIUS_API_KEY || "",
    heliusRpcUrl: process.env.HELIUS_RPC_URL || "",
    heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET || "",
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || "",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    telegramAllowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || "",
    webhookPort: Number(process.env.WEBHOOK_PORT) || 3001,
    logLevel: process.env.LOG_LEVEL || "info",
    verbose: String(process.env.VERBOSE || "").toLowerCase() === "true",
  },
};
