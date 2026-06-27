# CLAUDE.md — laminar-scout

## Konteks Project

`laminar-scout` adalah program independen yang berjalan terpisah dari Laminar (Meteora DLMM agent). Tugasnya:

- **Menyaring top wallet LP** di Meteora DLMM berdasarkan performa historis
- **Mengumpulkan metrik entry/exit** dari posisi mereka
- **Menghasilkan dataset** untuk training Laminar
- **Emit signal** saat top wallet masuk pool yang lolos screening

**Tidak ada eksekusi on-chain.** Program ini murni data pipeline + tracker.

---

## Referensi Penting

Sebelum build apapun, baca dan pahami logic dari meridian (base project Laminar):
- `tools/screening.js` → logic pool screening yang akan di-port
- `tools/study.js` → cara study top LPer
- `smart-wallets.js` → pattern wallet tracking
- `signal-tracker.js` dan `signal-weights.js` → signal management

Meridian ada di: `https://github.com/yunus-0x/meridian`

Baca SPEC.md di root project ini untuk detail lengkap arsitektur, schema DB, dan alur kerja.

---

## Rules

1. **Ikuti struktur direktori di SPEC.md** — jangan buat struktur baru tanpa alasan
2. **Gunakan ESM** (`"type": "module"` di package.json), konsisten dengan meridian
3. **SQLite via `better-sqlite3`** — bukan Postgres, bukan file JSON untuk data
4. **Tidak ada framework web** untuk webhook receiver — gunakan Node.js `http` native atau `express` minimal
5. **Jangan hardcode** API keys atau wallet address — semua dari `.env` atau `scout-config.json`
6. **Error handling wajib** di semua API call — gunakan retry helper dari `utils/retry.js`
7. **Log semua operasi penting** via `utils/logger.js`

---

## Discovery Engine

Scout **tidak butuh seed wallet manual** — dia temukan wallet sendiri via tiga mekanisme:

### 1. Pool Discovery
```javascript
// Setiap discovery cycle:
// 1. Ambil top pools dari pool screener
// 2. Untuk setiap pool → studyTopLPers(pool) [port dari meridian tools/study.js]
// 3. Dapat list wallet LP → insert sebagai 'candidate' jika belum ada di DB
```

### 2. TX Mining
```javascript
// Subscribe ke Helius untuk SEMUA TX Meteora DLMM program:
// programId: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
// Setiap TX addLiquidity yang masuk → ekstrak wallet → tambah sebagai kandidat
```

### 3. Follow Winners
```javascript
// Untuk setiap top wallet (is_top_wallet = 1):
// Lihat pool yang mereka masuki → siapa lagi yang LP di pool yang sama
// Dalam timeframe berdekatan → kandidat potensial
```

### Wallet Evaluator
```javascript
// Untuk setiap kandidat baru:
// 1. Backfill TX historis via Helius
// 2. Rekonstruksi semua posisi
// 3. Hitung WR%, fee yield, PNL, score
// 4. Bandingkan dengan threshold → promosi tier atau reject
```

### Wallet Tier
```
candidate → tracked → top → rejected
                          ↑ (re-evaluasi berkala, bisa naik kembali)
```

---

## Helius API

### Webhook (real-time)
```javascript
// Endpoint yang perlu di-register ke Helius dashboard:
// POST /webhook/helius
// Secret: HELIUS_WEBHOOK_SECRET dari .env

// Filter TX yang relevan:
// - programId: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo (Meteora DLMM)
// - type: ADD_LIQUIDITY | REMOVE_LIQUIDITY | CLAIM_FEES
```

### Historical API
```javascript
// Fetch TX historis per wallet:
// GET https://api.helius.xyz/v0/addresses/{wallet}/transactions
// ?api-key={HELIUS_API_KEY}&type=ADD_LIQUIDITY&limit=100
```

---

## Meteora DLMM Program ID

```
LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
```

Instruction discriminators yang perlu di-parse:
- `addLiquidity` — posisi baru dibuka
- `removeLiquidity` — posisi ditutup (sebagian/full)
- `claimFee` — fee diklaim

---

## Pool Screening API (dari meridian)

Meridian menggunakan endpoint berikut untuk fetch kandidat pool:
```
// Cek tools/screening.js di meridian untuk URL lengkap
// Biasanya: Meteora API + Jupiter API untuk token info
```

Port logika filtering dari `screening.js` meridian ke `screener/pool-screener.js`. Threshold ada di `scout-config.json`.

---

## Wallet Scoring Formula

```javascript
// Composite score wallet (0-100)
function calculateWalletScore(wallet) {
  const wrScore = wallet.win_rate * 40;          // max 40 poin
  const feeScore = Math.min(wallet.avg_fee_yield / 3 * 20, 20); // max 20 poin
  const consistencyScore = Math.min(wallet.total_positions / 100 * 20, 20); // max 20 poin
  const pnlScore = wallet.total_pnl_usd > 0 ? 20 : 0; // max 20 poin
  
  return wrScore + feeScore + consistencyScore + pnlScore;
}
```

---

## Signal Confidence Formula

```javascript
// Combined confidence untuk double validation
function calculateConfidence(walletScore, poolScore) {
  // wallet score sudah 0-100, normalize ke 0-1
  const wNorm = walletScore / 100;
  // pool score sudah 0-1
  return (wNorm * 0.4) + (poolScore * 0.6);
}
```

---

## Development Flow

### Setup awal:
```bash
npm install
cp config/scout-config.example.json scout-config.json
cp .env.example .env
# Edit .env dengan Helius API key
node src/index.js  # scout langsung mulai discovery tanpa seed
```

### Bootstrap cepat (opsional):
```bash
# Jika ingin ada top wallet cepat di hari pertama
node scripts/seed.js --file seed-wallets.txt
```

### Backfill manual wallet tertentu (opsional):
```bash
node scripts/backfill.js --wallet <address> --days 90
```

### Running via PM2:
```bash
npm run pm2:start
npm run pm2:logs
npm run pm2:restart
```

---

## Output Signal

Signal ditulis ke `signals-output.json` (default). Format harus persis seperti di SPEC.md agar kompatibel dengan Laminar yang akan membacanya.

---

## Hal yang Tidak Perlu Dibuat

- Tidak perlu Telegram bot
- Tidak perlu Discord listener
- Tidak perlu REPL interaktif
- Tidak perlu HiveMind sync
- Tidak perlu UI apapun
- Tidak perlu `agent.js` / ReAct loop (itu urusan Laminar)
- Seed wallet **tidak wajib** — discovery engine cukup untuk start

Fokus: **discover → evaluate → rank → screen → signal → dataset**
