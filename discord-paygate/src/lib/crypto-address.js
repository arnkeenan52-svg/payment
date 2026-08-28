// Payout address validation, per chain.
// ============================================================================
//
// A crypto payout is irreversible. There is no chargeback, no support queue
// and no "we'll reverse it" — a typo in a seller's wallet sends every sale
// they ever make to an address nobody controls. So the address is checked
// against the actual rules of the chain it belongs to, not a regex that only
// proves the characters look plausible.
//
// Every family here is checked by its own checksum:
//   • EVM      EIP-55 mixed-case checksum (all-lower / all-upper accepted)
//   • Bitcoin-like  base58check (double-SHA256) and bech32 / bech32m
//   • Tron     base58check with the 0x41 version byte
//   • Solana   base58, exactly 32 bytes
//   • XRP      base58check on Ripple's own alphabet
//   • Cardano  bech32 (addr1…)
//
// A chain nobody here knows how to check is NOT rejected — new tickers appear
// on NOWPayments constantly and refusing them would quietly break payouts for
// coins that work fine. It comes back `verified: false` instead, and the
// settings form makes the seller retype the address before it will save.

import crypto from 'node:crypto';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ── base58 ──────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Ripple uses the same maths on a shuffled alphabet, which is why an XRP
// address decoded with Bitcoin's table produces bytes that fail the checksum.
const XRP58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

function b58decode(str, alphabet = B58) {
  if (!str) return null;
  const map = new Map([...alphabet].map((c, i) => [c, i]));
  const bytes = [];
  for (const ch of str) {
    let carry = map.get(ch);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading zero-digit is a literal leading zero byte, not part of the
  // number — dropping them is how a valid address turns into a short one.
  for (const ch of str) {
    if (ch !== alphabet[0]) break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

// payload ‖ first 4 bytes of sha256(sha256(payload))
function b58check(str, alphabet = B58) {
  const raw = b58decode(str, alphabet);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const want = sha256(sha256(payload)).subarray(0, 4);
  return want.equals(raw.subarray(raw.length - 4)) ? payload : null;
}

// ── bech32 / bech32m ────────────────────────────────────────────────────────

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

function bech32Decode(addr) {
  if (typeof addr !== 'string' || addr.length < 8 || addr.length > 108) return null;
  // Mixed case is forbidden outright by BIP-173 — it makes the checksum
  // ambiguous rather than merely ugly.
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const s = addr.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) return null;
  const hrp = s.slice(0, sep);
  const data = [];
  for (const ch of s.slice(sep + 1)) {
    const v = B32.indexOf(ch);
    if (v === -1) return null;
    data.push(v);
  }
  const chk = polymod([...hrpExpand(hrp), ...data]);
  // 1 = bech32 (witness v0), 0x2bc830a3 = bech32m (witness v1+, BIP-350).
  const spec = chk === 1 ? 'bech32' : chk === 0x2bc830a3 ? 'bech32m' : null;
  if (!spec) return null;
  return { hrp, data: data.slice(0, -6), spec };
}

function convert5to8(data) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  // Leftover bits must be zero padding, never carried data.
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return Buffer.from(out);
}

// A segwit address: correct spec for its witness version, program of a legal
// length, and v0 restricted to the two standard sizes.
function segwitOk(addr, hrp) {
  const d = bech32Decode(addr);
  if (!d || d.hrp !== hrp || !d.data.length) return false;
  const version = d.data[0];
  if (version > 16) return false;
  if (version === 0 && d.spec !== 'bech32') return false;
  if (version > 0 && d.spec !== 'bech32m') return false;
  const prog = convert5to8(d.data.slice(1));
  if (!prog || prog.length < 2 || prog.length > 40) return false;
  if (version === 0 && prog.length !== 20 && prog.length !== 32) return false;
  return true;
}

// ── EVM (EIP-55) ────────────────────────────────────────────────────────────

// keccak256, the hash Ethereum actually uses. Node ships SHA3-256, which is
// the FIPS variant with a different padding byte — using it produces a
// checksum that rejects every real address, so keccak is implemented here.
function keccak256(msg) {
  const RC = [
    0x00000001n, 0x00008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const R = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
  ];
  const M = (1n << 64n) - 1n;
  const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const A = Array.from({ length: 5 }, () => Array(5).fill(0n));

  const rate = 136; // 1088 bits, the rate for keccak-256
  const input = Buffer.from(msg);
  const padLen = rate - (input.length % rate);
  const padded = Buffer.concat([input, Buffer.alloc(padLen)]);
  padded[input.length] = 0x01; // keccak padding, NOT SHA3's 0x06
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      A[i % 5][Math.floor(i / 5)] ^= padded.readBigUInt64LE(off + i * 8);
    }
    for (let round = 0; round < 24; round++) {
      const C = Array(5);
      for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
      const D = Array(5);
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B = Array.from({ length: 5 }, () => Array(5).fill(0n));
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], R[x][y]);
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & B[(x + 2) % 5][y]) & M;
      }
      A[0][0] ^= RC[round];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i % 5][Math.floor(i / 5)] & M, i * 8);
  return out;
}

function evmOk(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  // A single-case address carries no checksum to verify — it is valid, just
  // unprotected. Only a mixed-case one claims EIP-55 and must satisfy it.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = keccak256(Buffer.from(body.toLowerCase(), 'utf8')).toString('hex');
  for (let i = 0; i < 40; i++) {
    const upper = parseInt(hash[i], 16) >= 8;
    if (upper ? body[i] !== body[i].toUpperCase() : body[i] !== body[i].toLowerCase()) return false;
  }
  return true;
}

