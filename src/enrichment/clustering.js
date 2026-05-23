import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const clusterCache = new Map();
const CLUSTER_CACHE_TTL = 10 * 60 * 1000;

async function rpcCall(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json?.result;
}

async function getFirstFundingTx(wallet) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [wallet, { limit: 3, commitment: 'confirmed' }]);
    if (!sigs || sigs.length === 0) return null;
    const firstSig = sigs[sigs.length - 1]?.signature;
    if (!firstSig) return null;
    const tx = await rpcCall('getTransaction', [firstSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!tx?.meta) return null;
    const accountKeys = tx.transaction?.message?.accountKeys || tx.transaction?.message?.accounts || [];
    const preBalances = tx.meta.preBalances || [];
    const postBalances = tx.meta.postBalances || [];
    const walletIdx = accountKeys.findIndex(k => k === wallet || k.pubkey === wallet);
    if (walletIdx < 0) return null;
    const sentToWallet = (preBalances[walletIdx] || 0) < (postBalances[walletIdx] || 0);
    if (!sentToWallet) return null;
    const funderIdx = accountKeys.findIndex((k, i) => {
      if (i === walletIdx) return false;
      const pre = preBalances[i] || 0;
      const post = postBalances[i] || 0;
      return pre > post && (pre - post) >= (postBalances[walletIdx] - preBalances[walletIdx]);
    });
    if (funderIdx < 0) {
      const writable = accountKeys.slice(0, tx.transaction?.message?.header?.numRequiredSignatures || 1);
      const feePayer = writable[0];
      return typeof feePayer === 'string' ? feePayer : feePayer?.pubkey || null;
    }
    const funder = accountKeys[funderIdx];
    return typeof funder === 'string' ? funder : funder?.pubkey || null;
  } catch {
    return null;
  }
}

async function funderForWallet(wallet) {
  try {
    return await getFirstFundingTx(wallet);
  } catch {
    return null;
  }
}

export async function computeClusterScore(holders) {
  if (!holders?.holders || holders.holders.length === 0) return null;
  const cached = clusterCache.get('holders');
  if (cached && now() - cached.at < CLUSTER_CACHE_TTL) return cached.data;

  const topN = holders.holders.slice(0, 10);
  const funders = await Promise.all(topN.map(h => funderForWallet(h.address).then(f => ({ ...h, funder: f }))));
  const clustered = {};
  for (const item of funders) {
    if (!item.funder) continue;
    if (!clustered[item.funder]) clustered[item.funder] = { funder: item.funder, wallets: [], totalPercent: 0 };
    clustered[item.funder].wallets.push(item.address);
    clustered[item.funder].totalPercent += item.percent || 0;
  }
  const clusterEntries = Object.values(clustered).filter(c => c.wallets.length > 1);
  const singleWalletClusters = Object.values(clustered).filter(c => c.wallets.length === 1);
  const clusterCount = clusterEntries.length;
  const topClusterPercent = clusterEntries.length > 0
    ? Math.max(...clusterEntries.map(c => c.totalPercent))
    : (holders.maxHolderPercent || 0);
  const clusteredTop20Percent = clusterEntries.reduce((sum, c) => sum + c.totalPercent, 0)
    + singleWalletClusters.reduce((sum, c) => sum + c.totalPercent, 0);
  const rawTop20Percent = holders.top20Percent || 0;
  const effectiveConcentrationRisk = clusteredTop20Percent > 80 ? 'high'
    : clusteredTop20Percent > 60 ? 'medium'
    : 'low';

  const result = {
    clusterCount,
    topClusterPercent: Math.round(topClusterPercent * 100) / 100,
    rawTop20Percent: Math.round(rawTop20Percent * 100) / 100,
    clusteredTop20Percent: Math.round(clusteredTop20Percent * 100) / 100,
    effectiveConcentrationRisk,
    clusters: clusterEntries.map(c => ({
      funder: c.funder,
      walletCount: c.wallets.length,
      totalPercent: Math.round(c.totalPercent * 100) / 100,
    })),
    warnings: [],
  };

  if (clusterCount > 0 && topClusterPercent > 20) {
    result.warnings.push(`${clusterCount} cluster(s) found; top cluster controls ${topClusterPercent.toFixed(1)}% of supply`);
  }
  if (clusteredTop20Percent > rawTop20Percent * 1.5) {
    result.warnings.push('effective concentration significantly higher than raw holder data suggests');
  }

  clusterCache.set('holders', { at: now(), data: result });
  return result;
}

export async function analyzeHolderClusters(holders) {
  return computeClusterScore(holders);
}
