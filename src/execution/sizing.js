import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function computeKellySize(winRate, avgWinPct, avgLossPct, bankrollSol) {
  if (!winRate || winRate <= 0 || avgWinPct <= 0 || avgLossPct >= 0) return null;
  const f = (winRate * avgWinPct - (1 - winRate) * Math.abs(avgLossPct)) / avgWinPct;
  const capped = Math.min(Math.max(f || 0, 0.01), 0.25);
  return Math.round(bankrollSol * capped * 100) / 100;
}

export function learningWinRate(strategyId, windowMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const closed = db.prepare(`
    SELECT pnl_percent, pnl_sol FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms > ? AND (strategy_id = ? OR ? IS NULL)
      AND pnl_percent IS NOT NULL
  `).all(cutoff, strategyId || null, strategyId || null);

  if (!closed.length) return null;

  const wins = closed.filter(p => p.pnl_percent > 0);
  const losses = closed.filter(p => p.pnl_percent <= 0);
  const winRate = wins.length / closed.length;
  const avgWin = wins.length > 0
    ? wins.reduce((s, p) => s + p.pnl_percent, 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, p) => s + p.pnl_percent, 0) / losses.length
    : 0;
  const totalPnlSol = closed.reduce((s, p) => s + (p.pnl_sol || 0), 0);

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 100) / 100,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    totalPnlSol: Math.round(totalPnlSol * 1000) / 1000,
  };
}

export async function computePositionSize(strat, candidate, bankrollSol) {
  const baseSize = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);

  // Market cap tier adjustment
  const tier = candidate?.metrics?.mcapTier;
  const tierSizing = strat.mcap_tier_sizing || {};
  const tierSizes = { micro: 0.02, small: 0.05, mid: 0.1, large: 0.2, cex: 0.5 };
  const tierAdjusted = tier && tierSizing[tier] != null ? Number(tierSizing[tier]) : tierSizes[tier] || baseSize;

  // Confidence adjustment
  const confidence = candidate?.confidence ?? 50;
  const confAdjusted = strat.use_advanced_sizing
    ? tierAdjusted * (confidence / 100)
    : tierAdjusted;

  // Kelly adjustment
  let kellyAdjusted = confAdjusted;
  if (strat.use_advanced_sizing && bankrollSol > 0 && strat.sizing_use_kelly) {
    const history = learningWinRate(strat.id);
    if (history && history.winRate > 0 && history.totalTrades >= 10) {
      const kellySize = computeKellySize(
        history.winRate,
        history.avgWinPct / 100,
        Math.abs(history.avgLossPct) / 100,
        bankrollSol
      );
      if (kellySize && kellySize > 0) {
        kellyAdjusted = Math.min(confAdjusted, kellySize);
      }
    }
  }

  const minSize = strat.sizing_min_size_sol ?? 0.01;
  const maxSize = strat.sizing_max_size_sol ?? 1.0;
  return Math.min(Math.max(kellyAdjusted, minSize), maxSize);
}

export function selectWallet(walletManager, strat) {
  if (!walletManager?.wallets?.length) return null;
  if (walletManager.wallets.length === 1) return walletManager.wallets[0];

  const method = strat.wallet_selection ?? 'round_robin';
  if (method === 'least_busy') {
    const sorted = [...walletManager.wallets].sort((a, b) => a.openPositions - b.openPositions);
    return sorted[0];
  }
  const idx = (walletManager.currentIndex || 0) % walletManager.wallets.length;
  walletManager.currentIndex = idx + 1;
  return walletManager.wallets[idx];
}
