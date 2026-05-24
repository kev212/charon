# Bundle Detection — Implementation Plan

Fokus implementasi langsung dari Ponyin insight ke Charon.

---

## Problem

Di Pump.fun, bundle adalah praktik di mana satu entitas mengontrol 10-30+ wallet yang semuanya beli token yang sama di blok pertama setelah launch. Tujuannya:

- Bikin **holder count** keliatan tinggi dan sehat
- Bikin **chart** keliatan organik naik
- Bikin **supply distribution** keliatan terdesentralisasi
- Setelah retail masuk, bundle tinggal **dump** — dan entitas itu untung besar

Charon sekarang cuma punya `max_top20_holder_percent` filter. Itu gak cukup karena holder % bisa keliatan kecil kalau supply disebar ke 30 wallet.

---

## Pendekatan — 3 Layer Detection

```
Layer 1: GMGN Snipers Data (0 RPC, every candidate)
    ↓
Layer 2: Signal Tx Inner Instruction Parsing (0 RPC, every candidate)
    ↓
Layer 3: Block + Transaction Analysis (1-3 RPC, only if score > 40)
```

Ketiga layer independen dan bisa dijalankan bersamaan. Hasilnya di-merge ke satu `bundleRiskScore` (0-100).

---

## Layer 1 — GMGN Snipers Check

Charon udah fetch GMGN `/v1/token/info` di `src/enrichment/gmgn.js`. Data relevan yang udah ada:

| GMGN Field | Makna |
|---|---|
| `snipers_count` | Jumlah wallet yang beli di block pertama |
| `snipers_balance` | Total balance dari sniper wallets |
| `dev_hold_percent` | % supply masih dipegang deployer |
| `top10_hold_percent` | % supply dipegang 10 holder teratas |

**Logic baru di `gmgn.js`:**

```js
function computeBundleScoreFromGmgn(info) {
  if (!info) return null;

  const snipersCount = info.snipers_count || 0;
  const snipersBalancePct = info.total_supply > 0
    ? (Number(info.snipers_balance || 0) / info.total_supply) * 100
    : 0;
  const devHoldPct = info.dev_hold_percent || 0;
  const top10HoldPct = info.top10_hold_percent || 0;

  let score = 0;

  // Jumlah sniper: makin banyak makin suspicious
  if (snipersCount > 15) score += 35;
  else if (snipersCount > 8) score += 25;
  else if (snipersCount > 3) score += 15;

  // Supply yang dikuasai sniper
  if (snipersBalancePct > 60) score += 30;
  else if (snipersBalancePct > 40) score += 20;
  else if (snipersBalancePct > 20) score += 10;

  // Dev sudah gak pegang banyak, tapi top 10 pegang banyak
  // Artinya supply udah disebar ke wallet lain (bundle potensial)
  if (devHoldPct < 5 && top10HoldPct > 80) score += 25;
  else if (devHoldPct < 10 && top10HoldPct > 70) score += 15;

  return {
    score: Math.min(score, 100),
    snipersCount,
    snipersBalancePct: Math.round(snipersBalancePct * 100) / 100,
    bundleLikely: score >= 50,
  };
}
```

**Integrasi:** Export function ini dari `gmgn.js`, panggil setelah `fetchGmgnTokenInfo` di `buildCandidate()`, hasilnya masuk ke `candidate.metrics` sebagai `gmgnBundleScore`.

---

## Layer 2 — Signal Transaction Parsing

### Data yang udah ada

Charon udah fetching signal tx (signature string) di `src/signals/` dan parsing fee claim via `parseDistFees()`. Kita perlu parse lebih dalam: **inner instructions** dari tx yang sama.

### Teknik

Setiap Pump.fun transaction punya inner instructions yang menunjukkan transfer SOL dan token. Struktur umum untuk early buys:

```
Outer Instruction: Pump.fun program → buy/create
├── Inner Instruction 0: system_program → transfer SOL
├── Inner Instruction 1: spl_token → transfer token → walletA
├── Inner Instruction 2: system_program → transfer SOL
├── Inner Instruction 3: spl_token → transfer token → walletB
├── Inner Instruction 4: system_program → transfer SOL
├── Inner Instruction 5: spl_token → transfer token → walletC
...
```

### Implementasi

**File baru:** `src/anti/bundle.js`

