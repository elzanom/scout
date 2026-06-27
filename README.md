# laminar-scout

A **read-only, self-discovering LP-wallet tracker + pool screener for Meteora DLMM** on Solana.
It autonomously discovers wallets, evaluates their historical LP performance, ranks them, screens
pools, and emits two outputs consumed by the **Laminar** trading agent:

- **Signals** (`signals-output.json`) — when a top wallet enters a screened pool.
- **Dataset** (`dataset/training-records.csv`) — labeled entry→outcome records for training.

**No on-chain execution.** Pure data pipeline + tracker. Runs 24/7 as a PM2 daemon.

> See `SPEC.md` for the full architecture and `CLAUDE.md` for build rules.

---

## Quick start

```bash
npm install
cp .env.example .env                 # then edit: set HELIUS_API_KEY (+ RPC, webhook secret)
cp config/scout-config.example.json scout-config.json   # optional: tune thresholds
SCOUT_RUN_ONCE=1 npm start           # smoke test: runs every cycle once, then exits
npm run pm2:start                    # 24/7 daemon (cron + webhook, in-process)
```

Requires **Node.js 18+** (better-sqlite3 native build) and a **Helius** account (API key).

---

## What it does (one cycle)

```
DISCOVERY (60m)  pool-discovery (trending + established pools)
                 + follow-winners (co-occurrence with top wallets)   → candidate wallets
                 + tx-mining (Helius webhook, real-time)             → candidate wallets
EVALUATE         wallet-evaluator: portfolio(open) + LPAgent history  → score (0-100) + tier
RANK             promote tracked→top, demote, re-queue stale rejected
SCREEN (30m)     refresh screened-pools cache (Meteora discovery API)
SNAPSHOT (15m)   market context per pool with open positions
SIGNAL           top wallet × screened pool → confidence → signals-output.json
DATASET          closed position → training record → dataset/*.csv
```

Wallet tier flow: `candidate → tracked → top` (with demotion + periodic re-evaluation).

---

## Configuration

### `.env` (from `.env.example`)

