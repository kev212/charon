import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const bundleCache = new Map();
const BUNDLE_CACHE_TTL = 10 * 60 * 1000;

async function rpcCall(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json?.result;
}

function parseTransferAccounts(tx) {
  if (!tx?.meta?.innerInstructions?.length) return [];
  const wallets = [];
  for (const ixGroup of tx.meta.innerInstructions) {
    for (const ix of ixGroup.instructions) {
      if (!ix.parsed || ix.parsed.type !== 'transferChecked') continue;
      const info = ix.parsed.info;
      if (info.mint && info.destination) {
        wallets.push({
          mint: info.mint,
          source: info.source,
          destination: info.destination,
          amount: Number(info.tokenAmount?.amount || 0),
          decimals: info.tokenAmount?.decimals || 0,
        });
      }
    }
  }
  return wallets;
}

function computeTxBundleScore(mint, wallets, knownPrograms) {
  const buys = wallets
    .filter(w => w.mint === mint && !knownPrograms.has(w.destination))
    .reduce((acc, w) => {
      if (!acc.has(w.destination)) acc.set(w.destination, []);
      acc.get(w.destination).push(w.amount);
      return acc;
    }, new Map());

  if (buys.size < 2) return null;

  const amounts = Array.from(buys.values()).map(v => v[0]);
  const walletCount = buys.size;

  // If amounts are missing (0), likely not fresh buys
  if (amounts.every(a => a === 0)) return null;

  const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const stdDev = Math.sqrt(amounts.reduce((sum, a) => sum + (a - avgAmount) ** 2, 0) / amounts.length);
  const deviationCoeff = avgAmount > 0 ? stdDev / avgAmount : 1;

  let score = 0;
  if (walletCount >= 10) score += 35;
  else if (walletCount >= 5) score += 20;
  else if (walletCount >= 3) score += 10;

  if (deviationCoeff < 0.15) score += 30;
  else if (deviationCoeff < 0.3) score += 15;

  return {
    walletCount,
    avgAmount,
    deviationCoeff: Math.round(deviationCoeff * 100) / 100,
    score: Math.min(score, 100),
    bundleDetected: score >= 50,
  };
}

export async function detectBundleFromTx(signature, mint) {
  if (!signature) return null;

  const cached = bundleCache.get(signature);
  if (cached && now() - cached.at < BUNDLE_CACHE_TTL) return cached.data;

  try {
    const tx = await rpcCall('getTransaction', [signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }]);
    if (!tx) return null;

    const knownPrograms = new Set([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '11111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
    ]);

    const wallets = parseTransferAccounts(tx);
    const result = computeTxBundleScore(mint, wallets, knownPrograms);
    bundleCache.set(signature, { at: now(), data: result });
    return result;
  } catch (err) {
    console.log(`[bundle] tx parse ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

export async function analyzeEarlyBlockDensity(mint, minTokens = 0) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [mint, { limit: 30, commitment: 'confirmed' }]);
    if (!sigs?.length || (minTokens > 0 && sigs.length < minTokens)) return null;

    const slotGroups = new Map();
    for (const sig of sigs) {
      slotGroups.set(sig.slot, (slotGroups.get(sig.slot) || 0) + 1);
    }

    const maxTxInSlot = Math.max(...slotGroups.values(), 0);
    const slotCount = slotGroups.size;
    const avgDensity = sigs.length / Math.max(slotCount, 1);
    const firstSlotTxCount = slotGroups.get(sigs[0]?.slot) || 0;
    const fractionFirstSlot = sigs.length > 0 ? firstSlotTxCount / sigs.length : 0;

    let score = 0;
    if (maxTxInSlot > 15) score += 20;
    else if (maxTxInSlot > 8) score += 12;
    else if (maxTxInSlot > 4) score += 6;
    if (fractionFirstSlot > 0.5) score += 15;
    else if (fractionFirstSlot > 0.3) score += 8;
    if (avgDensity > 5) score += 10;

    return {
      totalTx: sigs.length,
      slotCount,
      maxTxInSlot,
      fractionFirstSlot: Math.round(fractionFirstSlot * 100) / 100,
      avgDensity: Math.round(avgDensity * 100) / 100,
      score: Math.min(score, 100),
      denseClusterDetected: score >= 35,
    };
  } catch (err) {
    console.log(`[bundle] early block ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

export function aggregateBundleRisk(layers) {
  const { txAnalysis, earlyBlock, gmgnScore } = layers;
  const hasTx = !!txAnalysis;
  const hasEarly = !!earlyBlock;
  const hasGmgn = !!gmgnScore;
  const active = [hasTx, hasEarly, hasGmgn].filter(Boolean).length;

  if (active === 0) return { bundleRisk: 0, bundleDetected: false, confidence: 'unknown', layerCount: 0 };

  const weights = [0.4, 0.25, 0.35];
  const scores = [
    txAnalysis?.score || 0,
    earlyBlock?.score || 0,
    gmgnScore?.score || 0,
  ];
  const enabled = [hasTx, hasEarly, hasGmgn];
  const totalWeight = enabled.reduce((s, e, i) => s + (e ? weights[i] : 0), 0);

  let composite = 0;
  for (let i = 0; i < 3; i++) {
    if (enabled[i]) composite += (weights[i] / totalWeight) * scores[i];
  }

  return {
    bundleRisk: Math.min(Math.round(composite), 100),
    bundleDetected: composite >= 50,
    confidence: active >= 2 ? 'high' : 'medium',
    layerCount: active,
    layers,
  };
}
