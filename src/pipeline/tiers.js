import { firstPositiveNumber } from '../utils.js';

export function classifyMcapTier(mcapUsd) {
  if (!Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  if (mcapUsd < 5_000) return 'micro';
  if (mcapUsd < 50_000) return 'small';
  if (mcapUsd < 500_000) return 'mid';
  if (mcapUsd < 5_000_000) return 'large';
  return 'cex';
}

export const TIER_LABELS = {
  micro: 'Micro (<$5k)',
  small: 'Small ($5k-$50k)',
  mid: 'Mid ($50k-$500k)',
  large: 'Large ($500k-$5M)',
  cex: 'CEX ($5M+)',
};

export const TIER_ORDER = ['micro', 'small', 'mid', 'large', 'cex'];

export function tierSizingFromStrategy(strat) {
  const defaults = {
    micro: 0.02,
    small: 0.05,
    mid: 0.1,
    large: 0.2,
    cex: 0.5,
  };
  const overrides = strat.mcap_tier_sizing || {};
  const sizing = {};
  for (const tier of TIER_ORDER) {
    sizing[tier] = Number(overrides[tier]) || defaults[tier];
  }
  return sizing;
}

export function tierTpFromStrategy(strat) {
  const defaults = {
    micro: 100,
    small: 75,
    mid: 50,
    large: 30,
    cex: 20,
  };
  const overrides = strat.mcap_tier_tp || {};
  const tp = {};
  for (const tier of TIER_ORDER) {
    tp[tier] = Number(overrides[tier]) || defaults[tier];
  }
  return tp;
}

export function tierSlFromStrategy(strat) {
  const defaults = {
    micro: -15,
    small: -20,
    mid: -25,
    large: -20,
    cex: -15,
  };
  const overrides = strat.mcap_tier_sl || {};
  const sl = {};
  for (const tier of TIER_ORDER) {
    sl[tier] = Number(overrides[tier]) || defaults[tier];
  }
  return sl;
}

export function resolveTierOverride(strat, mcapTier) {
  if (!mcapTier) return { sizeSol: strat.position_size_sol, tpPct: strat.tp_percent, slPct: strat.sl_percent };
  const enable = strat.mcap_tier_enabled;
  if (enable === false) return { sizeSol: strat.position_size_sol, tpPct: strat.tp_percent, slPct: strat.sl_percent };

  const sizing = tierSizingFromStrategy(strat);
  const tp = tierTpFromStrategy(strat);
  const sl = tierSlFromStrategy(strat);

  return {
    sizeSol: sizing[mcapTier] || strat.position_size_sol,
    tpPct: tp[mcapTier] != null ? tp[mcapTier] : strat.tp_percent,
    slPct: sl[mcapTier] != null ? sl[mcapTier] : strat.sl_percent,
  };
}
