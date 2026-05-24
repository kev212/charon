import { firstPositiveNumber } from '../utils.js';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';

export function computeOrganicVolume(gmgn, jupiterAsset, trending) {
  const volume24h = firstPositiveNumber(
    gmgn?.volume,
    jupiterAsset?.volume,
    trending?.volume
  ) || 0;

  const buyCount = Number(gmgn?.buy_count ?? jupiterAsset?.buyCount ?? 0);
  const sellCount = Number(gmgn?.sell_count ?? jupiterAsset?.sellCount ?? 0);
  const totalTx = buyCount + sellCount;

  if (volume24h <= 0 || totalTx <= 0) {
    return {
      organicScore: null,
      avgTxSizeUsd: 0,
      volumeToTxRatio: 0,
      washTradingSuspected: false,
    };
  }

  const avgTxSizeUsd = volume24h / totalTx;
  const volumeToTxRatio = avgTxSizeUsd > 0 ? volume24h / avgTxSizeUsd : 0;

  // Wash trading heuristics:
  // High volume but very low tx count → likely fake (single entity trading with itself)
  // Very high avg tx size (e.g. > $10k per tx on a microcap) → suspicious
  // Dust trades (avg < $1) → wash farming
  let suspected = false;
  let reasons = [];

  if (totalTx < 20 && volume24h > 50000) {
    suspected = true;
    reasons.push('high volume with low tx count');
  }
  if (avgTxSizeUsd > 10000 && volume24h > 100000) {
    suspected = true;
    reasons.push('avg tx size unusually high');
  }
  if (avgTxSizeUsd < 1 && totalTx > 500) {
    suspected = true;
    reasons.push('dust trades; likely wash farming');
  }

  // Organic score 0-100
  let organicScore = 100;
  if (totalTx < 10) organicScore -= 20;
  if (totalTx < 50 && volume24h > 100000) organicScore -= 30;
  if (avgTxSizeUsd > 5000) organicScore -= 15;
  if (buyCount > 0 && sellCount > 0) {
    const ratio = Math.max(buyCount, sellCount) / Math.min(buyCount, sellCount);
    if (ratio > 10) organicScore -= 25;
  }
  organicScore = Math.max(0, Math.min(100, organicScore));

  return {
    organicScore,
    volume24h,
    buyCount,
    sellCount,
    avgTxSizeUsd: Math.round(avgTxSizeUsd * 100) / 100,
    volumeToTxRatio: Math.round(volumeToTxRatio * 100) / 100,
    washTradingSuspected: suspected,
    washReasons: reasons,
  };
}

export function computeFeeToLiquidityRatio(gmgnFeesSol, solPrice, liquidityUsd) {
  if (!gmgnFeesSol || gmgnFeesSol <= 0 || !liquidityUsd || liquidityUsd <= 0) return null;
  const feesUsd = gmgnFeesSol * (solPrice || 200);
  return Math.round((feesUsd / liquidityUsd) * 10000) / 10000;
}

export async function estimatePriorityFeeProfile(mint) {
  try {
    const res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getRecentPrioritizationFees',
        params: [[mint]],
      }),
    });
    const json = await res.json();
    const fees = json?.result;
    if (!fees?.length) return null;

    const avgFee = fees.reduce((s, f) => s + f.prioritizationFee, 0) / fees.length;
    const maxFee = Math.max(...fees.map(f => f.prioritizationFee));

    let profile = 'normal';
    if (maxFee > 100000) profile = 'extreme';
    else if (maxFee > 10000) profile = 'high';
    else if (avgFee < 100) profile = 'low';

    return {
      avgPriorityFee: avgFee,
      maxPriorityFee: maxFee,
      sampleCount: fees.length,
      profile,
      gasWarDetected: maxFee > 50000,
    };
  } catch (err) {
    return null;
  }
}