```js
import { Connection, PublicKey } from '@solana/web3.js';

export function parseBundleFromTx(tx, mint, targetMint) {
  if (!tx?.meta?.innerInstructions?.length) return null;

  const buyWallets = new Map(); // wallet → totalAmount (raw)
  const knownPrograms = new Set([
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // Pump AMM
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',    // SPL Token
  ]);

  for (const ixGroup of tx.meta.innerInstructions) {
    for (const ix of ixGroup.instructions) {
      // Parse transfer-checked atau transfer instruction
      if (ix.parsed?.type === 'transferChecked') {
        const info = ix.parsed.info;
        if (info.mint === targetMint && info.destination) {
          // Destination harus user wallet, bukan program
          const dest = info.destination;
          if (!knownPrograms.has(dest)) {
            const amount = Number(info.tokenAmount?.amount || info.amount || 0);
            buyWallets.set(dest, (buyWallets.get(dest) || 0) + amount);
          }
        }
      }
    }
  }

  if (buyWallets.size === 0) return null;

  const amounts = Array.from(buyWallets.values());
  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance = amounts.reduce((sum, a) => sum + (a - avgAmount) ** 2, 0) / amounts.length;
  const stdDev = Math.sqrt(variance);
  const deviationCoeff = avgAmount > 0 ? stdDev / avgAmount : 1;

  // Kalau jumlah wallet banyak dan amountnya seragam → bundle
  let score = 0;
  const walletCount = buyWallets.size;

  if (walletCount >= 10) score += 35;
  else if (walletCount >= 5) score += 25;
  else if (walletCount >= 3) score += 15;

  // Coefficient of variation < 20% = amount seragam
  if (deviationCoeff < 0.15) score += 30;
  else if (deviationCoeff < 0.3) score += 15;

  return {
    score: Math.min(score, 100),
    walletCount,
    deviationCoeff: Math.round(deviationCoeff * 100) / 100,
    totalTokensBundled: amounts.reduce((a, b) => a + b, 0),
    bundleDetected: score >= 50,
  };
}
```

**Integrasi:** Function ini dipanggil di `buildCandidate()` setelah signal tx di-fetch. Parameter `tx` di-pass dari signal event (sekarang udah miliki `signature` string). Detail: parsing `parsed` instruction paling akurat kalau tx di-fetch dengan `getTransaction(sig, {maxSupportedVersion: 0})` dan `commitment: 'confirmed'`.

---

## Layer 3 — Block Analysis

### Kapan dijalankan

Hanya kalau score dari Layer 1 + Layer 2 > 40. Tujuannya: **konfirmasi lebih lanjut** tanpa tes.

### Logic

```js
export async function analyzeEarlyTxPattern(mint, connection) {
  // 1 transaksi: fetch signatures
  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(
      new PublicKey(mint),
      { limit: 30 },
      'confirmed'
    );
  } catch {
    return null;
  }

  if (!sigs?.length) return null;

  // Group by slot
  const slotGroups = new Map();
  for (const sig of sigs) {
    const count = slotGroups.get(sig.slot) || 0;
    slotGroups.set(sig.slot, count + 1);
  }

  // Slot yang mana yang paling padat?
  const maxTxInSlot = Math.max(...slotGroups.values(), 0);
  const firstSlotTxCount = slotGroups.get(sigs[0].slot) || 0;
  const slotCountTotal = slotGroups.size;

  // Score berdasarkan density
  let score = 0;
  if (maxTxInSlot > 15) score += 20;
  else if (maxTxInSlot > 8) score += 12;
  else if (maxTxInSlot > 4) score += 6;

  // First slot punya banyak tx
  const fractionFirstSlot = firstSlotTxCount / sigs.length;
  if (fractionFirstSlot > 0.5) score += 15;
  else if (fractionFirstSlot > 0.3) score += 8;

  // Kalau banyak tx tapi jumlah slot sedikit = semua tertumpuk = suspicious
  const avgDensity = sigs.length / Math.max(slotCountTotal, 1);
  if (avgDensity > 5) score += 10;

  return {
    score: Math.min(score, 100),
    totalTxAnalyzed: sigs.length,
    maxTxInSlot,
    fractionFirstSlot: Math.round(fractionFirstSlot * 100) / 100,
    avgDensity: Math.round(avgDensity * 100) / 100,
    denseClusterDetected: score >= 35,
  };
}
```

---

## Scoring Engine — Composite

**File:** `src/anti/bundle.js` (utility function)

