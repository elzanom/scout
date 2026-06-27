# Scout Dashboard Design Spec

## Decision Log

| Question | Answer | Consequence |
|----------|--------|-------------|
| Stack | React / Next.js SPA | Need build pipeline, but rich UX and component reuse |
| Live updates | WebSocket | Lower latency; need ws server wiring + client reconnect |
| Controls | Read-only + restart trigger | Simpler auth model, no state mutation except safe process restart |
| Access | LAN deployment | Bind to `0.0.0.0`, no external auth gate required |

## Overview

A single-page dashboard served from the same Node process that runs the scout pipeline. It provides:

1. **Observability** — live counts, recent signals, top wallets, open positions, pool snapshots.
2. **Data exploration** — sortable/filterable tables for wallets, positions, snapshots, signals, training records.
3. **System health** — cron cycle timestamps, webhook status, last errors, log tail.
4. **Safe control** — one button to gracefully restart the scout process (SIGTERM + respawn via PM2 or manual relaunch).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Next.js SPA (build → static export → served by Node)            │
│  - React + lightweight charts (Recharts)                         │
│  - WebSocket client reconnect logic                              │
└──────────────────┬──────────────────────────────────────────────┘
                   │ WebSocket / REST
┌──────────────────▼──────────────────────────────────────────────┐
│  Node HTTP server (existing webhook server extended)             │
│  - /api/health, /api/state, /api/wallets, /api/positions, ...    │
│  - /ws upgrades to WebSocket                                     │
│  - /dashboard/* serves built static files                        │
└──────────────────┬──────────────────────────────────────────────┘
                   │ better-sqlite3 (read-only for dashboard)
┌──────────────────▼──────────────────────────────┐
│  SQLite (data/scout.db)                         │
│  market_snapshots | signals | positions | ...   │
└─────────────────────────────────────────────────┘
```

## File Layout

```
laminar-scout/
├── webui/                       # Next.js app
│   ├── package.json
│   ├── next.config.js           # output: 'export', distDir: '../src/webui-dist'
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.js
│   │   │   ├── page.js          # main dashboard
│   │   │   └── globals.css
│   │   ├── components/
│   │   │   ├── StatCards.jsx
│   │   │   ├── WalletTable.jsx
│   │   │   ├── PositionTable.jsx
│   │   │   ├── SignalTable.jsx
│   │   │   ├── SnapshotTable.jsx
│   │   │   ├── PoolChart.jsx
│   │   │   ├── LogTail.jsx
│   │   │   └── RestartButton.jsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.js
│   │   │   └── useApi.js
│   │   └── lib/
│   │       └── format.js
│   └── public/
│       └── (empty)
├── src/webui-dist/              # gitignored built static export
├── src/webui-server.js          # Node server: static files + API + WS
├── src/webui/api-router.js      # REST endpoints (read-only DB queries)
├── src/webui/ws-broadcaster.js  # WebSocket push on signal / snapshot / cycle events
├── src/webui/state-cache.js     # in-memory cache of recent counts + last cycle times
└── docs/superpowers/specs/2026-06-26-scout-dashboard-design.md
```

## API Endpoints (REST, read-only)

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/health` | `{ ok, db, uptime, version }` |
| GET | `/api/state` | cached counts + last cycle timestamps |
| GET | `/api/wallets?status=&is_top=&limit=50&offset=0` | wallets list |
| GET | `/api/wallets/:address` | wallet detail + positions + discovery log |
| GET | `/api/positions?status=&wallet=&pool=&limit=50&offset=0` | positions list |
| GET | `/api/signals?status=&limit=50&offset=0` | signals list |
| GET | `/api/snapshots?pool=&limit=50&offset=0` | snapshots list |
| GET | `/api/pools` | distinct pools with latest snapshot |
| GET | `/api/logs?lines=100&level=` | recent log lines (tail) |
| POST | `/api/control/restart` | triggers graceful restart (protected by simple LAN secret if configured) |

## WebSocket Protocol

Connection: `ws://host:port/ws`

Server → client messages (JSON):

```json
{ "type": "state", "payload": { "wallets": 197, "positions": 37, ... } }
{ "type": "signal", "payload": { "id": 2, "pool_address": "...", "combined_confidence": 0.82 } }
{ "type": "snapshot", "payload": { "pool_address": "...", "timestamp": 171... } }
{ "type": "log", "payload": { "timestamp": "...", "level": "info", "message": "..." } }
{ "type": "cycle", "payload": { "name": "discovery_eval", "startedAt": 171..., "durationMs": 1234, "success": true } }
```

Client → server messages:

```json
{ "type": "subscribe", "channels": ["signals", "snapshots", "logs"] }
{ "type": "ping" }
```

## WebSocket Push Triggers

Hooked into existing pipeline via `src/webui/ws-broadcaster.js`:

- `emitSignal()` → broadcast `signal`
- `insertSnapshot()` → broadcast `snapshot`
- `log()` → broadcast `log` (throttled to 10/sec)
- each cron cycle start/end → broadcast `cycle`
- state cache refresh every 15s → broadcast `state`

## Pages / Views

1. **Overview (default)**
   - 6 stat cards: wallets, top wallets, open/closed positions, signals today, latest snapshot age
   - sparkline charts for wallet score distribution and snapshot fee_apr
   - recent signals table
   - live log tail

2. **Wallets**
   - sortable table: address, status, score, win_rate, total_positions, total_pnl_usd
   - filters: status, is_top_wallet, min score
   - click row → detail panel with positions + discovery log

3. **Positions**
   - table: wallet, pool, token_pair, status, capital, pnl, fee_yield, duration
   - filters: open/closed, wallet, pool

4. **Signals**
   - table: timestamp, pool, confidence, wallet, status
   - highlight pending/unacknowledged

5. **Pools / Snapshots**
   - pool list with latest fee_apr, volume, tvl, buy_sell_ratio, creator_holding_pct
   - click pool → chart of fee_apr / volume over time

6. **System**
   - cron schedule, last run times, next expected run
   - config readout (thresholds, no secrets)
   - restart button

## Data Flow (Read-Only)

All dashboard queries use `better-sqlite3` directly on the shared DB handle. WAL mode allows concurrent readers while the pipeline writes.

- Long-running queries are capped with `LIMIT`.
- API responses are JSON; WebSocket pushes are JSON.
- No DB mutations from the dashboard except the explicit restart endpoint.

## Security / LAN Constraints

- Dashboard binds to `0.0.0.0` so LAN devices can reach it.
- Optional simple secret via `DASHBOARD_SECRET` env var for the restart endpoint.
- API keys and wallet private material are never exposed to the frontend.
- CORS allowed for LAN origin only (configurable via `DASHBOARD_CORS_ORIGIN`).

## Build & Run

```bash
# Build the static dashboard
npm run webui:build

# Run the full scout + dashboard server
npm run webui:start      # or existing npm start if merged into src/index.js

# Access
http://<scout-host>:3001/dashboard
```

## Integration with Existing Code

- Extend `src/collector/helius-stream.js` (`createServer`) to add `/api/*` routes and upgrade `/ws`.
- Or create a separate `src/webui-server.js` that also starts the pipeline; choose one entry point.
- Add `src/webui/state-cache.js` and `src/webui/api-router.js` as pure helpers.
- Broadcast hooks inserted into `src/utils/logger.js` and `src/signals/emitter.js` / `src/collector/snapshots.js`.

## Open Questions

1. Should the dashboard live in the same process as the scout pipeline, or a separate process that only reads the DB?
2. Which port: reuse `WEBHOOK_PORT` (3001) or a separate `DASHBOARD_PORT`?
3. Desired chart library: Recharts (React-friendly) or Chart.js?
4. Should we embed real-time terminal log tail from `logs/` files or from in-process log stream?
5. Do you want a dark mode default (common for trading dashboards)?
