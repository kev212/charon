import { firstPositiveNumber } from '../utils.js';
import { fetchJupiterChartWindow } from '../enrichment/jupiter.js';

export function analyzeCandleStructure(chartData) {
  if (!chartData?.windows?.length) return null;

  const candle5m = chartData.windows.find(w =>
    (w.label === 'ath_context_24h_5m' || w.label === 'recent_24h_5m') && w.available
  );
  if (!candle5m || !candle5m.candles?.length) return null;

  const candles = candle5m.candles;
  if (candles.length < 5) return null;

  // Find the lowest point in the window
  const sorted = [...candles].sort((a, b) => (a.low || 0) - (b.low || 0));
  const lowestCandle = sorted[0];
  const lowestPrice = lowestCandle.low || 0;
  if (lowestPrice <= 0) return null;

  // Find where the lowest candle is in sequence
  const lowestIdx = candles.indexOf(lowestCandle);
  const candlesAfterLow = candles.slice(lowestIdx + 1);

  if (candlesAfterLow.length < 3) return null;

  // 3-candle confirmation: check if price has bounced from low for 3 consecutive candles
  const firstAfter = candlesAfterLow[0];
  const secondAfter = candlesAfterLow[1];
  const thirdAfter = candlesAfterLow[2];

  const firstClose = Number(firstAfter.close || firstAfter.price || 0);
  const secondClose = Number(secondAfter.close || secondAfter.price || 0);
  const thirdClose = Number(thirdAfter.close || thirdAfter.price || 0);

  const currentPrice = firstPositiveNumber(
    chartData.currentNative,
    candle5m.current,
    candles[candles.length - 1]?.close,
  );

  if (!currentPrice) return null;

  const confirmed3Candle = (
    firstClose > lowestPrice &&
    secondClose > firstClose &&
    thirdClose > secondClose
  );

  const firstBouncePct = lowestPrice > 0 ? ((firstClose - lowestPrice) / lowestPrice) * 100 : 0;
  const totalBouncePct = lowestPrice > 0 ? ((currentPrice - lowestPrice) / lowestPrice) * 100 : 0;

  // Volume surge detection
  let volumeSurge = false;
  const avgVolume = candles.reduce((s, c) => s + Number(c.volume || 0), 0) / Math.max(candles.length, 1);
  const recentAvgVolume = candlesAfterLow.slice(0, 3).reduce((s, c) => s + Number(c.volume || 0), 0) / 3;
  if (avgVolume > 0 && recentAvgVolume > avgVolume * 1.5) {
    volumeSurge = true;
  }

  const confirmed = confirmed3Candle && volumeSurge;
  const supportBounce = firstBouncePct > 0 && firstBouncePct < 30;
  const lateEntry = totalBouncePct > 50;

  return {
    confirmed,
    supportBounce,
    lateEntry,
    volumeSurge,
    totalBouncePct: Math.round(totalBouncePct * 100) / 100,
    firstBouncePct: Math.round(firstBouncePct * 100) / 100,
    candlesAfterLow: candlesAfterLow.length,
    lowestPrice,
    currentPrice,
    reason: confirmed
      ? '3-candle + volume confirmation'
      : lateEntry
        ? `bounce ${totalBouncePct.toFixed(0)}% from low — late entry risk`
        : confirmed3Candle
          ? '3-candle up but volume weak'
          : 'insufficient candle structure for entry',
  };
}

export function checkEntryConfirmation(candidate, strat) {
  const mode = strat.entry_confirmation_mode ?? 'disabled';
  if (mode === 'disabled') return { required: false, passed: true, reason: 'not_required' };

  const chart = analyzeCandleStructure(candidate.chart);
  if (!chart) return { required: true, passed: false, reason: 'insufficient_chart_data' };

  if (mode === 'strict') {
    const passed = chart.confirmed;
    return { required: true, passed, reason: passed ? chart.reason : `strict fail: ${chart.reason}` };
  }

  if (mode === 'relaxed') {
    const passed = chart.supportBounce && !chart.lateEntry;
    return { required: true, passed, reason: passed ? chart.reason : `relaxed fail: ${chart.reason}` };
  }

  return { required: false, passed: true, reason: 'unknown_mode' };
}
