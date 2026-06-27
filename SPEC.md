# SPEC: laminar-scout

## Tujuan

Program independen yang berjalan terpisah dari Laminar (fork dari meridian). Tugasnya:

1. **Menemukan wallet LP secara mandiri** — tidak perlu seed manual, scout mencari sendiri dari pool Meteora
2. **Menyaring top wallet LP** berdasarkan performa historis (WR%, fee yield, PNL, konsistensi)
3. **Mengumpulkan metrik entry/exit** beserta konteks market saat posisi dibuka/ditutup
4. **Menghasilkan dataset terstruktur** untuk training Laminar di masa depan
5. **Emit signal real-time** saat top wallet membuka posisi baru di pool yang lolos screening meridian

Program ini adalah **data pipeline + self-discovering wallet tracker**, bukan trading agent. Tidak ada eksekusi transaksi on-chain.

### Filosofi Self-Discovery

```
Bukan:
Kamu → input wallet manual → scout track

Tapi:
Scout → temukan wallet dari pool Meteora secara mandiri
      → evaluasi performa historis setiap wallet
      → promosi wallet bagus → top wallet list
      → track & emit signal otomatis
```

Scout berkembang organik — makin lama jalan, makin banyak wallet yang ditemukan dan dievaluasi.

---

## Referensi Codebase

Base screening logic diambil dari **meridian** (`yunus-0x/meridian`):
- `tools/screening.js` — pool discovery & kandidat
- `tools/study.js` — study top LPer via LPAgent API
- `smart-wallets.js` — KOL/alpha wallet tracker
- `screening-scales.js` — threshold scoring
- `signal-tracker.js` — signal management
- `signal-weights.js` — bobot signal

File-file di atas dijadikan **referensi logika**, bukan di-copy langsung. Adaptasi ke struktur laminar-scout.

---

## Stack

- **Runtime:** Node.js 18+ (ESM)
- **Language:** JavaScript (sama seperti meridian)
- **Database:** SQLite via `better-sqlite3` (ringan, no server)
- **Process manager:** PM2 (sama seperti Laminar)
- **RPC:** Helius (webhook + historical API)
- **Package manager:** npm

---

## Struktur Direktori

```
laminar-scout/
├── src/
│   ├── discovery/
│   │   ├── pool-discovery.js      # Scan top pools → extract semua wallet LP di dalamnya
│   │   ├── tx-mining.js           # Monitor semua TX Meteora global → tangkap wallet baru
│   │   ├── follow-winners.js      # Temukan wallet baru dari co-occurrence dengan top wallet
│   │   └── wallet-evaluator.js    # Auto backfill + score setiap wallet kandidat baru
│   ├── trackers/
│   │   ├── wallet-tracker.js      # Track addLiquidity TX dari tracked wallets
│   │   └── position-builder.js    # Rekonstruksi posisi entry→exit per wallet
│   ├── screener/
│   │   ├── pool-screener.js       # Port dari meridian tools/screening.js
│   │   ├── metrics-fetcher.js     # Fetch fee APR, volume, TVL, volatility
│   │   └── pool-scorer.js         # Composite scoring pool
│   ├── wallets/
│   │   ├── wallet-ranker.js       # Rank wallet berdasarkan historis performa
│   │   ├── wallet-filter.js       # Filter kriteria top wallet → promosi/demosi
│   │   └── seed-wallets.js        # Seed opsional dari screener external / manual
│   ├── collector/
│   │   ├── helius-stream.js       # Helius webhook listener real-time TX
│   │   ├── helius-history.js      # Backfill historis TX via Helius API
│   │   └── tx-parser.js           # Parse addLiquidity / removeLiquidity TX
│   ├── dataset/
│   │   ├── record-builder.js      # Build TrainingRecord dari posisi + market context
│   │   └── exporter.js            # Export dataset ke CSV / JSON
│   ├── signals/
│   │   ├── validator.js           # Double validation: wallet OK + pool OK
│   │   └── emitter.js             # Output signal (file JSON / REST / stdout)
│   ├── db/
│   │   ├── schema.js              # Inisialisasi SQLite tables
│   │   ├── wallets.js             # CRUD wallet data
│   │   ├── positions.js           # CRUD posisi LP
│   │   └── market-snapshots.js    # Simpan market context per timestamp
│   ├── utils/
│   │   ├── logger.js              # Logger (sama style meridian)
│   │   └── retry.js               # Retry helper untuk API calls
│   └── index.js                   # Entry point
├── config/
│   ├── config.js                  # Load config dari .env + scout-config.json
│   └── scout-config.example.json  # Template config
├── scripts/
│   ├── backfill.js                # Script backfill historis manual (opsional)
│   └── seed.js                    # Import seed wallet manual ke DB (opsional)
├── .env.example
├── ecosystem.config.cjs           # PM2 config
├── package.json
└── CLAUDE.md                      # Instruksi untuk Claude Code / opencode
```

