import { firstPositiveNumber } from '../utils.js';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';

const whaleCache = new Map();
const WHALE_CACHE_TTL = 30 * 60 * 1000;

export function computeGiniCoefficient(holders) {
  if (!holders?.holders?.length) return null;

  const top20 = holders.holders.slice(0, 20);
  if (top20.length < 3) return null;

  const percents = top20.map(h => Number(h.percent || 0)).filter(p => p > 0);
  if (percents.length < 3) return null;

  // Normalize to sum to 100 for the top sample
  const total = percents.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const normalized = percents.map(p => p / total);
  normalized.sort((a, b) => a - b);

  const n = normalized.length;
  const cumulative = [];
  let sum = 0;
  for (const v of normalized) {
    sum += v;
    cumulative.push(sum);
  }
  const cumulativeSum = cumulative.reduce((a, b) => a + b, 0);
  const gini = (2 * cumulativeSum - sum) / (2 * n * (sum / n)) - 1 / n;
  const adjusted = (n / (n - 1)) * gini;

  return Math.min(Math.max(Math.round(adjusted * 1000) / 1000, 0), 1);
}

export function computeWhaleVelocity(holders, cachedData) {
  const currentTop = holders?.holders?.slice(0, 10).map(h => ({
    address: h.address,
    percent: Number(h.percent || 0),
  }));
  if (!currentTop?.length) return null;

  const key = 'whale_snapshot';
  const snapshot = cachedData?.get?.(key);
  if (!snapshot) return { velocity: 0, trend: 'stable', firstObservation: true };

  const totalDelta = currentTop.reduce((sum, curr) => {
    const prev = snapshot.find(s => s.address === curr.address);
    return prev ? sum + (curr.percent - prev.percent) : sum;
  }, 0);

  const absDelta = currentTop.reduce((sum, curr) => {
    const prev = snapshot.find(s => s.address === curr.address);
    return prev ? sum + Math.abs(curr.percent - prev.percent) : sum;
  }, 0);

  let trend = 'stable';
  if (totalDelta < -5) trend = 'dumping';
  else if (totalDelta > 5) trend = 'accumulating';
  else if (absDelta > 10) trend = 'churning';

  return {
    velocity: Math.round(totalDelta * 100) / 100,
    absDelta: Math.round(absDelta * 100) / 100,
    trend,
    sampleSize: currentTop.length,
  };
}

export function classifySmartMoneyRatio(holders) {
  if (!holders?.holders?.length) return null;

  const tagged = holders.holders.filter(h => h.tags || h.label);
  const smartMoney = tagged.filter(h => {
    const tags = [h.tags, h.label].filter(Boolean).join(' ').toLowerCase();
    return tags.includes('smart') || tags.includes('whale') || tags.includes('insider') || tags.includes('kols');
  });
  const bots = tagged.filter(h => {
    const tags = [h.tags, h.label].filter(Boolean).join(' ').toLowerCase();
    return tags.includes('bot') || tags.includes('mev');
  });
  const top20 = holders.holders.slice(0, 20);

  const smartMoneyPct = smartMoney.reduce((s, h) => s + Number(h.percent || 0), 0);
  const botPct = bots.reduce((s, h) => s + Number(h.percent || 0), 0);
  const top20Pct = top20.reduce((s, h) => s + Number(h.percent || 0), 0);
  const retailPct = Math.max(0, top20Pct - smartMoneyPct - botPct);

  return {
    smartMoneyPct: Math.round(smartMoneyPct * 100) / 100,
    botPct: Math.round(botPct * 100) / 100,
    retailPct: Math.round(retailPct * 100) / 100,
    smartMoneyCount: smartMoney.length,
    botCount: bots.length,
  };
}

export function computeFirstBuyerRetention(holders) {
  if (!holders?.holders?.length) return null;
  const all = holders.holders;
  const first100 = all.slice(0, 100);
  const stillHolding = first100.filter(h => Number(h.percent || 0) > 0);
  return {
    totalFirst100: first100.length,
    stillHolding: stillHolding.length,
    retentionPct: first100.length > 0 ? Math.round((stillHolding.length / first100.length) * 100) : 0,
  };
}

export function computeHolderSummary(holders) {
  if (!holders?.holders?.length) return null;

  return {
    giniCoefficient: computeGiniCoefficient(holders),
    whaleVelocity: null,
    whaleTrend: 'unknown',
    smartMoneyPct: null,
    botPct: null,
    retailPct: null,
    firstBuyerRetentionPct: null,
  };
}
