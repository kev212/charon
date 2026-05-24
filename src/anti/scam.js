import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const scamCache = new Map();
const SCAM_CACHE_TTL = 30 * 60 * 1000;

async function rpcCall(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json?.result;
}

export async function fetchDeployerHistory(deployerAddress) {
  if (!deployerAddress) return null;

  try {
    const sigs = await rpcCall('getSignaturesForAddress', [deployerAddress, { limit: 50, commitment: 'confirmed' }]);
    if (!sigs?.length) return null;

    const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    let coinCount = 0;
    let rugCount = 0;
    const seenMints = new Set();

    for (const sig of sigs.slice(0, 20)) {
      try {
        const tx = await rpcCall('getTransaction', [sig.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }]);
        if (!tx) continue;

        const accounts = tx.transaction?.message?.accountKeys || [];
        if (!accounts.some(a => a === pumpProgram || a?.pubkey === pumpProgram)) continue;

        const postBalances = tx.meta?.postBalances || [];
        const preBalances = tx.meta?.preBalances || [];
        const idx = accounts.findIndex(a => a === deployerAddress || a?.pubkey === deployerAddress);
        if (idx < 0) continue;

        const deployerDelta = (postBalances[idx] || 0) - (preBalances[idx] || 0);

        const postTokenBalances = tx.meta?.postTokenBalances || [];
        const preTokenBalances = tx.meta?.preTokenBalances || [];
        const newTokens = postTokenBalances.filter(pt => {
          if (seenMints.has(pt.mint)) return false;
          const matched = preTokenBalances.find(pre => pre.mint === pt.mint);
          const hadToken = matched && Number(matched.uiTokenAmount?.amount || 0) > 0;
          return !hadToken && Number(pt.uiTokenAmount?.amount || 0) > 0;
        });

        for (const t of newTokens) {
          seenMints.add(t.mint);
          coinCount++;
          if (deployerDelta < 0) {
            // Deployer received SOL but has no/has fewer tokens → likely sold = rug
            const held = postTokenBalances.find(b => b.mint === t.mint && b.owner === deployerAddress);
            if (!held || Number(held.uiTokenAmount?.amount || 0) < 100) {
              rugCount++;
            }
          }
        }
      } catch {
        continue;
      }
    }

    return {
      totalDeployed: coinCount,
      totalRugged: rugCount,
      rugRatio: coinCount > 0 ? Math.round((rugCount / coinCount) * 100) / 100 : 0,
      checkedTransactions: Math.min(sigs.length, 20),
    };
  } catch (err) {
    console.log(`[scam] deployer history ${deployerAddress?.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

async function honeypotSwapSimulation(mint) {
  try {
    const res = await fetch('https://quote-api.jup.ag/v6/quote', {
      method: 'GET',
      headers: JSON_HEADERS,
    });
    const quoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=1000&slippageBps=500`,
      { headers: JSON_HEADERS }
    );
    if (!quoteRes.ok) return { simFailed: true, reason: 'jupiter_quote_error', honeypotRisk: true };

    const quote = await quoteRes.json();
    if (quote.error || !quote.outAmount || Number(quote.outAmount) <= 0) {
      return { simFailed: true, reason: 'no_quote', honeypotRisk: true };
    }

    // Now try the reverse (sell) — can we swap the token back to SOL?
    const sellQuoteRes = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${quote.outAmount}&slippageBps=500`,
      { headers: JSON_HEADERS }
    );
    if (!sellQuoteRes.ok) return { simFailed: false, outAmount: quote.outAmount, honeypotRisk: true, reason: 'sell_jup_error' };

    const sellQuote = await sellQuoteRes.json();
    if (sellQuote.error || !sellQuote.outAmount || Number(sellQuote.outAmount) <= 0) {
      return { simFailed: false, outAmount: quote.outAmount, honeypotRisk: true, reason: 'sell_failed' };
    }

    const buyAmount = Number(quote.outAmount);
    const sellAmount = Number(sellQuote.outAmount);

    // If sell yields < 50% of buy (after slippage), it's effectively a honeypot
    const ratio = buyAmount > 0 ? sellAmount / buyAmount : 0;
    const honeypotRisk = ratio < 0.3;

    return {
      simFailed: false,
      buyAmount,
      sellAmount,
      ratio: Math.round(ratio * 100) / 100,
      honeypotRisk,
      reason: honeypotRisk ? `sell/buy ratio ${ratio.toFixed(2)}` : null,
    };
  } catch (err) {
    return { simFailed: true, reason: err.message, honeypotRisk: true };
  }
}

export async function detectHoneypot(mint) {
  const cached = scamCache.get(`honeypot:${mint}`);
  if (cached && now() - cached.at < SCAM_CACHE_TTL) return cached.data;

  const result = await honeypotSwapSimulation(mint);
  scamCache.set(`honeypot:${mint}`, { at: now(), data: result });
  return result;
}

export function validateSocialMedia(token) {
  const checks = {
    hasTwitter: Boolean(token?.twitter),
    twitterUrl: token?.twitter?.match(/^https?:\/\/(x\.com|twitter\.com)\/\w+/i) ? 'valid' : 'invalid',
    hasWebsite: Boolean(token?.website),
    websiteUrl: token?.website?.match(/^https?:\/\//) ? 'valid' : 'invalid',
    hasTelegram: Boolean(token?.telegram),
    telegramUrl: token?.telegram?.match(/^https?:\/\/t\.me\//) ? 'valid' : 'invalid',
  };

  let socialScore = 0;
  if (checks.hasTwitter) socialScore += 40;
  if (checks.hasWebsite) socialScore += 20;
  if (checks.hasTelegram) socialScore += 20;

  // Telegram group with no Twitter → suspicious
  if (checks.hasTelegram && !checks.hasTwitter) socialScore -= 15;

  return {
    ...checks,
    socialScore,
    lowSocialRisk: socialScore < 30,
  };
}

export function computeCompositeScamRisk(tokenAuth, honeypot, social, deployerHistory) {
  let risk = 0;

  if (tokenAuth?.mintActive) risk += 30;
  if (tokenAuth?.freezeActive) risk += 20;
  if (honeypot?.honeypotRisk) risk += 35;
  if (social?.lowSocialRisk) risk += 10;
  if (deployerHistory) {
    if (deployerHistory.rugRatio > 0.5) risk += 30;
    else if (deployerHistory.rugRatio > 0.2) risk += 15;
    if (deployerHistory.totalRugged > 5) risk += 15;
    if (deployerHistory.totalDeployed > 20) risk += 5;
  }

  return Math.min(risk, 100);
}