---

## Database Schema (SQLite)

### Table: `wallets`

```sql
CREATE TABLE wallets (
  address TEXT PRIMARY KEY,
  alias TEXT,
  source TEXT,              -- 'manual' | 'pool_discovery' | 'tx_mining' | 'follow_winner'
  discovered_from TEXT,     -- pool address atau wallet address yang jadi sumber penemuan
  first_seen INTEGER,       -- unix timestamp
  last_active INTEGER,
  
  -- Metrik performa agregat
  total_positions INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  win_rate REAL DEFAULT 0,
  total_pnl_usd REAL DEFAULT 0,
  total_fees_usd REAL DEFAULT 0,
  avg_fee_yield REAL DEFAULT 0,
  avg_duration_hours REAL DEFAULT 0,
  
  -- Scoring
  score REAL DEFAULT 0,
  score_updated INTEGER,
  
  -- Status & Tier
  status TEXT DEFAULT 'candidate',  -- 'candidate' | 'tracked' | 'top' | 'rejected'
  is_tracked INTEGER DEFAULT 0,     -- 1 = aktif di-track real-time
  is_top_wallet INTEGER DEFAULT 0,  -- 1 = masuk whitelist top wallet untuk signal
  evaluation_count INTEGER DEFAULT 0, -- berapa kali sudah dievaluasi ulang
  last_evaluated INTEGER,
  reject_reason TEXT,               -- alasan jika status = 'rejected'
  
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

### Table: `wallet_discovery_log`

```sql
-- Log setiap kali wallet baru ditemukan dari sumber manapun
CREATE TABLE wallet_discovery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT,
  discovery_source TEXT,       -- 'pool_discovery' | 'tx_mining' | 'follow_winner' | 'manual'
  source_detail TEXT,          -- pool address, tx signature, atau wallet referrer
  discovered_at INTEGER DEFAULT (unixepoch())
);
```

### Table: `positions`

```sql
CREATE TABLE positions (
  id TEXT PRIMARY KEY,           -- {wallet}_{pool}_{entry_timestamp}
  wallet_address TEXT,
  pool_address TEXT,
  token_pair TEXT,               -- contoh: 'SOL/USDC'
  
  -- Entry data
  entry_timestamp INTEGER,
  entry_price REAL,
  bin_step INTEGER,
  bin_lower INTEGER,
  bin_upper INTEGER,
  bin_range_width REAL,
  amount_token_x REAL,
  amount_token_y REAL,
  capital_usd REAL,
  entry_tx TEXT,
  
  -- Exit data (null jika masih open)
  exit_timestamp INTEGER,
  exit_price REAL,
  exit_tx TEXT,
  
  -- Outcome (diisi saat close)
  fees_earned_usd REAL,
  pnl_usd REAL,
  pnl_pct REAL,
  fee_yield REAL,
  duration_hours REAL,
  is_profitable INTEGER,         -- 0 atau 1
  close_reason TEXT,             -- 'manual' | 'oor' | 'stop_loss' | 'take_profit'
  
  -- Status
  status TEXT DEFAULT 'open',    -- 'open' | 'closed'
  
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  
  FOREIGN KEY (wallet_address) REFERENCES wallets(address)
);
```

### Table: `market_snapshots`

```sql
CREATE TABLE market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT,
  timestamp INTEGER,
  
  -- Pool metrics saat snapshot
  fee_apr REAL,
  volume_24h REAL,
  tvl REAL,
  fee_tvl_ratio REAL,
  active_bin INTEGER,
  price REAL,
  
  -- Token metrics
  token_price REAL,
  token_price_change_24h REAL,
  token_volatility_24h REAL,
  token_volume_24h REAL,
  
  created_at INTEGER DEFAULT (unixepoch())
);
```

### Table: `signals`

```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT,
  token_pair TEXT,
  
  -- Trigger
  trigger_type TEXT,             -- 'wallet_entry' | 'pool_metric'
  triggered_by TEXT,             -- wallet address atau 'screener'
  
  -- Validasi
  wallet_score REAL,
  pool_score REAL,
  combined_confidence REAL,
  validation_reasons TEXT,       -- JSON array
  
  -- Suggested params
  suggested_bin_step INTEGER,
  suggested_range_lower INTEGER,
  suggested_range_upper INTEGER,
  
  -- Market context saat signal
  fee_apr REAL,
  volume_24h REAL,
  tvl REAL,
  
  -- Status
  status TEXT DEFAULT 'pending', -- 'pending' | 'sent' | 'expired' | 'rejected'
  
  created_at INTEGER DEFAULT (unixepoch())
);
```

---

## Config (`scout-config.json`)

```json
{
  "// Wallet Discovery": "",
  "discoveryEnabled": true,
  "discoveryIntervalMinutes": 60,
  "poolDiscoveryEnabled": true,
  "txMiningEnabled": true,
  "followWinnersEnabled": true,
  "maxWalletCandidatesPerCycle": 100,
  "minPositionsToEvaluate": 10,
  "evaluationBackfillDays": 90,
  "reEvaluateIntervalHours": 168,

  "// Wallet Tier Thresholds": "",
  "minWalletScore": 45,
  "minWinRate": 0.65,
  "minTotalPositions": 20,
  "minFeeYield": 0.5,
  "topWalletLimit": 100,
  "autoPromoteToTracked": true,
  "autoDemoteTopWallet": true,

  "// Pool Screening (dari meridian)": "",
  "minFeeActiveTvlRatio": 0.05,
  "minTvl": 10000,
  "maxTvl": 150000,
  "minVolume": 500,
  "minOrganic": 60,
  "minBinStep": 80,
  "maxBinStep": 125,
  "minTokenFeesSol": 30,

  "// Signal Validation": "",
  "minCombinedConfidence": 0.70,
  "signalExpiryMinutes": 60,

  "// Collection": "",
  "backfillDays": 90,
  "snapshotIntervalMinutes": 15,
  "walletRankUpdateIntervalMinutes": 60,
  "screeningIntervalMinutes": 30,

  "// Output": "",
  "signalOutputMode": "file",
  "signalOutputPath": "./signals-output.json",
  "signalApiEndpoint": "",

  "// Dataset Export": "",
  "datasetExportPath": "./dataset/training-records.csv",
  "autoExportOnClose": true,

  "// Seed (opsional)": "",
  "seedWalletsFile": "",
  "seedWalletsOnStartup": false
}
```

---

## Environment Variables (`.env`)

```env
# Wajib
HELIUS_API_KEY=your_helius_key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_WEBHOOK_SECRET=random_secret_string

