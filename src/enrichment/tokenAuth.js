import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const authCache = new Map();
const AUTH_CACHE_TTL = 5 * 60 * 1000;

export function decodeMintAccount(data) {
  const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), c => c.charCodeAt(0)) : data;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const mintAuthorityOption = view.getUint32(0, true);
  const mintAuthority = mintAuthorityOption === 1
    ? base58Encode(bytes.slice(4, 36))
    : null;

  const freezeOptionOffset = mintAuthorityOption === 1 ? 46 : 46 - 32;
  const freezeAuthorityOffset = freezeOptionOffset + 4;
  const freezeAuthorityOption = view.getUint32(freezeOptionOffset, true);
  const freezeAuthority = freezeAuthorityOption === 1
    ? base58Encode(bytes.slice(freezeAuthorityOffset, freezeAuthorityOffset + 32))
    : null;

  return {
    mintActive: mintAuthorityOption === 1,
    freezeActive: freezeAuthorityOption === 1,
    mintAuthority,
    freezeAuthority,
  };
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(x => ALPHABET[x]).join('');
}

export async function fetchTokenAuth(mint) {
  const cached = authCache.get(mint);
  if (cached && now() - cached.at < AUTH_CACHE_TTL) return cached.data;

  try {
    const res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { commitment: 'confirmed' }],
      }),
    });
    const json = await res.json();
    const accountData = json?.result?.value?.data;
    if (!accountData) return null;

    const [encoded, encoding] = Array.isArray(accountData) ? accountData : [accountData, 'base64'];
    if (encoding !== 'base64') return null;

    const result = decodeMintAccount(encoded);
    authCache.set(mint, { at: now(), data: result });
    return result;
  } catch (err) {
    console.log(`[tokenAuth] ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}
