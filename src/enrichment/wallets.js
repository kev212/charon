import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';

export function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

export async function fetchSavedWalletExposure(mint, holders) {
  const wallets = savedWallets();
  if (!wallets.length || !holders?.holders?.length) {
    return { holderCount: 0, checked: wallets.length, wallets: [] };
  }
  const holderSet = new Set(holders.holders.map(h => h.address));
  const matched = wallets.filter(wallet => holderSet.has(wallet.address));
  return {
    holderCount: matched.length,
    checked: wallets.length,
    wallets: matched.map(w => w.label),
  };
}

export function knownCabalClusters() {
  return db.prepare('SELECT * FROM cabal_clusters ORDER BY last_active_ms DESC').all();
}

export function logCabalEvent(candidateId, mint, clusterId, kind, details) {
  db.prepare(`
    INSERT INTO cabal_events (candidate_id, mint, cluster_id, kind, details_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId || null, mint, clusterId || null, kind, JSON.stringify(details), now());
}

export async function detectCabalActivity(mint, holders) {
  if (!holders?.holders?.length) return { isCabalActive: false, cabalClusters: [], totalSupplyControlled: 0 };

  const clusters = knownCabalClusters();
  const topHolders = holders.holders.slice(0, 20);
  const holderAddresses = new Set(topHolders.map(h => h.address));
  const matchedClusters = [];
  let totalControlled = 0;

  for (const cluster of clusters) {
    const wallets = JSON.parse(cluster.cluster_json || '[]');
    const matched = wallets.filter(w => holderAddresses.has(w));
    if (matched.length > 0) {
      const supplyPct = topHolders
        .filter(h => matched.includes(h.address))
        .reduce((sum, h) => sum + Number(h.percent || 0), 0);
      matchedClusters.push({
        clusterId: cluster.id,
        label: cluster.label,
        matchedWallets: matched.length,
        totalWallets: wallets.length,
        supplyPercent: supplyPct,
      });
      totalControlled += supplyPct;
      db.prepare('UPDATE cabal_clusters SET last_active_ms = ?, total_tokens_tracked = total_tokens_tracked + 1 WHERE id = ?')
        .run(now(), cluster.id);
    }
  }

  return {
    isCabalActive: matchedClusters.length > 0,
    cabalClusters: matchedClusters,
    totalSupplyControlled: totalControlled,
    checkedClusters: clusters.length,
  };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