# Opsional: untuk fetch metrik pool
BIRDEYE_API_KEY=your_birdeye_key

# Mode
DRY_RUN=true
LOG_LEVEL=info

# Port untuk webhook receiver
WEBHOOK_PORT=3001
```

---

## Alur Kerja Utama

### 1. Inisialisasi

```
startup
  → load config + env
  → init SQLite schema (buat table jika belum ada)
  → load seed wallets opsional (jika seedWalletsOnStartup = true)
  → start Helius webhook listener (port WEBHOOK_PORT)
  → start TX mining listener (monitor Meteora program global)
  → jadwalkan semua cron job:
      - Discovery cycle    : setiap discoveryIntervalMinutes
      - Pool screening     : setiap screeningIntervalMinutes
      - Market snapshot    : setiap snapshotIntervalMinutes
      - Wallet ranking     : setiap walletRankUpdateIntervalMinutes
      - Re-evaluation      : setiap reEvaluateIntervalHours
```

---

### 2. Discovery Engine (Menemukan Wallet Baru)

Ini komponen inti yang membuat scout bisa jalan mandiri tanpa seed manual.

#### 2a. Pool Discovery (`discovery/pool-discovery.js`)

```
Setiap discoveryIntervalMinutes:

pool-screener.js fetch top pool candidates
  → Untuk setiap pool yang lolos screening:
    → Panggil studyTopLPers(pool) — port dari meridian tools/study.js
    → Dapat list wallet yang pernah LP di pool tersebut
    → Untuk setiap wallet baru (belum ada di DB):
        → Insert ke wallets table dengan status = 'candidate'
        → source = 'pool_discovery'
        → discovered_from = pool_address
        → Log ke wallet_discovery_log
        → Masukkan ke antrian evaluasi
