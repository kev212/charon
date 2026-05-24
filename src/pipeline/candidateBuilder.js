import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol, classifyMcapTier } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo, computeBundleScoreFromGmgn } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchSolUsdPrice, extractListingEvents } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure, detectCabalActivity } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { fetchTokenAuth } from '../enrichment/tokenAuth.js';
import { computeClusterScore } from '../enrichment/clustering.js';
import { computeOrganicVolume, computeFeeToLiquidityRatio } from '../enrichment/fees.js';
import { detectBundleFromTx, analyzeEarlyBlockDensity, aggregateBundleRisk } from '../anti/bundle.js';
import { detectHoneypot, validateSocialMedia, computeCompositeScamRisk } from '../anti/scam.js';
import { gmgnLink } from '../format.js';

let solPriceCache = { price: null, at: 0 };

async function cachedSolPrice() {
  if (solPriceCache.price && now() - solPriceCache.at < 60_000) return solPriceCache.price;
  const price = await fetchSolUsdPrice();
  if (price > 0) {
    solPriceCache = { price, at: now() };
    return price;
  }
  return solPriceCache.price || 200;
}

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Token authority checks (mint/freeze)
  if (candidate.tokenAuth) {
    if (strat.reject_mint_active && candidate.tokenAuth.mintActive) {
      failures.push(`mint authority active: ${candidate.tokenAuth.mintAuthority}`);
    }
    if (strat.reject_freeze_active && candidate.tokenAuth.freezeActive) {
      failures.push(`freeze authority active: ${candidate.tokenAuth.freezeAuthority}`);
    }
  }

  // Global fee-to-volume ratio (wash trading detection)
  const ratio = candidate.metrics.gmgnFeeToVolumeRatio;
  const minRatio = strat.min_gmgn_fee_volume_ratio ?? 0;
  if (minRatio > 0 && ratio !== null && ratio < minRatio) {
    failures.push(`fee/volume ratio: ${(ratio * 100).toFixed(3)}% < ${(minRatio * 100).toFixed(3)}%`);
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }
  if (strat.reject_cex_listed && candidate.metrics.mcapTier === 'cex_listed') {
    failures.push('market cap tier: cex_listed — institutional players, high risk');
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Cabal activity detection
  if (candidate.cabalActivity?.isCabalActive && strat.reject_known_cabal) {
    failures.push(`known cabal cluster(s) active: ${candidate.cabalActivity.cabalClusters.map(c => c.label).join(', ')}`);
  }

  // Cluster analysis (bundle / multi-wallet detection)
  if (candidate.clusterAnalysis) {
    const ca = candidate.clusterAnalysis;
    if (strat.max_bundle_cluster_score > 0 && ca.clusterCount > 0 && ca.topClusterPercent > strat.max_bundle_cluster_score) {
      failures.push(`bundle cluster: ${ca.topClusterPercent.toFixed(1)}% > ${strat.max_bundle_cluster_score}%`);
    }
    if (strat.max_clustered_top20_percent < 100 && ca.clusteredTop20Percent > strat.max_clustered_top20_percent) {
      failures.push(`clustered concentration: ${ca.clusteredTop20Percent.toFixed(1)}% > ${strat.max_clustered_top20_percent}%`);
    }
    if (strat.reject_high_cluster_risk && ca.effectiveConcentrationRisk === 'high') {
      failures.push('high cluster concentration risk');
    }
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // Organic volume / wash trading
  if (candidate.organicVolume) {
    const ov = candidate.organicVolume;
    if (strat.reject_wash_trading && ov.washTradingSuspected) {
      failures.push(`wash trading suspected: ${ov.washReasons.join(', ')}`);
    }
    if (strat.min_organic_volume_score > 0 && ov.organicScore != null && ov.organicScore < strat.min_organic_volume_score) {
      failures.push(`organic volume: ${ov.organicScore} < ${strat.min_organic_volume_score}`);
    }
  }

  // Bundle risk (composite from tx + gmgn + early block)
  if (candidate.metrics?.bundleDetected && strat.reject_bundle_detected) {
    failures.push(`bundle detected: risk ${candidate.metrics.bundleRisk}`);
  }
  if (strat.max_bundle_risk > 0 && candidate.metrics?.bundleRisk >= strat.max_bundle_risk) {
    failures.push(`bundle risk: ${candidate.metrics.bundleRisk} >= ${strat.max_bundle_risk}`);
  }

  // Honeypot risk
  if (candidate.honeypot?.honeypotRisk && strat.reject_honeypot) {
    failures.push('honeypot detected: token sell simulation failed');
  }

  // Deployer history (checked at execution time, not here)

  // Social media risk
  if (candidate.socialCheck?.lowSocialRisk && strat.reject_low_social) {
    failures.push('low social media presence');
  }

  // Composite scam risk
  if (strat.max_scam_risk > 0 && candidate.metrics?.scamRisk != null && candidate.metrics.scamRisk > strat.max_scam_risk) {
    failures.push(`scam risk: ${candidate.metrics.scamRisk} > ${strat.max_scam_risk}`);
  }

  // Dex Paid / Boost timing
  if (candidate.listingEvents) {
    if (strat.reject_boost_late && candidate.listingEvents.hasBoost && candidate.metrics.mcapTier === 'high_cap') {
      failures.push('boost active at high cap — possible distribution signal');
    }
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const tokenAuth = await fetchTokenAuth(mint);
  const clusterAnalysis = await computeClusterScore(holders);
  const cabalActivity = await detectCabalActivity(mint, holders);

  // Bundle detection via transaction analysis (lightweight: 1 RPC)
  const bundleTx = await detectBundleFromTx(signature, mint);

  // Organic volume intelligence (0 RPC, uses existing GMGN/Jupiter data)
  const organicVolume = computeOrganicVolume(gmgn, jupiterAsset, trendingToken);

  // Priority fee profile (1 RPC, lightweight)
  const { estimatePriorityFeeProfile } = await import('../enrichment/fees.js');
  const priorityFee = await estimatePriorityFeeProfile(mint).catch(() => null);

  // Honeypot simulation (2 Jupiter quote API calls)
  const honeypot = await detectHoneypot(mint).catch(() => null);

  // Social media validity (0 RPC)
  const socialCheck = validateSocialMedia(gmgn || graduatedCoin || jupiterAsset || {});

  // GMGN bundle signals from already-fetched gmgn data (0 RPC)
  const gmgnBundleScore = gmgn ? computeBundleScoreFromGmgn(gmgn) : null;
  const bundleRisk = aggregateBundleRisk({ txAnalysis: bundleTx, earlyBlock: null, gmgnScore: gmgnBundleScore });

  // Composite scam risk (0 RPC after all checks)
  const scamRisk = computeCompositeScamRisk(tokenAuth, honeypot, socialCheck, null);

  // Early block density (1 RPC, only run if already suspicious from tx or gmgn)
  let earlyBlock = null;
  if (bundleRisk.bundleRisk > 40 || scamRisk > 50) {
    earlyBlock = await analyzeEarlyBlockDensity(mint).catch(() => null);
    if (earlyBlock) {
      bundleRisk.layers.earlyBlock = earlyBlock;
      const updated = aggregateBundleRisk(bundleRisk.layers);
      bundleRisk.bundleRisk = updated.bundleRisk;
      bundleRisk.bundleDetected = updated.bundleDetected;
      bundleRisk.confidence = updated.confidence;
      bundleRisk.layerCount = updated.layerCount;
    }
  }
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );

  const solPrice = await cachedSolPrice();
  const gmgnFeesSol = Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0);
  const volumeUsd = firstPositiveNumber(gmgn?.volume, jupiterAsset?.volume, trendingToken?.volume, graduatedCoin?.volume) || 0;
  const feeToVolumeRatio = gmgnFeesSol > 0 && volumeUsd > 0 && solPrice > 0
    ? (gmgnFeesSol * solPrice) / volumeUsd
    : null;

  const mcapTier = classifyMcapTier(marketCapUsd);
  const listingEvents = extractListingEvents(jupiterAsset);

  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
      gmgnFeeToVolumeRatio: feeToVolumeRatio,
      mcapTier,
      organicVolumeScore: organicVolume?.organicScore,
      washTradingSuspected: organicVolume?.washTradingSuspected,
      priorityFeeProfile: priorityFee?.profile || null,
      scamRisk: scamRisk,
      bundleRisk: bundleRisk.bundleRisk,
      bundleDetected: bundleRisk.bundleDetected,
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    tokenAuth,
    clusterAnalysis,
    cabalActivity,
    listingEvents,
    bundleRisk,
    organicVolume,
    honeypot,
    socialCheck,
    priorityFee,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
