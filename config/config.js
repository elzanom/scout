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
  discoveryIntervalMinutes: 15,
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
  minWinRate: 0.70,
  minTotalPositions: 10,
  minFeeYield: 0.5,
  topWalletLimit: 100,
  topWalletMinScore: 60, // data-calibrated: elite cut for the signal-driving top whitelist
  autoPromoteToTracked: true,
  autoDemoteTopWallet: true,
  // Pool Screening
  minFeeActiveTvlRatio: 0.05,
  minTvl: 150000,
  maxTvl: 1500000,
  minVolume: 500,
  minOrganic: 60,
  minBinStep: 80,
  maxBinStep: 125,
  minTokenFeesSol: 30,
  requireSolPair: true,         // only discover/evaluate pools paired with SOL
  // Pool Screening — discovery-API query + validation extras (mirror meridian config.screening).
  // Not listed in scout-config.example.json, so these defaults apply; overridable via scout-config.json.
  timeframe: "30m",
  category: "trending",
  minQuoteOrganic: 60,
  minHolders: 500,
  minMcap: 150000,
  maxMcap: 10000000,
  excludeHighSupplyConcentration: true,
  allowedLaunchpads: [], // [] = no allow-list
  blockedLaunchpads: [], // e.g. ["letsbonk.fun", "pump.fun"]
  minTokenAgeHours: 4, // null = no minimum
  maxTokenAgeHours: null, // null = no maximum
  // Signal Validation
  minCombinedConfidence: 0.70,
  signalExpiryMinutes: 60,
  // Helius webhook receiver (real-time TX mining + signal trigger). Disable to use Helius only for historical backfill.
  heliusWebhookEnabled: true,
  // Polling signal scan: periodically scans top wallets and emits signals. Independent from webhook.
  signalScanEnabled: true,
  // Collection
  backfillDays: 30,
  snapshotIntervalMinutes: 15,
  walletRankUpdateIntervalMinutes: 60,
  screeningIntervalMinutes: 15,
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
    requireSolPair: m.requireSolPair,
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
    heliusWebhookEnabled: m.heliusWebhookEnabled ?? true,
    signalScanEnabled: m.signalScanEnabled ?? true,
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
    laminarFeedPath: resolvePath(m.laminarFeedPath || "./output/laminar-smart-wallets.json"),
  },
  dataset: {
    exportPath: resolvePath(m.datasetExportPath),
    autoExportOnClose: m.autoExportOnClose,
  },
  signalWeights: {
    enabled: m.signalWeightsEnabled ?? true,
    windowDays: m.signalWeightsWindowDays ?? 60,
    minSamples: m.signalWeightsMinSamples ?? 10,
    boostFactor: m.signalWeightsBoostFactor ?? 1.05,
    decayFactor: m.signalWeightsDecayFactor ?? 0.95,
    weightFloor: m.signalWeightsWeightFloor ?? 0.3,
    weightCeiling: m.signalWeightsWeightCeiling ?? 2.5,
  },
  seed: {
    walletsFile: m.seedWalletsFile ? resolvePath(m.seedWalletsFile) : m.seedWalletsFile,
    onStartup: m.seedWalletsOnStartup,
  },
  env: {
    heliusApiKey: process.env.HELIUS_API_KEY || "",
    heliusRpcUrl: process.env.HELIUS_RPC_URL || "",
    heliusPumpRpcUrl: process.env.HELIUS_PUMP_RPC_URL || "",
    heliusUsePumpForRpc: String(process.env.HELIUS_USE_PUMP_FOR_RPC || "").toLowerCase() === "true",
    heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET || "",
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || "",
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    telegramAllowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || "",
    webhookPort: Number(process.env.WEBHOOK_PORT) || 3001,
    logLevel: process.env.LOG_LEVEL || "info",
    verbose: String(process.env.VERBOSE || "").toLowerCase() === "true",
    // Helius key-manager tuning
    rateLimitCooldownMs: Math.max(0, Number(process.env.RATE_LIMIT_COOLDOWN_MS) || 60_000),
    failureCooldownMs: Math.max(0, Number(process.env.FAILURE_COOLDOWN_MS) || 30_000),
    maxFailuresPerKey: Math.max(1, Number(process.env.MAX_FAILURES_PER_KEY) || 5),
    // Meteora pool API rate-limit tuning
    meteoraPoolMaxInFlight: Math.max(1, Number(process.env.METEORA_POOL_MAX_IN_FLIGHT) || 2),
    meteoraPoolDispatchDelayMs: Math.max(0, Number(process.env.METEORA_POOL_DISPATCH_DELAY_MS) || 250),
    meteoraPoolCircuitFailureThreshold: Math.max(1, Number(process.env.METEORA_POOL_CIRCUIT_FAILURE_THRESHOLD) || 5),
    meteoraPoolCircuitOpenMs: Math.max(0, Number(process.env.METEORA_POOL_CIRCUIT_OPEN_MS) || 60_000),
  },
};