```

#### 2b. TX Mining (`discovery/tx-mining.js`)

```
Berjalan paralel dengan webhook listener.
Subscribe ke Helius untuk SEMUA TX yang menyentuh
Meteora DLMM program (bukan hanya tracked wallets).

Setiap TX addLiquidity yang masuk:
  → Ekstrak wallet address dari TX
  → Cek apakah sudah ada di DB?
      → Belum → insert sebagai 'candidate', source = 'tx_mining'
      → Sudah → update last_active
  → Masukkan ke antrian evaluasi jika baru
```

#### 2c. Follow Winners (`discovery/follow-winners.js`)

```
Setiap discovery cycle:

Untuk setiap top wallet (is_top_wallet = 1):
  → Fetch semua posisi historis wallet tersebut
  → Lihat pool mana saja yang pernah dimasuki
  → Untuk setiap pool tersebut:
    → Fetch wallet lain yang juga LP di pool yang sama
    → Dalam timeframe yang berdekatan (±24 jam)
    → Wallet tersebut = kandidat potensial
    → Insert jika belum ada, source = 'follow_winner'
    → discovered_from = top_wallet_address
```

#### 2d. Wallet Evaluator (`discovery/wallet-evaluator.js`)

```
Antrian evaluasi diproses secara batch (max maxWalletCandidatesPerCycle per cycle):

Untuk setiap wallet di antrian:
  1. Backfill historis TX via Helius (evaluationBackfillDays hari ke belakang)
  2. Parse semua TX → rekonstruksi posisi
  3. Minimal minPositionsToEvaluate posisi → lanjut evaluasi
     Kurang dari itu → tandai 'insufficient_data', coba lagi nanti
  4. Hitung semua metrik: WR%, fee yield, PNL, konsistensi
  5. Calculate score
  6. Bandingkan dengan threshold:
     
     score >= minWalletScore AND
     win_rate >= minWinRate AND
     total_positions >= minTotalPositions AND
     avg_fee_yield >= minFeeYield
     
       → LOLOS → status = 'tracked', is_tracked = 1
                 Jika score sangat tinggi → is_top_wallet = 1
       
       → TIDAK LOLOS → status = 'rejected'
                       reject_reason = alasan spesifik
                       Tetap di DB, re-evaluasi setelah reEvaluateIntervalHours
```

---

### 3. Wallet Tier System

Setiap wallet punya status yang bisa naik/turun:

```
[candidate]
  Baru ditemukan, belum dievaluasi atau data kurang
       ↓ (setelah evaluasi, data cukup, lolos threshold)
[tracked]
  Dimonitor real-time via webhook
  Posisi mereka di-record tapi belum trigger signal
       ↓ (score tinggi, konsisten)
