# Laminar Scout — Flow Kerja

```mermaid
flowchart TD
    subgraph STARTUP["1. Startup"]
        A1[Load .env & scout-config.json]
        A2[Init SQLite: data/scout.db]
        A3[Start cron jobs]
        A4[Start web dashboard + WebSocket]
        A5[(Optional) seed wallet manual]
        A1 --> A2 --> A3 --> A4 --> A5
    end

    subgraph DISCOVERY["2. Wallet Discovery"]
        B1["Pool Discovery<br/>trending + established pools"]
        B2["TX Mining<br/>Helius webhook Meteora DLMM"]
        B3["Follow Winners<br/>top wallet network"]
        B4[(Insert as candidate)]
        B1 --> B4
        B2 --> B4
        B3 --> B4
    end

    subgraph SCREENING["3. Pool Screening"]
        C1["Discover Pools"]
        C2{"Lolos threshold?<br/>TVL, volume, organic, bin step, fee/TVL"}
        C3[(Simpan snapshot)]
        C1 --> C2 -->|yes| C3
    end

    subgraph EVALUATION["4. Wallet Evaluation"]
        D1["Ambil wallet candidate"]
        D2["Helius history backfill<br/>30 hari, max 500 TX"]
        D3["Portfolio / open positions"]
        D4["LPAgent studyTopLPers<br/>cache + circuit breaker"]
        D5["Merge & hitung score"]
        D6{"Lolos threshold?"}
        D7["tracked"]
        D8["rejected"]

        D1 --> D2 --> D5
        D1 --> D3 --> D5
        D1 --> D4 --> D5
        D5 --> D6
        D6 -->|yes| D7
        D6 -->|no| D8
    end

    subgraph RANKING["5. Ranking"]
        E1["Urutkan tracked by score"]
        E2{"Score ≥ 60?"}
        E3["is_top_wallet = 1"]
        E1 --> E2 -->|yes| E3
    end

    subgraph SIGNAL["6. Signal Scan"]
        F1["Top wallet masuk pool"]
        F2{"Pool lolos screening?"}
        F3["Hitung combined confidence"]
        F4{"Confidence ≥ 0.70?"}
        F5["Emit signal"]
        F6[(signals-output.json)]

        F1 --> F2 -->|yes| F3 --> F4 -->|yes| F5 --> F6
    end

    subgraph DATASET["7. Dataset Export"]
        G1["Posisi closed"]
        G2["Bangun training record"]
        G3[(training-records.csv)]
        G1 --> G2 --> G3
    end

    A4 --> DISCOVERY
    B4 --> EVALUATION
    C3 --> SIGNAL
    D7 --> RANKING
    E3 --> SIGNAL
    D7 --> DATASET

    style STARTUP fill:#0a0c12,stroke:#00f0ff
    style DISCOVERY fill:#0a0c12,stroke:#a855f7
    style SCREENING fill:#0a0c12,stroke:#3b82f6
    style EVALUATION fill:#0a0c12,stroke:#00d4aa
    style RANKING fill:#0a0c12,stroke:#f59e0b
    style SIGNAL fill:#0a0c12,stroke:#f472b6
    style DATASET fill:#0a0c12,stroke:#7d8ba3
```

---

## Penjelasan Tiap Fase

### 1. Startup
- Load konfigurasi dan API key.
- Inisialisasi database SQLite dengan WAL mode.
- Jalankan cron: discovery, screening, snapshot, ranking, signal scan.
- Nyalakan dashboard web + WebSocket.

### 2. Wallet Discovery
Tiga jalur paralel menemukan wallet kandidat:
- **Pool Discovery**: scan pool trending/established → study top LPer → insert candidate.
- **TX Mining**: Helius webhook deteksi add liquidity Meteora → insert candidate.
- **Follow Winners**: dari top wallet, cari wallet lain di pool yang sama → insert candidate.

### 3. Pool Screening
- Fetch pool dari Meteora.
- Filter threshold: TVL, volume, organic score, bin step, fee/TVL, token age, dll.
- Simpan snapshot market ke DB.

### 4. Wallet Evaluation
Setiap candidate dievaluasi dengan 3 sumber data:
- **Helius history**: 30 hari activity, position stubs.
- **Portfolio/open**: posisi terbuka saat ini, PnL, fees.
- **LPAgent**: historical closed positions + aggregate (dengan cache & circuit breaker).

Hitung score, bandingkan threshold:
- Lolos → `tracked`
- Gagal → `rejected`

### 5. Ranking
- Urutkan tracked wallet by score.
- Wallet dengan score ≥ 60 jadi `top wallet`.

### 6. Signal Scan
- Saat top wallet masuk pool yang lolos screening.
- Hitung `combined_confidence = wallet_score * 0.4 + pool_score * 0.6`.
- Kalau ≥ 0.70, emit signal ke `signals-output.json`.

### 7. Dataset Export
- Posisi closed diubah jadi training record.
- Export ke CSV untuk training Laminar.
