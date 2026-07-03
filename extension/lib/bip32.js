// BIP-0032 hierarchical-deterministic private-key derivation over secp256k1, browser/MV3-safe.
// WebCrypto for HMAC-SHA512 + the vendored @noble/secp256k1 for point(kpar); scalar math is BigInt
// mod the curve order n. We only ever derive PRIVATE keys (we hold the seed), so no public-parent /
// point-addition path is needed.
//
// Verge uses BIP-44 with SLIP-44 coin type 77: the wallet's account key path is m/44'/77'/0'/0/0.
// Correctness is load-bearing (a wrong child key strands funds); validated against BIP-32 Test
// Vector 1.

import * as secp from '../vendor/secp256k1.js';

// secp256k1 group order.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED = 0x80000000;

function bytesToBigInt(b) {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}
function ser256(x) {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function ser32(i) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i >>> 0, false); // big-endian
  return b;
}
function concat(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** HMAC-SHA512(key, data) -> Uint8Array(64) via WebCrypto. */
async function hmacSha512(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Master node from a BIP-39 seed: I = HMAC-SHA512("Bitcoin seed", seed). */
export async function masterFromSeed(seed) {
  const I = await hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed);
  const IL = I.slice(0, 32), IR = I.slice(32);
  const k = bytesToBigInt(IL);
  if (k === 0n || k >= N) throw new Error('invalid master key (retry with different seed)');
  return { privateKey: IL, chainCode: IR };
}

/** One CKDpriv step. `index` includes the hardened bit (>= 0x80000000). */
async function ckdPriv(node, index) {
  let data;
  if (index >= HARDENED) {
    // hardened: 0x00 || ser256(kpar) || ser32(i)
    data = concat(new Uint8Array([0]), node.privateKey, ser32(index));
  } else {
    // normal: serP(point(kpar)) || ser32(i)  (compressed public key)
    const pub = secp.getPublicKey(node.privateKey, true);
    data = concat(pub, ser32(index));
  }
  const I = await hmacSha512(node.chainCode, data);
  const IL = I.slice(0, 32), IR = I.slice(32);
  const parse = bytesToBigInt(IL);
  const kpar = bytesToBigInt(node.privateKey);
  const ki = (parse + kpar) % N;
  if (parse >= N || ki === 0n) throw new Error('invalid child key (proceed to next index)');
  return { privateKey: ser256(ki), chainCode: IR };
}

/** Parse an "m/44'/77'/0'/0/0" path into indices (with hardened bits applied). */
export function parsePath(path) {
  const parts = path.trim().split('/');
  if (parts[0] !== 'm' && parts[0] !== 'M') throw new Error("path must start with 'm'");
  return parts.slice(1).filter((p) => p.length).map((p) => {
    const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error(`bad path segment: ${p}`);
    return hardened ? n + HARDENED : n;
  });
}

/** Derive the node at `path` from a seed. Returns { privateKey:Uint8Array(32), chainCode }. */
export async function derivePath(seed, path) {
  let node = await masterFromSeed(seed);
  for (const index of parsePath(path)) node = await ckdPriv(node, index);
  return node;
}

/** Convenience: the 32-byte private key at `path`. */
export async function derivePrivateKey(seed, path) {
  return (await derivePath(seed, path)).privateKey;
}

export { N as CURVE_ORDER, HARDENED };