[top]
  Trigger signal saat buka posisi di pool bagus
  Masuk dataset training
       ↓ (performa turun, tidak aktif)
[rejected]
  Tidak dimonitor, tidak trigger signal
  Re-evaluasi berkala (bisa naik kembali)
```

Promosi dan demosi otomatis setiap walletRankUpdateIntervalMinutes.

---

### 4. Real-time Tracking (Wallet yang Sudah Tracked)

```
Helius webhook → TX masuk dari Meteora
  → tx-parser.js decode TX
  → Cek wallet: apakah status = 'tracked' atau 'top'?
      → Tidak → abaikan (kecuali tx-mining aktif, lalu catat sebagai kandidat)
      → Ya → proses:
          → addLiquidity   → buat/update posisi, status = 'open'
          → claimFee       → update fees_earned di posisi
          → removeLiquidity → tutup posisi, hitung PNL, status = 'closed'
          → ambil market snapshot untuk pool tersebut sekarang
  
  → Jika addLiquidity dari TOP wallet (is_top_wallet = 1):
      → Jalankan pool screening untuk pool tersebut
      → Jika pool lolos → buat signal → emit
  
  → Jika posisi ditutup (closed):
      → Build training record
      → Simpan ke dataset
      → Trigger wallet re-ranking untuk wallet tersebut
```

---

### 5. Pool Screening

Port dari `meridian/tools/screening.js`:

```
Setiap screeningIntervalMinutes:

candidates = fetch_top_pools() dari Meteora API
  
Untuk setiap pool:
  → fee/TVL ratio >= minFeeActiveTvlRatio  ✓/✗
  → TVL dalam range [minTvl, maxTvl]       ✓/✗
  → volume >= minVolume                    ✓/✗
  → organic score >= minOrganic            ✓/✗
  → bin step dalam [minBinStep, maxBinStep] ✓/✗
  → all-time fees >= minTokenFeesSol       ✓/✗

Semua lolos → masuk screened_pools (in-memory cache)
Composite score → ranking
Cache digunakan oleh validator.js saat signal trigger
```

---

### 6. Market Snapshot

```
Setiap snapshotIntervalMinutes:

Untuk setiap pool yang ada posisi open (dari semua tracked wallets):
  → Fetch dari Meteora API: fee APR, TVL, volume 24h, fee/TVL ratio, active bin
  → Fetch dari Birdeye/Jupiter: harga token, price change 24h, volatilitas
  → Simpan ke market_snapshots dengan timestamp sekarang

Digunakan oleh:
  → record-builder.js: ambil snapshot terdekat saat posisi entry
  → validator.js: kondisi market saat signal trigger
```

---

### 7. Signal Generation

```
Trigger: TOP wallet (is_top_wallet = 1) buka posisi baru
              ↓
   validator.js:
   
   Cek 1 — Wallet valid?
     wallet.is_top_wallet = 1
     wallet.score >= minWalletScore
              ↓ Ya
   Cek 2 — Pool lolos screening?
     pool ada di screened_pools cache
     atau jalankan screening on-demand
              ↓ Ya
   Hitung combined_confidence:
     wallet_norm = wallet.score / 100
     pool_score  = composite_pool_score (0-1)
     confidence  = (wallet_norm * 0.4) + (pool_score * 0.6)
              ↓
   confidence >= minCombinedConfidence?
              ↓ Ya
   Buat signal:
     → suggested bin_step = bin_step yang dipakai top wallet
     → suggested range = range top wallet sebagai referensi
     → validation_reasons = list alasan lolos
     → Simpan ke table signals
     → emitter.js → tulis ke signals-output.json
              
   confidence < threshold?
     → Log sebagai 'rejected', tidak emit
```

---

### 8. Dataset Building & Export

```
Setiap posisi ditutup (status → 'closed'):