| Var | Required | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | **yes** | Helius historical TX + webhook auth |
| `HELIUS_RPC_URL` | yes | RPC endpoint (used for balance/account reads) |
| `HELIUS_WEBHOOK_SECRET` | yes | Shared secret validating inbound webhooks |
| `BIRDEYE_API_KEY` | no | Token price/volatility enrichment (future) |
| `WEBHOOK_PORT` | no | Webhook receiver port (default `3001`) |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error` (default `info`) |
| `VERBOSE` | no | `true` for debug output |

### `scout-config.json` (from `config/scout-config.example.json`)

Key tunables (defaults shown — already calibrated to real DLMM LP data):

| Key | Default | Meaning |
|---|---|---|
| `minWinRate` | `0.40` | Net win-rate (fees > IL) bar for `tracked` |
| `minTotalPositions` | `10` | Min positions to be `tracked` |
| `minWalletScore` | `40` | Min composite score (0-100) |
| `minPositionsToEvaluate` | `10` | Min positions before a wallet is tierable |
| `topWalletLimit` | `100` | Cap on the top-wallet whitelist |
| `minCombinedConfidence` | `0.70` | Signal emit gate (wallet 0.4 + pool 0.6) |
| `establishedEnabled` | `true` | Also discover high-TVL pools where elite LPs sit |
| `establishedMinTvl/MaxTvl/MaxMcap` | 100k / 2M / 5B | Established-pool screening override |
| `discoveryIntervalMinutes` | `60` | Discovery + follow-winners cadence |
| `screeningIntervalMinutes` | `30` | Pool-screening cache cadence |
| `snapshotIntervalMinutes` | `15` | Market-snapshot cadence |

> The screening block (`minFeeActiveTvlRatio`, `minTvl`, `maxTvl`, `minOrganic`, `minBinStep`,
> `maxBinStep`, …) mirrors meridian's pool filters — see `scout-config.example.json`.

---

## Helius webhook setup (enables real-time tx-mining + signals)

Helius does **not** type Meteora DLMM events, so filter by **program-account inclusion** (not
`transactionType`). In the Helius dashboard:

1. **Webhook URL:** `https://<your-host>:<WEBHOOK_PORT>/webhook/helius`
2. **Auth header:** `x-helius-secret: <HELIUS_WEBHOOK_SECRET>` (must match `.env`)
3. **Transaction filters:**
   - `vote: false`
   - `accountAddress: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (Meteora DLMM program)
   - (optional) limit to ADD/REMOVE_LIQUIDITY-style activity by post-filtering
4. **Webhook type:** `enhanced` (so the payload includes instructions/accounts the parser uses)

> ⚠️ **Cost:** subscribing to the whole Meteora program is high-volume. Keep it gated behind
> `HELIUS_API_KEY` credits and consider per-wallet webhooks (accountAddress = each tracked wallet)
> for cheaper, targeted tracking. The in-process receiver (`src/collector/helius-stream.js`) parses
> whatever Helius delivers via `tx-parser.js`.

Without a registered webhook, the daemon still works — discovery runs on cron (60m) and signals
come from the **polling signal-scan** cycle (no real-time).

---

## Running

| Command | Mode |
|---|---|
| `npm start` | Foreground daemon (cron + webhook in-process) |
| `npm run pm2:start` | 24/7 via PM2 (`ecosystem.config.cjs`) |
| `npm run pm2:logs` | Tail PM2 logs |
| `npm run pm2:restart` | Restart with updated env |
| `SCOUT_RUN_ONCE=1 npm start` | Run every cycle once (bounded), then exit — smoke test |
| `npm run seed -- --file seed.txt` | Bootstrap known wallets from a file (one address[/alias] per line) |
| `npm run backfill -- --wallet <addr> --days 90` | Backfill one wallet's history manually |

---

## Outputs (read by Laminar)

- **`signals-output.json`** — JSON array of emitted signals (SPEC format): `id`, `pool`,
  `token_pair`, `confidence`, `trigger.{wallet,wallet_score,wallet_wr}`, `pool_metrics`,
  `suggested.{bin_step,range_lower,range_upper}`, `validation_reasons`, `created_at`.
- **`dataset/training-records.csv`** — one row per closed position: LABEL (`was_profitable`,
  `pnl_usd`, …) + FEATURES (market context at entry, wallet score/WR, bin range, time-of-day, …).
- **`data/scout.db`** — SQLite (WAL) source of truth: `wallets`, `positions`, `signals`,
  `market_snapshots`, `training_records`, `wallet_discovery_log`.

Switch the signal output with `signalOutputMode` (`file` | `rest` | `stdout`); for `rest`, set
`signalApiEndpoint` to POST each signal to Laminar.

---

## Monitoring

```bash
npm run pm2:logs                      # live logs
tail -f logs/scout-$(date +%F).log    # today's log file
```

Quick DB census:
```bash
node --input-type=module -e "
import {initDb,getDb,closeDb} from './src/db/index.js';
initDb(); const db=getDb();
console.log(db.prepare('SELECT status, COUNT(*) c FROM wallets GROUP BY status').all());
console.log('top:', db.prepare('SELECT COUNT(*) c FROM wallets WHERE is_top_wallet=1').get().c);
console.log('signals:', db.prepare('SELECT COUNT(*) c FROM signals').get().c);
closeDb();"
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `better-sqlite3` build fails | Node < 18, or native toolchain missing. Requires Node 18+; pin `better-sqlite3@^12` on Node 26. |
| 0 Meteora activity in backfill | Wrong program ID — must be `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (the CLAUDE.md/SPEC value `…LLjeyaddwrzQLnG4V1Kh` is **wrong**). |
| LPAgent 429 / "wait 60 seconds" | Rate-limited. `withHeliusRetry` backs off 60s; keep discovery concurrency low (3). |
| Almost all wallets `insufficient_data` | Position data is sparse per single pool — ensure `establishedEnabled: true` and let cycles accumulate breadth. Lower `minPositionsToEvaluate` if you want more tierable sooner. |
| No signals emitted | Selective by design: needs a top wallet in a pool that passes screening **at that moment**. Check `minCombinedConfidence` and screening thresholds. |
| Webhook 401 | `x-helius-secret` header missing or ≠ `HELIUS_WEBHOOK_SECRET`. |
| DB locked | WAL mode handles concurrent readers; if seen, raise `busy_timeout` (in `src/db/schema.js`). |

---

## Architecture (28 modules)

```
config/config.js            .env + scout-config.json → nested config
repo-root.js                stable absolute paths under PM2
src/index.js                orchestrator: cron cycles + webhook (in-process)
src/db/                     schema · handle · wallets · positions · market-snapshots (better-sqlite3, WAL)
src/utils/                  logger · retry (+ Helius/LPAgent rate-limit-aware)
src/screener/               pool-screener (discoverPools, screenPool) · pool-scorer (degenScore) · metrics-fetcher
src/collector/              tx-parser · helius-history · helius-stream (webhook) · snapshots
src/discovery/              pool-discovery · wallet-evaluator · follow-winners · tx-mining
src/wallets/                scoring · wallet-ranker · wallet-filter · seed-wallets
src/trackers/               position-builder
src/signals/                validator (double-validation) · emitter (SPEC-format output)
src/dataset/                record-builder · exporter
scripts/                    seed.js · backfill.js
ecosystem.config.cjs        PM2 config
```

**Data sources (hybrid — Helius does not classify Meteora DLMM):**
- Meteora discovery API (public) — pool screening + metrics + portfolio/open (per-wallet positions/PnL).
- LPAgent `studyTopLPers` (public key) — per-owner history/aggregates.
- Helius — wallet activity (webhook + history backfill); real-time tx-mining + signal triggers.

No raw instruction decoding — Meteora's own APIs provide ground truth.