```js
export function aggregateBundleScore(layer1, layer2, layer3) {
  const weights = [0.35, 0.40, 0.25]; // bobot per layer
  const scores = [layer1?.score || 0, layer2?.score || 0, layer3?.score || 0];
  const hasData = [!!layer1, !!layer2, !!layer3];

  // Kalau cuma 1 layer punya data, jangan percaya penuh
  const activeLayers = hasData.filter(Boolean).length;
  if (activeLayers === 0) return { bundleRisk: 0, bundleDetected: false, confidence: 'unknown' };

  // Adjust weights by active layers
  const totalWeight = hasData.reduce((sum, h, i) => sum + (h ? weights[i] : 0), 0);
  let composite = 0;
  for (let i = 0; i < 3; i++) {
    if (hasData[i]) {
      composite += (weights[i] / totalWeight) * scores[i];
    }
  }

  const confidence = activeLayers >= 2 ? 'high' : 'medium';

  return {
    bundleRisk: Math.min(Math.round(composite), 100),
    bundleDetected: composite >= 50,
    confidence,
    layerResults: { layer1, layer2, layer3 },
  };
}
```

---

## Filter Strategi Baru

Di `strategy.config_json`, tambah filter:

| Key | Type | Default | Description |
|---|---|---|---|
| `max_bundle_risk_score` | number | 100 | Max composite bundle risk (0-100). 100 = skip filter (gak peduli). |
| `max_bundle_wallet_count` | number | 20 | Max jumlah wallet di bundle. 0 = skip. |
| `max_sniper_count` | number | 15 | Max jumlah sniper dari GMGN. 0 = skip. |

Default conservative:
- `sniper`: max_bundle_risk_score=50, max_bundle_wallet_count=10, max_sniper_count=8
- `smart_money`: max_bundle_risk_score=40, max_bundle_wallet_count=8, max_sniper_count=5
- `dip_buy`: max_bundle_risk_score=60, max_bundle_wallet_count=15, max_sniper_count=10
- `degen`: max_bundle_risk_score=80, max_bundle_wallet_count=20, max_sniper_count=15

Semua bisa diubah via `/stratset <strategy>` atau `/menu → Strategy`.

---

## Field Baru di `candidate.metrics`

```js
{
  bundleDetection: {
    bundleRisk: 67,           // 0-100 composite
    bundleDetected: true,     // boolean untuk filter cepat
    confidence: 'high',       // 'high' | 'medium' | 'unknown'

    // Layer 1 — GMGN
    gmgnSnipersCount: 12,
    gmgnSnipersBalancePct: 45.5,
    gmgnBundleScore: 55,

    // Layer 2 — Signal Tx
    txWalletCount: 8,
    txDeviationCoeff: 0.12,
    txBundleScore: 65,

    // Layer 3 — Early Block Analysis
    earlyMaxTxInSlot: 11,
    earlyTxFraction: 0.55,
    earlyBundleScore: 40,
  }
}
```

---

## File Structure

```
src/anti/
├── bundle.js         ← baru: core detection logic
└── bundle.test.js    ← baru: test dengan sample tx

src/enrichment/
└── gmgn.js           ← extend: export computeBundleScoreFromGmgn()

src/pipeline/
├── candidateBuilder.js ← extend: panggil bundle detection di buildCandidate
└── orchestrator.js     ← extend: passing signature + tx ke bundle detection

src/db/
├── connection.js     ← extend (nanti): index untuk query
```

---

## RPC Cost Analysis

| Layer | RPC Calls | Frekuensi | Total per Jam (100 candidates/jam) |
|---|---|---|---|
| 1 — GMGN | 0 (data udah ada) | Tiap candidate | 0 |
| 2 — Parse tx | 0 (tx udah difetch) | Tiap candidate | 0 |
| 3 — Block analysis | 1-3 | Hanya jika score > 40 (~30%) | 30-90 |
| **Total** | **1-3** | ~30% candidate | **30-90 RPC/jam** |

RPC Helius limit: **500 req/detik** (paid plan) atau **50 req/detik** (free).
30-90 RPC/jam = < 0.03 req/detik — efeknya **negligible**.

---

## Order Implementasi

```
Step 1: GMGN score function di gmgn.js (30 menit)
Step 2: bundle.js dengan parse tx logic (1-2 jam)
Step 3: Integrasi ke candidateBuilder.js (30 menit)
Step 4: Filter strategi database migration (30 menit)
Step 5: Block analysis function (1 jam)
Step 6: Scoring aggregation (30 menit)
Step 7: Testing + tuning threshold (1-2 hari)

Total: ~2-3 hari implementasi + 1-2 hari tuning
```