record-builder.js:
  → Ambil data posisi dari DB
  → Cari market_snapshot terdekat pada entry_timestamp
  → Ambil wallet score saat entry (dari score_updated log)
  → Gabungkan jadi TrainingRecord:
  
  {
    // LABEL — yang dipelajari Laminar
    was_profitable, pnl_usd, pnl_pct,
    fee_earned_usd, fee_yield, duration_hours,
    
    // FEATURES — yang dilihat Laminar saat entry
    pool_fee_apr, pool_volume_24h, pool_tvl,
    fee_tvl_ratio, pool_bin_step, token_pair,
    token_volatility_24h, token_price_change_24h,
    volume_vs_7d_avg, days_since_pool_created,
    bin_range_width, capital_usd,
    wallet_score_at_entry, wallet_wr_at_entry,
    hour_of_day, day_of_week,
    wallet_discovery_source   ← NEW: dari mana wallet ini ditemukan
  }
  
  → Simpan ke table training_records
  → Jika autoExportOnClose = true → append ke CSV

exporter.js (manual atau terjadwal):
  → Query semua training_records
  → Export ke datasetExportPath (CSV / JSON)
```

---

### 9. Alur Lengkap dari Awal (Zero Seed)

```
HARI 1 — STARTUP:
─────────────────
Scout start tanpa seed apapun

→ Pool screener jalan → dapat top 10 pool
→ studyTopLPers untuk setiap pool
→ Dapat ~200-500 wallet kandidat dalam 1 jam pertama
→ wallet-evaluator mulai backfill + score setiap kandidat
→ Dalam beberapa jam: 50-100 wallet sudah punya status 'tracked' atau 'top'
→ Real-time tracking mulai aktif

HARI 1 MALAM:
─────────────
→ TX mining sudah tangkap ratusan wallet baru dari aktivitas live
→ Follow winners sudah identifikasi wallet co-occurring
→ Antrian evaluasi terus bertambah

MINGGU 1:
─────────
→ DB berisi ribuan wallet kandidat
→ Ratusan sudah di-score dan di-tier
→ Puluhan masuk top wallet list
→ Signal pertama mulai muncul
→ Dataset mulai terisi dari posisi yang ditutup

BULAN 1-2:
──────────
→ Ratusan top wallet teridentifikasi
→ Ribuan posisi historis tersimpan
→ Dataset training ratusan records
→ Scout sudah bisa feed training data bermakna ke Laminar

