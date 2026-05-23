# Charon Improvement Plan

Berdasarkan insight dari [ponyin.id](https://www.ponyin.id/) — 9 materi inti + materi advance tentang on-chain Solana trading.

---

## Daftar Isi

- [Fase 1 — Core Filter & Data Enrichment](#fase-1--core-filter--data-enrichment)
  - [Item 1: Global Fees Ratio](#item-1-global-fees-ratio-filter)
  - [Item 2: Mint & Freeze Authority Check](#item-2-mint--freeze-authority-check)
  - [Item 3: Market Cap Tier Classification](#item-3-market-cap-tier-classification)
  - [Item 8: LLM Prompt Upgrade](#item-8-llm-prompt-upgrade)
- [Fase 2 — Advanced Detection](#fase-2--advanced-detection)
  - [Item 5: Bundle Wallet Clustering](#item-5-bundle-wallet-clustering)
  - [Item 9: Holder Multi-Wallet Unmasking](#item-9-holder-multi-wallet-unmasking)
  - [Item 6: Cabal Wallet Tracking](#item-6-cabal-wallet-tracking)
- [Fase 3 — Strategy & Execution](#fase-3--strategy--execution)
  - [Item 4: Dex Paid / Boost Timing Analysis](#item-4-dex-paid--boost-timing-analysis)
  - [Item 7: Dip Buy 2-Step Confirmation](#item-7-dip-buy-2-step-confirmation)
- [Appendix: Insight dari Ponyin](#appendix-insight-dari-ponyin)

---

## Fase 1 — Core Filter & Data Enrichment

| # | Item | Prioritas | File Utama |
|---|---|---|---|
| 1 | Global Fees Ratio — Deteksi Wash Trading | Tinggi | `candidateBuilder.js`, `connection.js` |
| 2 | Mint & Freeze Authority Check | Tinggi | `tokenAuth.js` (baru), `candidateBuilder.js` |
| 3 | Market Cap Tier Classification | Tinggi | `utils.js`, `candidateBuilder.js`, `llm.js` |
| 8 | LLM Prompt Upgrade | Tinggi | `llm.js` |

---

### Item 1: Global Fees Ratio Filter

**Masalah:** Ponyin mengajarkan bahwa "volume tinggi tapi fee sangat kecil = wash trading". Saat ini Charon hanya punya flag `is_wash_trading` dari data trending eksternal, tanpa validasi sendiri dari rasio fee terhadap volume.

**Perubahan:**

#### `src/pipeline/candidateBuilder.js`

Di `buildCandidate()`, tambah field baru ke `candidate.metrics`:

```js
gmgnFeeToVolumeRatio: null // dihitung dari gmgnTotalFeesSol / volume terkait
```

Logika: pakai `gmgnTotalFeesSol` sebagai fee total, bandingkan dengan volume yang relevan (graduated atau trending). Kalau volume = 0 atau N/A, set null.

Di `filterCandidate()`, tambah filter:

```
min_gmgn_fee_volume_ratio  (default: 0.002 ≈ 0.25%)
```

Filter: kalau `gmgnFeeToVolumeRatio < min_gmgn_fee_volume_ratio` → `failures.push('global fee ratio: X% < Y% — suspected wash trading')`

#### `src/db/connection.js`

Default settings:
```
min_gmgn_fee_volume_ratio = '0.002'
```

Tambah `min_gmgn_fee_volume_ratio: 0.002` ke config default semua strategi (sniper, dip_buy, smart_money, degen).

#### `src/db/settings.js`

Tambah `min_gmgn_fee_volume_ratio: 0.002` di `defaultStrategy()`.

---

### Item 2: Mint & Freeze Authority Check

**Masalah:** Ponyin: "Revoke done ≠ Token safe". Banyak developer revoke authority setelah bundle supply di awal, memberi kesan palsu bahwa token aman. Charon tidak pernah mengecek status `mintAuthority` dan `freezeAuthority` on-chain.

**Perubahan:**

#### `src/enrichment/tokenAuth.js` (BARU)

Fetch token mint account info via Helius RPC `getAccountInfo` untuk membaca Mint account layout:

```js
async function fetchTokenAuth(mint) {
  // Panggil RPC: getAccountInfo(mint, { commitment: 'confirmed' })
  // Parse Mint account data (165 bytes):
  //   - offset 0: mintAuthorityOption (4 bytes) → 0 = none, 1 = some
  //   - offset 4: mintAuthority (32 bytes, optional)
  //   - offset 44: supply (8 bytes)
  //   - offset 52: decimals (1 byte)
  //   - offset 53: isInitialized (1 byte)
  //   - offset 54: freezeAuthorityOption (4 bytes)
  //   - offset 58: freezeAuthority (32 bytes, optional)
  // Return: { mintActive: bool, freezeActive: bool, mintAuthority: string|null, freezeAuthority: string|null }
}
```

- Cache per mint dengan TTL 5 menit (Map)
- Error handling: kalau RPC fail → return null (tidak blocking pipeline)
- Gunakan `SOLANA_RPC_URL` dari config

#### `src/pipeline/candidateBuilder.js`

- Import `fetchTokenAuth` dari `../enrichment/tokenAuth.js`
- Panggil paralel dengan fetch lainnya di `buildCandidate()`:
  ```js
  const tokenAuth = await fetchTokenAuth(mint);
  ```
- Simpan di candidate:
  ```js
  candidate.tokenAuth = tokenAuth;
  ```

Di `filterCandidate()`, tambah param strategy:
- `reject_mint_active` (default: false)
- `reject_freeze_active` (default: false)

Filter: jika param aktif dan authority masih aktif → reject.

#### `src/db/connection.js`

Default settings:
```
reject_mint_active = 'false'
reject_freeze_active = 'false'
```

Diaktifkan by default di strategi `smart_money` saja (paling strict).

---

### Item 3: Market Cap Tier Classification

**Masalah:** Ponyin: "Setiap tier market cap punya ekosistem pemain, level risiko, dan cara baca yang berbeda total. Strategi yang profit di new pair bisa jadi bencana di mid cap."

**Perubahan:**

#### `src/utils.js`

Tambah fungsi:

```js
export function classifyMcapTier(mcapUsd) {
  if (!Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  if (mcapUsd < 100_000) return 'new_pair';
  if (mcapUsd < 5_000_000) return 'micro_cap';
  if (mcapUsd < 50_000_000) return 'mid_cap';
  if (mcapUsd < 200_000_000) return 'high_cap';
  return 'cex_listed';
}
```

#### `src/pipeline/candidateBuilder.js`

Di `buildCandidate()`, setelah `marketCapUsd` dihitung:

```js
const mcapTier = classifyMcapTier(marketCapUsd);
```

Simpan di `candidate.metrics.mcapTier`.

Di `filterCandidate()`, tambah filter sederhana:
- `reject_cex_listed` (default: true) — skip token > 200M karena lawannya market maker profesional.

#### `src/pipeline/llm.js`

Di `compactCandidateForLlm()`, tambah field `mcapTier` ke output compact supaya LLM tahu konteks tier.

---

### Item 8: LLM Prompt Upgrade

**Masalah:** Prompt LLM saat ini belum diberi konteks tentang global fee ratio, authority status, dan MC tier — padahal ini critical signal buat decision making.

**Perubahan:**

#### `src/pipeline/llm.js`

##### `compactCandidateForLlm()`

Tambah field:
- `feeToVolumeRatio` — dari Item 1
- `mcapTier` — dari Item 3
- `tokenAuth` — ringkasan `{mintActive, freezeActive}` dari Item 2

##### System prompt (baris 83-94)

Tambah guidance:
```
- Global fee-to-volume ratio below 0.25% may indicate wash trading / fake volume.
- Active mint authority = developer can mint unlimited new tokens, diluting holders.
- Active freeze authority = developer can freeze any holder's tokens.
- Market cap tier context: new_pair (<100k) = pure chaos/momentum; micro_cap (100k-5M) = TA works; mid_cap (5M-50M) = serious players; high_cap (50M-200M) = whale/narrative control; cex_listed (>200M) = professional market makers.
- Holder percentage per wallet can be misleading due to multi-wallet clustering.
```

---

## Fase 2 — Advanced Detection

| # | Item | Prioritas | File Utama |
|---|---|---|---|
| 5 | Bundle Wallet Clustering | Sedang | `clustering.js` (baru), `candidateBuilder.js` |
| 9 | Holder Multi-Wallet Unmasking | Sedang | `clustering.js` |
| 6 | Cabal Wallet Tracking | Sedang | `wallets.js`, `connection.js` |

---

### Item 5: Bundle Wallet Clustering

**Masalah:** Ponyin mengajarkan bahwa bundle token ditandai oleh banyak wallet yang membeli di milidetik pertama, didanai dari sumber yang sama. Charon saat ini hanya mengandalkan `bundler_rate` eksternal.

**Perubahan:**

#### `src/enrichment/clustering.js` (BARU)

Fungsi utama:
```js
async function analyzeFirstBlockBuyers(mint) {
  // 1. Fetch transaksi awal token (via Helius RPC atau Jupiter)
  // 2. Identifikasi wallet yang membeli di block pertama / milidetik pertama
  // 3. Untuk setiap wallet, cek common funding source:
  //    - Lacak funding transaction (siapa yang transfer SOL ke wallet itu pertama kali)
  //    - Cluster wallet berdasarkan funding source yang sama
  // 4. Return: { clusterCount, totalSupplyPercent, fundingClusters: [{ funder, wallets: [], totalPercent }] }
}
```

```js
async function computeClusterScore(holders) {
  // Analisis holder untuk menemukan wallet yang punya funding source sama
  // Score 0-100: semakin tinggi = semakin terindikasi bundle
  // Gunakan Jupiter holder data + RPC untuk tracing funder
  // Return: { clusterScore, clusterCount, topClusterPercent, warnings: [] }
}
```

- Cache per mint, TTL 10 menit
- Graceful degradation: kalau RPC gagal, return null

#### `src/pipeline/candidateBuilder.js`

- Import `computeClusterScore` dari `../enrichment/clustering.js`
- Panggil di `buildCandidate()`:
  ```js
  const clusterAnalysis = await computeClusterScore(holders);
  ```
- Simpan di candidate:
  ```js
  candidate.clusterAnalysis = clusterAnalysis;
  ```

#### `src/pipeline/candidateBuilder.js` — `filterCandidate()`

Tambah param strategy:
- `max_bundle_cluster_score` (default: 70) — reject jika cluster score di atas threshold

---

### Item 9: Holder Multi-Wallet Unmasking

**Masalah:** Ponyin: "Satu orang bisa punya 5-20 wallet berbeda. Meskipun setiap wallet cuma 2%, totalnya bisa 20-40%." Charon saat ini cuma pakai `max_top20_holder_percent` yang gak bisa deteksi multi-wallet.

**Perubahan:**

#### `src/enrichment/clustering.js` (lanjutan dari Item 5)

Fungsi:
```js
async function analyzeHolderClusters(holders) {
  // 1. Ambil daftar holder dari Jupiter holders API
  // 2. Untuk setiap holder di top 50, trace funding source:
  //    - Cek transaksi masuk pertama wallet → siapa funder-nya
  //    - Cek apakah wallet ini sering transaksi dengan wallet lain
  // 3. Cluster berdasarkan funder yang sama
  // 4. Hitung "effective concentration" setelah clustering
  // Return: {
  //   rawTop20Percent,           // existing
  //   clusteredTop20Percent,     // setelah digabung per cluster
  //   clusterCount,
  //   clusters: [{ funder, wallets: [], totalPercent }],
  //   effectiveConcentrationRisk: 'low'|'medium'|'high',
  //   warnings: []
  // }
}
```

- Data transaksi bisa diambil dari Helius RPC (getSignaturesForAddress + getTransaction)
- Cache per mint, TTL 10 menit

#### `src/pipeline/candidateBuilder.js`

- Import `analyzeHolderClusters` dari `../enrichment/clustering.js`
- Gabung dengan panggilan cluster analysis:
  ```js
  const clusterAnalysis = await analyzeHolderClusters(holders);
  ```
- Simpan: `candidate.clusterAnalysis`

#### `src/pipeline/candidateBuilder.js` — `filterCandidate()`

Tambah param strategy:
- `max_clustered_top20_percent` (default: 80) — batas konsentrasi efektif setelah clustering
- `reject_high_cluster_risk` (default: false) — reject kalau `effectiveConcentrationRisk` = high

#### `src/pipeline/llm.js`

Tambah ke compact candidate:
```js
clusterAnalysis: {
  rawTop20Percent,
  clusteredTop20Percent,
  effectiveConcentrationRisk,
  warnings
}
```

Tambah guidance ke system prompt:
```
- Holder concentration may appear lower than reality due to multi-wallet clustering.
- Check clusteredTop20Percent for effective concentration after wallet clustering.
```

---

### Item 6: Cabal Wallet Tracking

**Masalah:** Ponyin menjelaskan tentang cabal — kelompok terorganisir yang bergerak bersama. Charon punya saved wallet system tapi tidak mendeteksi pola pergerakan bersama antar wallet.

**Perubahan:**

#### `src/enrichment/wallets.js`

Tambah fungsi:
```js
// Track wallet co-movement patterns
async function detectCabalActivity(mint, holders) {
  // 1. Ambil historical trades dari wallet-wallet signifikan di token ini
  // 2. Cari pasangan wallet yang konsisten buy/sell bareng di >2 token berbeda
  // 3. Kalau ditemukan cluster, simpan ke DB sebagai cabal cluster
  // 4. Return: { isCabalActive: bool, cabalClusters: [], totalSupplyControlled: number }
}
```

#### `src/db/connection.js`

Tambah tabel baru:
```sql
CREATE TABLE IF NOT EXISTS cabal_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  cluster_json TEXT NOT NULL,       -- array of wallet addresses
  first_detected_ms INTEGER NOT NULL,
  last_active_ms INTEGER NOT NULL,
  total_tokens_tracked INTEGER DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cabal_clusters_label ON cabal_clusters(label);
```

Tambah event log:
```sql
CREATE TABLE IF NOT EXISTS cabal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER,
  mint TEXT NOT NULL,
  cluster_id INTEGER,
  kind TEXT NOT NULL,          -- 'detected', 'active', 'conflict'
  details_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
```

#### `src/pipeline/candidateBuilder.js` — `buildCandidate()`

Panggil:
```js
const cabalActivity = await detectCabalActivity(mint, holders);
```

Simpan: `candidate.cabalActivity`

#### `src/pipeline/llm.js`

Tambah ke compact candidate + prompt guidance:
```
- Cabal clusters detected: N clusters controlling X% supply.
- Cabal conflict (two groups competing) may create volume opportunities.
```

---

## Fase 3 — Strategy & Execution

| # | Item | Prioritas | File Utama |
|---|---|---|---|
| 4 | Dex Paid / Boost Timing Analysis | Rendah | `candidateBuilder.js`, `jupiter.js` |
| 7 | Dip Buy 2-Step Confirmation | Rendah | `priceMonitor.js`, `execution/router.js` |

---

### Item 4: Dex Paid / Boost Timing Analysis

**Masalah:** Ponyin: "Boost + Ads muncul mendadak setelah pump besar = sinyal distribusi." Charon tidak melacak timing kemunculan Dex Paid, Ads, atau Boost.

**Perubahan:**

#### `src/enrichment/jupiter.js`

Tambah fungsi:
```js
async function fetchTokenListingEvents(mint) {
  // Cek dari Jupiter Asset API atau DexScreener API:
  // - Kapan Dex Paid pertama terdeteksi
  // - Kapan Ads/Boost pertama muncul
  // Return: { dexPaidAtMs, firstAdAtMs, firstBoostAtMs, currentHasDexPaid, currentHasAds, currentHasBoost }
}
```

#### `src/pipeline/candidateBuilder.js`

Di `buildCandidate()`:
- Panggil `fetchTokenListingEvents(mint)`
- Simpan `candidate.listingEvents`

Di `filterCandidate()`:
- Tambah param: `max_dex_paid_age_ms` (default: 0 = nonaktif)
- Filter: kalau Dex Paid muncul setelah token berusia >X ms dan sudah pump → flag distribusi risk
- `recent_boost_without_volume` (default: false) — flag kalau boost muncul tanpa volume organik

---

### Item 7: Dip Buy 2-Step Confirmation

**Masalah:** Ponyin: "First dip → jangan masuk. Bounce → 10% entry. Second dip → full entry." Charon punya strategi `dip_buy` tapi cuma pakai `max_ath_distance_pct` tanpa mekanisme konfirmasi bertahap.

**Perubahan:**

#### `src/signals/priceMonitor.js`

Tambah state tracking untuk partial entry:
```js
// Track partial entry state per mint
const dipBuyState = new Map();
// { mint: { step: 'watching'|'first_bounce'|'full_entry', enteredAt, entryPrice, entrySize } }
```

Modifikasi logika price alert:
- **Step 1 — Watching:** Price turun melewati `ath_distance_pct` trigger → pantau
- **Step 2 — First Bounce:** Price naik X% dari lowest → execute 10% dari planned size. Simpan state.
- **Step 3 — Second Dip:** Price turun lagi ke area first dip → execute sisa 90%

#### `src/execution/router.js`

Tambah fungsi:
```js
async function executeDipBuyStep(mint, step, sizeSol) {
  // Execute partial buy sesuai step
  // Store state ke DB agar survive restart
}
```

#### `src/db/connection.js`

Tambah tabel:
```sql
CREATE TABLE IF NOT EXISTS dip_buy_states (
  mint TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  step TEXT NOT NULL,
  planned_size_sol REAL NOT NULL,
  executed_size_sol REAL NOT NULL DEFAULT 0,
  first_entry_price REAL,
  first_entry_at_ms INTEGER,
  lowest_price REAL,
  bounce_price REAL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

#### Strategy config tambahan:
- `dip_first_entry_pct` (default: 10) — % posisi yang dieksekusi di first bounce
- `dip_bounce_trigger_pct` (default: 5) — % kenaikan dari lowest untuk trigger first bounce
- `dip_second_dip_tolerance_pct` (default: 10) — tolerasi harga second dip terhadap first dip

---

## Appendix: Insight dari Ponyin

### Vol. 1 — 9 Pelajaran Dasar

| # | Pelajaran | Intisari untuk Charon |
|---|---|---|
| 1 | Bundle Token | Deteksi monopoli supply tersembunyi — banyak wallet tapi satu kontrol |
| 2 | Global Fees | Rasio fee/volume sebagai detektor volume palsu |
| 3 | Revoke & Minting | Revoke != aman; cek mint & freeze authority secara terpisah |
| 4 | Meme vs Utility | Bedain karakteristik; untuk new pair, narasi & momentum > fundamental |
| 5 | Dex Paid / Ads / Boost | Timing kemunculan = sinyal distribusi atau komitmen |
| 6 | 3 Konfirmasi Candle | Entry bertahap: 10% first bounce, 90% second dip |
| 7 | Cabal Play | Tracking wallet yang bergerak bersama; indikator teknikal konvensional tidak relevan |
| 8 | Membaca Holder | Multi-wallet bikin persentase holder per wallet misleading |
| 9 | Market Cap Tier | Tiap tier punya strategi berbeda; pemain dan risikonya berbeda total |

### Key Quotes

> "Bundle bukan soal berapa banyak wallet yang beli — tapi berapa banyak wallet yang sebetulnya dikontrol oleh satu orang di balik layar."

> "Revoke sudah dilakukan ≠ Token aman."

> "Boost + Ads muncul mendadak setelah token sudah pump besar = sinyal distribusi."

> "Kesalahan paling umum: memakai strategi yang sama di semua level market cap."

> "Aturan 'holder di bawah 3%' sudah tidak relevan di era multi-wallet."

> "Hampir semua indikator teknikal konvensional seperti RSI, MACD, Bollinger Bands — tidak berguna di cabal play."
