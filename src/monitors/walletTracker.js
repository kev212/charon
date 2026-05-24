import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';
import { db } from '../db/connection.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';

const alertCooldowns = new Map();
const smartMoneyCache = new Map();

async function rpcCall(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json?.result;
}

export async function getRecentWalletActivity(address, limit = 10) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
    if (!sigs?.length) return [];

    const activities = [];
    for (const sig of sigs.slice(0, 5)) {
      const tx = await rpcCall('getTransaction', [sig.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }]);
      if (!tx?.meta) continue;

      const solDelta = tx.meta.postBalances[0] - tx.meta.preBalances[0];
      const tokenChanges = (tx.meta.postTokenBalances || [])
        .map(pt => {
          const pre = tx.meta.preTokenBalances?.find(p => p.mint === pt.mint && p.owner === pt.owner);
          const preAmt = Number(pre?.uiTokenAmount?.amount || 0);
          const postAmt = Number(pt.uiTokenAmount?.amount || 0);
          return { mint: pt.mint, delta: postAmt - preAmt };
        })
        .filter(t => t.delta !== 0);

      activities.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime,
        solDelta,
        tokenChanges,
        type: solDelta > 0 ? 'received_sol' : solDelta < 0 ? 'sent_sol' : tokenChanges.length > 0 ? 'token_trade' : 'other',
      });
    }
    return activities;
  } catch {
    return [];
  }
}

export async function getSmartMoneyScore(address) {
  const cached = smartMoneyCache.get(address);
  if (cached && now() - cached.at < 10 * 60 * 1000) return cached.data;

  const pnl = await fetchWalletPnl(address);
  if (!pnl) return null;

  let score = 0;
  if (pnl.totalTrades >= 50) score += 20;
  else if (pnl.totalTrades >= 10) score += 10;
  if (pnl.winRate >= 0.6) score += 25;
  else if (pnl.winRate >= 0.4) score += 10;
  if (pnl.totalPnlPercent > 200) score += 30;
  else if (pnl.totalPnlPercent > 50) score += 15;
  else if (pnl.totalPnlPercent > 0) score += 5;

  const result = {
    score: Math.min(score, 100),
    isSmartMoney: score >= 50,
    totalTrades: pnl.totalTrades,
    winRate: pnl.winRate,
    totalPnlPercent: pnl.totalPnlPercent,
    level: score >= 70 ? 'elite' : score >= 50 ? 'experienced' : score >= 25 ? 'developing' : 'novice',
  };
  smartMoneyCache.set(address, { at: now(), data: result });
  return result;
}

export function checkAlertCooldown(address, mint, cooldownMs = 60000) {
  const key = `${address}:${mint}`;
  const last = alertCooldowns.get(key);
  if (last && now() - last < cooldownMs) return false;
  alertCooldowns.set(key, now());
  return true;
}

export async function monitorSavedWallets() {
  const wallets = db.prepare('SELECT * FROM saved_wallets').all();
  if (!wallets.length) return [];

  const alerts = [];
  for (const wallet of wallets) {
    try {
      const activities = await getRecentWalletActivity(wallet.address, 5);
      for (const act of activities) {
        if (!act.blockTime || (now() / 1000) - act.blockTime > 300) continue;
        if (!checkAlertCooldown(wallet.address, act.signature)) continue;

        const smartMoney = await getSmartMoneyScore(wallet.address);
        alerts.push({
          wallet: wallet.label,
          address: wallet.address,
          activity: act,
          smartMoney,
          detectedAtMs: now(),
        });
      }
    } catch {
      continue;
    }
  }
  return alerts;
}