OPSIONAL — BOOTSTRAP CEPAT:
────────────────────────────
node scripts/seed.js --file seed-wallets.txt
→ Masukkan 20-50 wallet manual dari screener screenshot
→ Evaluasi langsung, tidak perlu nunggu discovery cycle
→ Top wallet list tersedia dalam hitungan menit
→ Discovery engine tetap jalan paralel untuk ekspansi organik
```

---

## Signal Output Format

```json
{
  "id": 42,
  "pool": "ABCxyz...",
  "token_pair": "BONK/SOL",
  "confidence": 0.83,
  "trigger": {
    "type": "wallet_entry",
    "wallet": "WaLLeT...",
    "wallet_score": 51.3,
    "wallet_wr": 0.784
  },
  "pool_metrics": {
    "fee_apr": 2.61,
    "volume_24h": 485000,
    "tvl": 52000,
    "fee_tvl_ratio": 0.089,
    "organic_score": 74
  },
  "suggested": {
    "bin_step": 100,
    "range_lower": 95,
    "range_upper": 115
  },
  "validation_reasons": [
    "top_wallet_entered",
    "fee_apr_above_threshold",
    "volume_spike_detected",
    "organic_score_high"
  ],
  "created_at": 1750000000
}
```

---

## Integrasi dengan Laminar

Program ini **independen** — tidak ada import langsung dari Laminar. Komunikasi via:

1. **File JSON** (default): `signals-output.json` → Laminar baca via polling
2. **REST API** (opsional): POST ke endpoint Laminar
3. **Shared SQLite** (advanced): Laminar query langsung ke DB scout

Laminar tetap punya decision-making sendiri. Scout hanya menyediakan data dan signal.

---

## PM2 Config (`ecosystem.config.cjs`)

```javascript
module.exports = {
  apps: [
    {
      name: 'laminar-scout',
      script: 'src/index.js',
      cwd: __dirname,
      node_args: '--experimental-vm-modules',
      env_file: '.env',
      watch: false,
      autorestart: true,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'laminar-scout-webhook',
      script: 'src/collector/helius-stream.js',
      cwd: __dirname,
      env_file: '.env',
      watch: false,
      autorestart: true,
    }
  ]
}
```

---

## CLAUDE.md (untuk Claude Code / opencode)

Lihat file `CLAUDE.md` terpisah di root project.

---

## Prioritas Build

### Phase 1 — Foundation
- [ ] Setup project, package.json, struktur folder
- [ ] `db/schema.js` — inisialisasi SQLite (termasuk wallet_discovery_log)
- [ ] `config/config.js` — load env + config
- [ ] `utils/logger.js` — logger
- [ ] `utils/retry.js` — retry helper

### Phase 2 — Collector
- [ ] `collector/tx-parser.js` — parse Meteora DLMM TX
- [ ] `collector/helius-history.js` — backfill historis per wallet
- [ ] `collector/helius-stream.js` — webhook listener + TX mining global

### Phase 3 — Discovery Engine ← INTI BARU
- [ ] `discovery/pool-discovery.js` — scan top pools → extract wallet LP
- [ ] `discovery/tx-mining.js` — tangkap wallet baru dari TX global Meteora
- [ ] `discovery/follow-winners.js` — temukan wallet co-occurring dengan top wallets
- [ ] `discovery/wallet-evaluator.js` — auto backfill + score + tier setiap kandidat

### Phase 4 — Screener
- [ ] `screener/pool-screener.js` — port dari meridian screening
- [ ] `screener/metrics-fetcher.js` — fetch pool + token metrics
- [ ] `screener/pool-scorer.js` — composite scoring

### Phase 5 — Wallet Ranking & Tier
- [ ] `trackers/position-builder.js` — rekonstruksi posisi
- [ ] `wallets/wallet-ranker.js` — ranking + scoring wallet
- [ ] `wallets/wallet-filter.js` — promosi/demosi tier otomatis
- [ ] `wallets/seed-wallets.js` — load seed opsional

### Phase 6 — Signal & Dataset
- [ ] `signals/validator.js` — double validation
- [ ] `signals/emitter.js` — emit signal
- [ ] `dataset/record-builder.js` — build training record
- [ ] `dataset/exporter.js` — export CSV/JSON

### Phase 7 — Entry Point & PM2
- [ ] `src/index.js` — orchestration semua komponen + cron scheduler
- [ ] `ecosystem.config.cjs` — PM2 setup
- [ ] `scripts/seed.js` — import seed wallet opsional
- [ ] `scripts/backfill.js` — backfill manual opsional
- [ ] `.env.example` dan `scout-config.example.json`

---

## Catatan Penting

1. **Tidak ada eksekusi on-chain** — program ini read-only, tidak ada swap/deploy
2. **Helius diperlukan** untuk webhook, TX mining global, dan historical API
3. **Birdeye opsional** — untuk historical price/volume, bisa fallback ke Jupiter/CoinGecko
4. **Seed wallet bersifat opsional** — discovery engine bisa jalan mandiri tanpa seed
5. **DRY_RUN tidak relevan** di sini karena tidak ada transaksi — ada mode `verbose` untuk debugging
6. **Wallet tier system** — candidate → tracked → top → rejected, semua otomatis
7. **Re-evaluasi berkala** — wallet yang pernah rejected bisa naik tier jika performa membaik
8. **TX mining bisa mahal** di Helius jika tidak di-filter — pastikan filter hanya Meteora program ID
9. **Rate limiting** — backfill banyak wallet sekaligus bisa hit rate limit Helius, gunakan queue dengan delay
10. **Bootstrap opsional** — seed manual dari screener screenshot mempercepat top wallet list awal, tapi tidak wajib
