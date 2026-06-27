// Verify the gated sources (Birdeye + GMGN) activate with the updated .env keys.
// Runs raw HTTP probes (to see real status codes) then enrichTokenInfo, then reads the DB row back.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { initDb, getDb, closeDb } from "../src/db/index.js";
import { enrichTokenInfo, sourceStatus } from "../src/collector/token-info.js";

const BIRDEYE = "https://public-api.birdeye.so/defi/token_overview";
const GMGN = "https://openapi.gmgn.ai";

async function probe(label, url, headers) {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    console.log(`  ${label}: HTTP ${res.status} | ${body.length} bytes`);
    if (res.status === 401 || res.status === 403) console.log(`    body: ${body.slice(0, 200)}`);
    if (res.ok) {
      try { console.log(`    keys: ${Object.keys(JSON.parse(body)).slice(0, 12).join(", ")}`); } catch {}
    }
    return res.status;
  } catch (e) {
    console.log(`  ${label}: ERR ${e.message}`);
    return -1;
  }
}

async function main() {
  initDb();
  console.log("sourceStatus (pre-run):", sourceStatus());

  // Pick a real mint from existing snapshots, fallback to a well-known token.
  let mint = getDb().prepare("SELECT base_mint FROM market_snapshots WHERE base_mint IS NOT NULL LIMIT 1").get()?.base_mint
    || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  console.log(`\nmint: ${mint}`);

  console.log("\n--- raw HTTP probes ---");
  const beStatus = await probe("Birdeye", `${BIRDEYE}?address=${mint}&chain=solana`, { "x-api-key": process.env.BIRDEYE_API_KEY });
  const gmStatus = await probe("GMGN",
    `${GMGN}/v1/token/info?chain=sol&address=${mint}` +
    `&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${randomUUID()}`,
    { "X-APIKEY": process.env.GMGN_API_KEY, "Content-Type": "application/json" });

  console.log("\n--- enrichTokenInfo merge ---");
  const info = await enrichTokenInfo(mint);
  console.log("source:", info?.source);
  console.log("security fields:", {
    bundler_rate: info?.bundler_rate,
    is_honeypot: info?.is_honeypot,
    rug_ratio: info?.rug_ratio,
    top10_holder_rate: info?.top10_holder_rate,
    renounced_mint: info?.renounced_mint,
    renounced_freeze: info?.renounced_freeze,
  });
  console.log("identity:", { symbol: info?.symbol, launchpad: info?.launchpad, graduated: info?.graduated, holder_count: info?.holder_count, fdv: info?.fdv, mcap: info?.mcap });
  console.log("holder concentration:", { creator_holding_pct: info?.creator_holding_pct });

  console.log("\n--- DB row readback ---");
  const row = getDb().prepare("SELECT * FROM token_info WHERE mint = ?").get(mint);
  if (row) console.log("stored source:", row.source, "| bundler_rate:", row.bundler_rate, "| honeypot:", row.is_honeypot, "| rug_ratio:", row.rug_ratio, "| top10:", row.top10_holder_rate, "| creator_holding_pct:", row.creator_holding_pct);
  else console.log("NO ROW stored");

  console.log("\nsummary:", { birdeye: beStatus, gmgn: gmStatus, mergedSource: info?.source });
  closeDb();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
