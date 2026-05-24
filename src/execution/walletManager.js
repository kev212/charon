import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOLANA_PRIVATE_KEY, SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { db } from '../db/connection.js';

let walletManager = null;

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initWalletManager() {
  const wallets = [];

  // Multi-wallet from env
  if (process.env.SOLANA_WALLETS) {
    const parsed = parseWalletEnv(process.env.SOLANA_WALLETS);
    wallets.push(...parsed);
  }

  // Single wallet fallback (existing config)
  if (!wallets.length && SOLANA_PRIVATE_KEY) {
    const kp = parseKeypair(SOLANA_PRIVATE_KEY);
    if (kp) wallets.push({ label: 'main', keypair: kp, pubkey: kp.publicKey.toBase58(), openPositions: 0 });
  }

  walletManager = {
    wallets,
    currentIndex: 0,
    initialized: true,
  };

  syncOpenPositions();
  return walletManager;
}

export function getWalletManager() {
  if (!walletManager?.initialized) initWalletManager();
  return walletManager;
}

export function parseWalletEnv(envValue) {
  if (!envValue?.trim()) return [];
  const entries = [];
  for (const part of envValue.split(';')) {
    const [label, ...keyParts] = part.split(':');
    const key = keyParts.join(':');
    if (!label || !key) continue;
    const kp = parseKeypair(key);
    if (kp) entries.push({ label: label.trim(), keypair: kp, pubkey: kp.publicKey.toBase58(), openPositions: 0 });
  }
  return entries;
}

function syncOpenPositions() {
  if (!walletManager?.wallets?.length) return;
  const open = db.prepare(`
    SELECT wallet_label, COUNT(*) as count FROM dry_run_positions
    WHERE status = 'open' GROUP BY wallet_label
  `).all();
  for (const wallet of walletManager.wallets) {
    const match = open.find(o => o.wallet_label === wallet.label);
    wallet.openPositions = match?.count || 0;
  }
}

export function registerWalletPosition(label) {
  db.prepare('UPDATE dry_run_positions SET wallet_label = ? WHERE wallet_label IS NULL').run(label);
  syncOpenPositions();
}

export function walletBalanceLamports(pubkey) {
  return fetch(`${SOLANA_RPC_URL}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [pubkey, { commitment: 'confirmed' }],
    }),
  }).then(r => r.json()).then(j => j?.result?.value ?? 0).catch(() => 0);
}