// ── ticker → chain family ───────────────────────────────────────────────────

// NOWPayments encodes the network in the ticker (usdttrc20, usdcbase, …), so
// the family is read off the suffix. Explicit tickers win over suffixes: wbtc
// is an ERC-20 token, not a Bitcoin address, and 'base' ends in 'ase' not
// 'btc' — the order below is load-bearing.
const EXPLICIT = new Map(Object.entries({
  btc: 'btc', ltc: 'ltc', doge: 'doge', xrp: 'xrp', ada: 'ada', sol: 'sol', trx: 'trx',
  eth: 'evm', bnb: 'evm', bnbbsc: 'evm', matic: 'evm', pol: 'evm', avax: 'evm',
  arb: 'evm', op: 'evm', base: 'evm', ftm: 'evm', dai: 'evm', wbtc: 'evm', shib: 'evm',
  link: 'evm', uni: 'evm', aave: 'evm', busd: 'evm', pyusd: 'evm',
}));
const SUFFIX = [
  ['trc20', 'trx'], ['erc20', 'evm'], ['bep20', 'evm'], ['bsc', 'evm'], ['matic', 'evm'],
  ['pol', 'evm'], ['base', 'evm'], ['arb', 'evm'], ['op', 'evm'], ['avax', 'evm'],
  ['eth', 'evm'], ['sol', 'sol'], ['ada', 'ada'], ['xrp', 'xrp'], ['ltc', 'ltc'],
  ['doge', 'doge'], ['btc', 'btc'],
];

export function chainFamily(ticker) {
  const t = String(ticker ?? '').toLowerCase().trim();
  if (!t) return null;
  if (EXPLICIT.has(t)) return EXPLICIT.get(t);
  for (const [suffix, family] of SUFFIX) if (t.endsWith(suffix)) return family;
  return null;
}

const FAMILY_NAME = {
  evm: 'an Ethereum-style (EVM) address',
  btc: 'a Bitcoin address',
  ltc: 'a Litecoin address',
  doge: 'a Dogecoin address',
  trx: 'a Tron address',
  sol: 'a Solana address',
  xrp: 'an XRP address',
  ada: 'a Cardano address',
};

// Version bytes are what separates a Litecoin address from a Bitcoin one:
// both are base58check, and without this a BTC address saves happily as an
// LTC payout wallet and the funds are gone.
const B58_VERSIONS = { btc: [0x00, 0x05], ltc: [0x30, 0x32, 0x05], doge: [0x1e, 0x16] };

function checkFamily(family, addr) {
  switch (family) {
    case 'evm':
      return evmOk(addr);
    case 'trx': {
      const p = b58check(addr);
      return Boolean(p && p.length === 21 && p[0] === 0x41);
    }
    case 'sol': {
      const raw = b58decode(addr);
      // No checksum exists — a Solana address IS a 32-byte ed25519 key, so
      // the length is the only structural check there is.
      return Boolean(raw && raw.length === 32);
    }
    case 'xrp': {
      const p = b58check(addr, XRP58);
      return Boolean(p && p.length === 21 && p[0] === 0x00);
    }
    case 'ada':
      return Boolean(bech32Decode(addr)?.hrp === 'addr');
    case 'btc':
    case 'ltc':
    case 'doge': {
      const hrp = family === 'btc' ? 'bc' : family === 'ltc' ? 'ltc' : null;
      if (hrp && addr.toLowerCase().startsWith(`${hrp}1`)) return segwitOk(addr, hrp);
      const p = b58check(addr);
      return Boolean(p && p.length === 21 && B58_VERSIONS[family].includes(p[0]));
    }
    default:
      return false;
  }
}

/**
 * @returns {{ok: boolean, verified: boolean, family: string|null, error: string|null}}
 *   ok        — safe to store
 *   verified  — a real checksum was computed and passed (false = unknown chain)
 */
export function validateAddress(address, ticker) {
  const addr = String(address ?? '').trim();
  if (!addr) return { ok: false, verified: false, family: null, error: 'Enter a wallet address.' };
  // Whitespace inside an address is always a paste artefact, and every chain
  // here is ASCII — a smart quote or a zero-width space from a chat client
  // would otherwise sail through as an "unknown chain".
  if (/\s/.test(addr) || !/^[\x21-\x7e]+$/.test(addr)) {
    return { ok: false, verified: false, family: null, error: 'That address contains spaces or characters no wallet uses — paste it again.' };
  }
  if (addr.length > 128) {
    return { ok: false, verified: false, family: null, error: 'That address is too long to be real.' };
  }
  const family = chainFamily(ticker);
  if (!family) {
    // Unknown chain: stored, but never claimed as checked. The settings form
    // turns this into a retype-to-confirm step.
    return { ok: true, verified: false, family: null, error: null };
  }
  if (!checkFamily(family, addr)) {
    return {
      ok: false,
      verified: false,
      family,
      error: `That is not ${FAMILY_NAME[family] ?? 'a valid address'} — check you copied the ${String(ticker).toUpperCase()} address from your wallet, not another coin's.`,
    };
  }
  return { ok: true, verified: true, family, error: null };
}
