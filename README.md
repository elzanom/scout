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
EVALUATE         wallet-evaluator: portfolio(open) + Agent Meridian history  → score (0-100) + tier
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
| `HELIUS_API_KEY` | **yes** | Helius historical TX + webhook auth. Supports multiple keys: `key1,key2,key3` or `HELIUS_API_KEY_1`, `_2`, … |
| `HELIUS_RPC_URL` | yes | RPC endpoint (used for balance/account reads) |
| `HELIUS_WEBHOOK_SECRET` | yes | Shared secret validating inbound webhooks |
| `HELIUS_PUMP_RPC_URL` | no | Public Solana RPC proxy, e.g. `https://pump.helius-rpc.com` |
| `HELIUS_USE_PUMP_FOR_RPC` | no | `true` to route generic RPC reads through pump first, fallback to `HELIUS_RPC_URL` |
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
| `discoveryIntervalMinutes` | `15` | Discovery + follow-winners cadence |
| `screeningIntervalMinutes` | `15` | Pool-screening cache cadence |
| `snapshotIntervalMinutes` | `15` | Market-snapshot cadence |

**Laminar-specific output keys** (see [Outputs](#outputs-read-by-laminar)):

| Key | Default | Meaning |
|---|---|---|
| `laminarFeedPath` | `./output/laminar-smart-wallets.json` | Top-wallet feed for Laminar |
| `signalWeightsEnabled` | `true` | Recompute Darwinian weights daily |
| `signalWeightsWindowDays` | `60` | Lookback window for weight recalc |
| `signalWeightsMinSamples` | `10` | Min records before recalc |
| `signalWeightsBoostFactor` | `1.05` | Top-quartile signal boost |
| `signalWeightsDecayFactor` | `0.95` | Bottom-quartile signal decay |
| `signalWeightsWeightFloor` | `0.3` | Lowest allowed weight |
| `signalWeightsWeightCeiling` | `2.5` | Highest allowed weight |

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

### Multiple Helius API keys (free-tier rotation)

If you run multiple Helius free-tier keys, Scout rotates them automatically:

```bash
HELIUS_API_KEY=key1,key2,key3
# or
HELIUS_API_KEY_1=key1
HELIUS_API_KEY_2=key2
HELIUS_API_KEY_3=key3
```

- On `429` or transient 5xx, the failing key is cooled down and the next healthy key is used.
- Cooldown is configurable via `RATE_LIMIT_COOLDOWN_MS`, `FAILURE_COOLDOWN_MS`, `MAX_FAILURES_PER_KEY`.
- Only premium Helius API calls (`/v0/addresses/.../transactions`) rotate keys; webhooks and RPC endpoints are unaffected.

See `src/rpc/helius-key-manager.js`.

### Mixing `https://pump.helius-rpc.com` with Helius

`pump.helius-rpc.com` is a public Solana RPC proxy, not a full Helius replacement. Scout can mix it in:

- **Always on premium Helius** (`api.helius.xyz`): Enhanced Transactions history, webhooks, and any Helius-specific API.
- **Optionally on pump RPC**: generic Solana RPC reads (`getAccountInfo`, `getBalance`, `getSignaturesForAddress`, `getTransaction`, etc.) when you set `HELIUS_USE_PUMP_FOR_RPC=true`.

When enabled, the router tries pump first and falls back to your key-authenticated `HELIUS_RPC_URL` on transient failure. This can save Helius RPC credits, but pump has unknown/shared rate limits and no SLA — monitor `rpc_warn` logs.

Implementation: `src/rpc/helius-router.js` (generic RPC) and `src/collector/helius-history.js` (premium history API).

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
| `POST /api/laminar/smart-wallets` | Write `output/laminar-smart-wallets.json` on demand |
| `POST /api/laminar/training` | Write all Laminar-compatible training files on demand |

---

## Outputs (read by Laminar)

### Live / operational outputs

- **`signals-output.json`** — JSON array of emitted signals (SPEC format): `id`, `pool`,
  `token_pair`, `confidence`, `trigger.{wallet,wallet_score,wallet_wr}`, `pool_metrics`,
  `suggested.{bin_step,range_lower,range_upper}`, `validation_reasons`, `created_at`.
- **`output/laminar-smart-wallets.json`** — top wallet whitelist Laminar can import as its
  `smart-wallets` list. Updated every 10 min. Format: `{ generated_at, count, wallets:[{ name,
  address, category:"scout_top", type:"lp", score, win_rate, total_positions, addedAt }] }`.
- **`dataset/training-records.csv`** — one row per closed position: LABEL (`was_profitable`,
  `pnl_usd`, …) + FEATURES (market context at entry, wallet score/WR, bin range, time-of-day, …).
- **`data/scout.db`** — SQLite (WAL) source of truth: `wallets`, `positions`, `signals`,
  `market_snapshots`, `training_records`, `wallet_discovery_log`.

### Manual-training exports (Laminar-compatible)

Exported automatically at 03:00 daily, or on demand via `POST /api/laminar/training`:

| File | What it is | Maps to Laminar file |
|---|---|---|
| `dataset/laminar-lessons.json` | Rules + performance array derived from closed positions. | `lessons.json` |
| `dataset/laminar-messages.jsonl` | OpenAI fine-tune examples (`DEPLOY`/`SKIP` + reasoning). | training dataset for fine-tuning |
| `dataset/laminar-signal-weights.json` | Darwinian weights for the 13 Laminar signals. | `signal-weights.json` |
| `dataset/laminar-pool-memory.json` | Per-pool history with `close_reason` and `close_reason_category`. | `pool-memory.json` |
| `dataset/laminar-decision-traces.jsonl` | Screener-style decision traces for causal/RL-style learning. | `decision-traces.jsonl` |

All exports are generated from Scout-tracked wallets and positions only — no Laminar source code
or state is modified. Copy these files into Laminar and run training manually.

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
| Agent Meridian 429 / "wait 60 seconds" | Rate-limited. `withHeliusRetry` backs off 60s; keep discovery concurrency low (3). |
| Almost all wallets `insufficient_data` | Position data is sparse per single pool — ensure `establishedEnabled: true` and let cycles accumulate breadth. Lower `minPositionsToEvaluate` if you want more tierable sooner. |
| `close_reason` mostly `take_profit`/`oor_*` in Laminar exports | Expected — Scout infers it from PnL%, duration, fee_yield and volatility. Real OOR/trailing_tp labels require Laminar's own position tracking. |
| Empty `signal_snapshot` in old traces | Older `training_records` were written before the 13-signal snapshot was staged. New closes will carry the full snapshot. |
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
src/utils/                  logger · retry (+ Helius/Agent Meridian rate-limit-aware)
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
- Agent Meridian `studyTopLPers` (public key) — per-owner history/aggregates.
- Helius — wallet activity (webhook + history backfill); real-time tx-mining + signal triggers.

No raw instruction decoding — Meteora's own APIs provide ground truth.
