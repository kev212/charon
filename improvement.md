# CharonZero — Improvement Plan

Fork dari [yunus-0x/charon](https://github.com/yunus-0x/charon) dengan injeksi ilmu trenching dari [Ponyin.id](https://www.ponyin.id/).

---

## Overview

Charon adalah Telegram bot screening Pump.fun memecoin dengan pipeline:
```
Signal Server → Filter Strategi → Enrichment → LLM Screening → Eksekusi → Monitoring Posisi
```

CharonZero menambahkan layer **deteksi manipulasi**, **analisis on-chain**, **market cap intelligence**, dan **smart execution** di atas pipeline yang sudah ada.

**Stack:** Node.js ESM, `better-sqlite3`, `@solana/web3.js` v1, `node-telegram-bot-api`, Jupiter Ultra, GMGN API, OpenAI-compatible LLM.

---

## Current Capabilities (Charon)

| Fitur | Status |
|---|---|
| Signal server polling (`api.thecharon.xyz`) | Done |
| Multi-source overlap gating (fee+grad+trending) | Done |
| 4 strategi (sniper, dip_buy, smart_money, degen) | Done |
| Strategi hot-swappable dari Telegram | Done |
| GMGN enrichment (token info, holder, fees) | Done |
| Jupiter enrichment (asset, holders, chart, wallet PnL) | Done |
| fxtwitter narrative fetcher | Done |
| LLM batch screening (OpenAI-compatible) | Done |
| Jupiter Ultra execution (dry_run / confirm / live) | Done |
| TP / SL / Trailing / Partial TP / Max Hold | Done |
| Learning loop from dry-run PnL | Done |
| SQLite persistence, auto-resume posisi | Done |
| Saved wallet exposure tracking | Done |

---

## Gaps vs Ponyin

| Konsep Ponyin | Status di Charon |
|---|---|
| Bundle Detection | Tidak ada |
| Holder Distribution Intel | Parsial (top20%, max holder% doang) |
| Market Cap Tiers | Parsial (single min/max mcap, no tier system) |
| Multi-Wallet Execution | Tidak ada (1 private key) |
| Wallet Ping / Tracking | Minimal (hanya PnL fetch) |
| Global Fee / Volume Analysis | Parsial (fee claim SOL doang) |
| Anti-Scam (Mint/Revoke/Authority) | Minimal (bundler rate, rug ratio doang) |
| Cabal Play Detection | Tidak ada |
| Candle / Entry Confirmation | Tidak ada (LLM dilarang pakai chart) |
| Position Sizing Intelligence | Simpel (fixed size per strategy) |
| DCA / Scaling In | Tidak support |
| Multi-RPC Failover | Tidak ada |
| Websocket Graceful Reconnect | Minim |

---

## Phase 1 — Anti-Rug + On-Chain Intel

Prioritas tertinggi: mencegah rugpull, bundle trap, dan fake volume.

### 1A. Anti-Scam Checker
**File:** `src/anti/scam.js`

**Cek yang dilakukan:**
- **Mint Authority:** cek `getMint()` via `@solana/spl-token`, apakah dev masih bisa mint token baru (risiko dilusi supply)
- **Freeze Authority:** cek apakah dev bisa freeze token account user
- **Liquidity Lock / LP Burn:** cek LP token status dari Jupiter token info
- **Honeypot Simulation:** quote swap kecil via Jupiter untuk verifikasi token bisa dijual
- **Deployer History:** cek berapa coin lain yang pernah di-deploy dari wallet yang sama, berapa yang rugged
- **Social Media Validity:** cek Twitter/Telegram URL validity + account age

**Field baru di candidate:**
```js
{
  scamRisk: number,          // 0-100 composite risk score
  mintRevokeStatus: boolean, // apakah mint authority sudah direvoke
  freezeRevokeStatus: boolean,
  liquidityLocked: boolean,
  liquidityLockPct: number,
  honeypotRisk: boolean,     // gagal swap sim
  deployerRugCount: number,  // berapa kali dev ini rug
  deployerTotalCoins: number,
  socialValid: boolean,
  auditSummary: string,      // ringkasan untuk LLM
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `require_mint_revoked` | boolean | Harus mint authority sudah direvoke |
| `require_freeze_revoked` | boolean | Harus freeze authority sudah direvoke |
| `require_liquidity_locked` | boolean | LP harus dibakar/terkunci |
| `min_liquidity_lock_pct` | number | Min persentase LP terkunci |
| `max_scam_risk_score` | number | Max composite scam risk (0-100) |
| `max_deployer_rug_count` | number | Max berapa kali deployer rugged sebelumnya |

**Dependencies:** `@solana/spl-token`, Jupiter Quote API, Helius RPC.

---

### 1B. Bundle Detection
**File:** `src/anti/bundle.js`

**Deteksi:**
- Ambil transaction signature dari fee claim atau first-transfer token
- Parse instruction tree dari tx: cek berapa wallet berbeda yang beli di **block yang sama** atau **detik pertama** setelah token deploy
- Deteksi pola sniper: banyak wallet beli dengan amount seragam (rasio 0.8-1.2x antar wallet)
- Hitung **bundle supply percent**: berapa persen supply dikuasai oleh wallets di bundle

**Field baru di candidate:**
```js
{
  bundleDetected: boolean,
  bundleWalletCount: number,  // berapa wallet di bundle
  bundleSupplyPct: number,    // berapa % supply di bundle
  bundleRiskScore: number,    // 0-100
  firstBlockWalletCount: number, // wallet yang beli di block pertama
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `max_bundle_wallet_count` | number | Max jumlah wallet di bundle |
| `max_bundle_supply_pct` | number | Max % supply di bundle |
| `max_first_block_wallets` | number | Max wallet di block pertama |

**Dependencies:** Helius RPC / Solana RPC (getTransaction, getSignaturesForAddress).

---

### 1C. Global Fee & Volume Intel
**File:** `src/enrichment/fees.js`

**Analisis:**
- **Priority Fee Analysis:** dari Jupiter quote response, bandingin fee vs liquidity → fee-to-liquidity ratio
- **Organic Volume Score:** volume 24h / jumlah buy+sell tx → deteksi volume palsu (high volume, low tx count)
- **Fee Claim Authenticity:** bandingin fee claim SOL dengan volume real → anomali sinyal manipulasi

**Field baru di candidate:**
```js
{
  feeToLiquidityRatio: number,
  organicVolumeScore: number,  // 0-100, makin tinggi makin organik
  washTradingSuspected: boolean,
  priorityFeeProfile: string,  // "low" | "normal" | "high" | "suspicious"
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `max_fee_to_liquidity_ratio` | number | Max rasio fee terhadap liquidity |
| `min_organic_volume_score` | number | Min organic score (0-100) |
| `reject_wash_trading` | boolean | Auto-reject jika wash trading suspected |

---

## Phase 2 — Market Intelligence

Analisis struktur pasar dan distribusi holder.

### 2A. Market Cap Tiers
**File:** `src/pipeline/tiers.js`

**5 Tier System:**
| Tier | Range | Label | Risk Profile |
|---|---|---|---|
| Tier 1 | < $5K | Micro | Ultra-high risk, sniper entry, tiny size |
| Tier 2 | $5K – $50K | Small | High risk, early entry |
| Tier 3 | $50K – $500K | Mid | Medium risk, growth phase |
| Tier 4 | $500K – $5M | Large | Lower risk, established |
| Tier 5 | > $5M | CEX | Lowest risk, potential CEX listing |

**Tier-based overrides (per strategy):**
```js
{
  mcap_tier_sizing: {
    micro: 0.02,   // SOL
    small: 0.05,
    mid: 0.1,
    large: 0.2,
    cex: 0.5,
  },
  mcap_tier_tp: {
    micro: 100,    // %
    small: 75,
    mid: 50,
    large: 30,
    cex: 20,
  },
  mcap_tier_sl: {
    micro: -15,    // %
    small: -20,
    mid: -25,
    large: -20,
    cex: -15,
  },
}
```

**Logic:**
- Auto-detect tier dari current market cap
- Tier-specific sizing, TP, SL override strategy default
- Tier bisa di-toggle enable/disable per strategy

---

### 2B. Holder Distribution Intel
**File:** `src/enrichment/holders.js`

**Analisis baru (di atas Jupiter holders yang udah ada):**
- **Gini Coefficient / Cumulative Distribution:** hitung dari Jupiter top holders data
- **Whale Concentration Velocity:** simpan snapshot holder top 10 per 30 menit, deteksi rate of change
- **Deployer Overlap:** cek apakah deployer wallet sendiri masih hold token
- **Smart Money vs Retail Ratio:** dari Jupiter holder tags (`smartMoney`, `bot`, etc.)
- **First-Buyer Retention:** berapa % dari first 100 buyer yang masih hold

**Field baru di candidate:**
```js
{
  giniCoefficient: number,       // 0-1
  whaleDumpVelocity: number,     // % change per hour
  deployerStillHolding: boolean,
  deployerHoldPct: number,
  smartMoneyHoldPct: number,
  retailHoldPct: number,
  botHoldPct: number,
  firstBuyerRetentionPct: number,
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `max_gini_coefficient` | number | Max Gini (makin tinggi = makin terkonsentrasi) |
| `max_deployer_hold_pct` | number | Max % supply dipegang deployer |
| `max_whale_dump_velocity` | number | Max velocity whale jualan (%/jam) |
| `min_smart_money_hold_pct` | number | Min % supply dipegang smart money |
| `max_bot_hold_pct` | number | Max % supply dipegang bot |

---

### 2C. Cabal Detection
**File:** `src/anti/cabal.js`

**Database:** `cabal_addresses` table di SQLite (manual input via Telegram command).

**Deteksi:**
- Cross-reference top 20 holders dengan database alamat cabal
- Koordinasi pattern: berapa wallet cabal yang beli dalam rentang waktu yang sama
- Supply concentration oleh cabal: % total supply yang dipegang kelompok cabal

**Schema cabal_addresses:**
```sql
CREATE TABLE cabal_addresses (
  address TEXT PRIMARY KEY,
  label TEXT,
  group_name TEXT,     -- e.g. "kabal A", "indo cabal"
  risk_level TEXT,     -- "known_pumper", "suspicious", "exit_dumper"
  notes TEXT,
  added_at_ms INTEGER
);
```

**Telegram commands:**
```
/cabaladd <address> <label> <group_name> <risk_level>
/cabalremove <address>
/caballist
```

**Field baru di candidate:**
```js
{
  cabalRiskScore: number,         // 0-100
  cabalHolderCount: number,       // berapa holder di top 20 yang known cabal
  cabalSupplyPct: number,         // % supply dipegang cabal
  cabalGroups: string[],          // e.g. ["indo cabal", "whale group A"]
  cabalRiskLevel: string,         // "none" | "low" | "medium" | "high"
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `max_cabal_holder_count` | number | Max jumlah known cabal di top holders |
| `max_cabal_supply_pct` | number | Max % supply dipegang cabal |
| `max_cabal_risk_level` | string | Max risk level yang ditoleransi |

---

## Phase 3 — Execution Intelligence

Smart entry, multi-wallet, sizing, dan wallet monitoring.

### 3A. Entry Confirmation (Candle Structure)
**File:** `src/pipeline/confirmation.js`

**Berdasarkan Ponyin "3 Konfirmasi Candle":**
1. **Don't buy the first dump** — tunggu struktur pantulan
2. **Wait for higher low** — konfirmasi support terbentuk
3. **Volume confirmation** — volume harus naik saat bounce
4. **3-candle rule** — minimal 3 candle setelah dump sebelum entry

**Implementasi:**
- Pakai chart data Jupiter yang udah ada (5m candle dari `fetchJupiterChartWindow`)
- Hitung: support level, bounce confirmation, volume spike ratio
- Tambah entry mode baru: `wait_for_confirmation`

**Strategy config baru:**
```js
{
  entry_mode: 'wait_for_confirmation',  // new mode
  confirmation_candles: 3,              // min candle after dump
  confirmation_volume_ratio: 2.0,       // volume bounce / volume dump
  confirmation_retrace_pct: 30,         // min retrace dari dip
}
```

**Field di candidate:**
```js
{
  confirmationStatus: string,   // "pending" | "confirmed" | "rejected" | "not_applicable"
  confirmationCheck: {
    met: boolean,
    reason: string,
    candleCount: number,
    volumeRatio: number,
    retracePct: number,
  }
}
```

---

### 3B. Multi-Wallet Support
**File:** `src/execution/walletManager.js`

**Config (`.env`):**
```env
# Multi-wallet format: label:private_key;label2:private_key2
SOLANA_WALLETS=main:base58_key_here;alt:json_array_here;burner:base58_key_here
```

**Features:**
- Array wallet, masing-masing dengan label
- Balance tracking per wallet
- Per-wallet position limits
- Load balancing: round-robin atau least-busy
- Telegram commands: `wallets`, `wallet set <label>`, `wallet balance`

**Schema:**
```sql
-- existing dry_run_positions tambah kolom
ALTER TABLE dry_run_positions ADD COLUMN wallet_label TEXT;
```

**Telegram commands:**
```
/wallets                    -- list semua wallet + balance + active positions
/wallet set <label>         -- switch active wallet
/wallet balance             -- balance + active positions
```

---

### 3C. Wallet Ping / Tracking
**File:** `src/monitors/walletTracker.js`

**Features:**
- Subscribes to WebSocket `logsSubscribe` atau polls `getSignaturesForAddress` untuk saved wallets
- Deteksi: buy, sell, transfer besar, LP add/remove
- Kirim alert Telegram pas activity terdeteksi
- "Smart Money Score": score berdasarkan historis PnL wallet (dari Jupiter PnL API)

**Monitoring config:**
```js
{
  wallet_ping_enabled: true,
  wallet_ping_min_sol_value: 0.1,    // min value of transaction to alert
  wallet_ping_smart_money_min_pnl: 50, // min PnL % to classify as smart money
  wallet_ping_alert_cooldown_ms: 60000, // min interval between alerts per wallet
}
```

**Alert format (Telegram):**
```
[Wallet Ping] main-wallet bought $TOKEN
• Amount: 0.5 SOL
• MC at buy: $45K
• Wallet PnL: +320%
• Label: smart_money_whale
```

**Field di candidate:**
```js
{
  walletPingAlerts: number,      // jumlah saved wallet yg barusan beli
  smartMoneyActivity: boolean,   // ada smart money yang beli
  smartMoneyScore: number,       // 0-100
}
```

**Filter strategi baru:**
| Key | Type | Description |
|---|---|---|
| `min_wallet_ping_count` | number | Min saved wallets yang beli token ini |
| `require_smart_money` | boolean | Harus ada smart money activity |
| `min_smart_money_score` | number | Min smart money score |

---

### 3D. Advanced Position Sizing
**File:** `src/execution/sizing.js`

**Tiga layer sizing:**
1. **Base Size** — dari strategy `position_size_sol`
2. **Tier Adjustment** — dari Market Cap Tiers (Phase 2A)
3. **Confidence Adjustment** — `size = base * (confidence / 100)`
4. **Kelly Criterion (optional)** — dari learning loop PnL data

**Kelly Formula:**
```js
// f = (win_rate * avg_win_pct - (1 - win_rate) * |avg_loss_pct|) / avg_win_pct
// capped at 25% max risk
const kellyFraction = (winRate * avgWin - (1 - winRate) * Math.abs(avgLoss)) / avgWin;
const safeFraction = Math.min(Math.max(kellyFraction, 0.01), 0.25);
const finalSize = baseSizeSol * safeFraction * (confidence / 100);
```

**Strategy config:**
```js
{
  use_advanced_sizing: false,       // toggle on/off
  sizing_max_risk_fraction: 0.25,  // max % of bankroll per trade (Kelly cap)
  sizing_min_size_sol: 0.01,       // floor
  sizing_max_size_sol: 1.0,        // ceiling
  sizing_confidence_weight: 1.0,   // multiplier for confidence (0.5-2.0)
}
```

---

## Infrastructure Improvements

### Multi-RPC Failover
**File:** modify `src/config.js`, `src/liveExecutor.js`

**Config:**
```env
SOLANA_RPC_URLS=https://helius-rpc-1...,https://helius-rpc-2...,https://solana-mainnet...
```

**Logic:**
- Array of RPC URLs
- Health check: `getHealth()` setiap 30 detik
- Round-robin dengan auto-skip unhealthy
- Fallback ke next RPC saat timeout/error

### LLM Prompt Hardening
**File:** modify `src/pipeline/llm.js`

**Injeksi Ponyin concepts ke system prompt:**
- "Bundle tokens are not about many wallets buying — it's about one entity controlling supply through many wallets"
- "The simple 'holder < 3% is safe' rule is no longer relevant in the multi-wallet era"
- "Cabal plays are coordinated, not coincidental"
- "Wallet ping is an observation tool, not an auto-buy signal"
- "Market cap tier determines strategy — don't use new-pair tactics on mid-cap tokens"
- "Global fee helps distinguish organic volume from fake volume"
- "Mint authority = dilution risk"
- "Use chart data ONLY for ATH/range context, NOT for momentum scoring"

### Risk Database
**File:** `src/db/connection.js` (new table)

**Schema:**
```sql
CREATE TABLE risk_addresses (
  address TEXT PRIMARY KEY,
  label TEXT,
  risk_type TEXT,       -- "rug_dev", "cabal", "scammer", "drainer"
  notes TEXT,
  evidence TEXT,
  added_at_ms INTEGER,
  expires_at_ms INTEGER -- NULL = permanent
);

CREATE TABLE risk_tokens (
  mint TEXT PRIMARY KEY,
  label TEXT,
  risk_type TEXT,
  notes TEXT,
  added_at_ms INTEGER
);
```

**Telegram commands:**
```
/riskadd <address> <type> <label>
/riskremove <address>
/risklist
```

### Websocket Graceful Reconnect
**File:** modify `src/signals/feeClaim.js`

**Logic:**
- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s (max)
- Pause pipeline saat WS mati, resume setelah reconnect
- Alert Telegram setelah 3 gagal reconnect
- Re-subscribe `logsSubscribe` otomatis setelah reconnect

---

## File Structure (Final)

```
src/
├── anti/
│   ├── scam.js          # Phase 1A — Anti-scam checker
│   ├── bundle.js        # Phase 1B — Bundle detection
│   └── cabal.js         # Phase 2C — Cabal detection
├── enrichment/
│   ├── fees.js          # Phase 1C — Fee & volume intel
│   ├── gmgn.js          # existing
│   ├── holders.js       # Phase 2B — Holder distribution intel
│   ├── jupiter.js       # existing
│   ├── twitter.js       # existing
│   └── wallets.js       # existing
├── pipeline/
│   ├── candidateBuilder.js  # existing, extend
│   ├── confirmation.js      # Phase 3A — Candle confirmation
│   ├── llm.js               # existing, improve prompt
│   ├── orchestrator.js      # existing, extend
│   └── tiers.js             # Phase 2A — Market cap tiers
├── execution/
│   ├── positions.js     # existing, extend
│   ├── router.js        # existing, extend
│   ├── liveExecutor.js  # existing, extend multi-RPC
│   ├── sizing.js        # Phase 3D — Position sizing
│   └── walletManager.js # Phase 3B — Multi-wallet
├── monitors/
│   └── walletTracker.js # Phase 3C — Wallet ping
├── signals/             # existing
├── db/                  # existing, add risk tables
├── telegram/            # existing, add new commands
├── learning/            # existing
├── app.js               # existing, wire new monitors
├── config.js            # existing, add new env vars
├── utils.js             # existing
└── format.js            # existing
```

---

## Execution Order

```
Week 1-2: Phase 1 (Anti-Rug + On-Chain)
  Day 1-2: 1A (Anti-Scam)
  Day 3-4: 1B (Bundle Detection)
  Day 5:   1C (Fee & Volume Intel)
  Day 6:   Integration + testing

Week 3-4: Phase 2 (Market Intelligence)
  Day 1-2: 2A (Market Cap Tiers)
  Day 3-4: 2B (Holder Distribution)
  Day 5:   2C (Cabal Detection)
  Day 6:   Integration + testing

Week 5-6: Phase 3 + Infrastructure
  Day 1-2: 3A (Entry Confirmation)
  Day 3:   3B (Multi-Wallet)
  Day 4:   3C (Wallet Ping)
  Day 5:   3D (Position Sizing)
  Day 6:   Infrastructure (RPC failover, prompt hardening, risk DB)

Week 7: Full integration testing + dry-run
```

---

## Risk & Dependencies

| Risk | Mitigasi |
|---|---|
| Rate limiting dari Helius/Jupiter | Cache agresif, backoff, RPC failover |
| GMGN rate limit ketat (2.5s delay) | Queue serial sudah ada, maintain delay |
| Bundle detection false positive | Skoring confidence-based, bukan binary |
| Cabal DB butuh data manual | Start manual, bisa auto-populate dari pattern |
| Multi-wallet complexity | Phase 3B terakhir, optional toggle |
| Live execution risk | Dry-run dulu, confirm mode untuk testing |

### Required API Keys
- `HELIUS_API_KEY` — enhanced (for getTransaction parsing)
- `GMGN_API_KEY` — existing
- `JUPITER_API_KEY` — existing
- `SIGNAL_SERVER_KEY` — existing
- `TELEGRAM_BOT_TOKEN` — existing
- `LLM_API_KEY` — existing (MiniMax/OpenAI)

No new external API dependencies.

---

## Notes

- Semua fitur baru bersifat **opt-in via strategy config** — gak akan ngebreak existing strategy
- Pipeline tetap sama: signal → build → filter → LLM → execute → monitor
- Layer baru disisipkan sebagai enrichment + filter tambahan
- Backward compatible: strategy default Charon tetep jalan tanpa fitur baru
- Semua field baru di candidate bersifat **nullable/additive** — gak break existing schema
