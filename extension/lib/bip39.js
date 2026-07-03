// BIP-0039 mnemonic <-> entropy <-> seed, browser/MV3-safe (WebCrypto only, no Node, no WASM).
//
// A mnemonic is a human-writable backup of the wallet's entropy: 12 words = 128 bits, 24 words =
// 256 bits, with a SHA-256 checksum folded into the last word so a mistyped phrase is detectable.
// mnemonicToSeed() stretches the phrase (+ an optional 25th-word passphrase) into the 64-byte BIP-32
// seed via PBKDF2-HMAC-SHA512, exactly as every other BIP-39 wallet does, so a phrase generated here
// restores in Electrum/Ledger/etc. and vice-versa.
//
// Correctness here is load-bearing: a wrong checksum table or normalization would silently produce a
// DIFFERENT seed and strand funds. This module is validated against the official Trezor test vectors.

import { WORDLIST } from '../vendor/bip39-wordlist.js';

const enc = new TextEncoder();

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Uint8Array -> array of bits (MSB first). */
function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}

/**
 * Encode entropy (16, 20, 24, 28, or 32 bytes) as a mnemonic phrase.
 * The checksum is the first (entropyBits / 32) bits of SHA-256(entropy).
 */
export async function entropyToMnemonic(entropy) {
  if (!(entropy instanceof Uint8Array)) throw new Error('entropy must be Uint8Array');
  if (entropy.length < 16 || entropy.length > 32 || entropy.length % 4 !== 0) {
    throw new Error('entropy must be 16..32 bytes in steps of 4');
  }
  const entBits = bytesToBits(entropy);
  const csLen = entropy.length * 8 / 32; // checksum bits
  const hash = await sha256(entropy);
  const csBits = bytesToBits(hash).slice(0, csLen);
  const bits = entBits.concat(csBits);

  const words = [];
  for (let i = 0; i < bits.length; i += 11) {
    let idx = 0;
    for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j];
    words.push(WORDLIST[idx]);
  }
  return words.join(' ');
}

/** Decode + checksum-verify a mnemonic back to its entropy bytes. Throws if invalid. */
export async function mnemonicToEntropy(mnemonic) {
  const words = normalize(mnemonic).split(' ');
  if (words.length % 3 !== 0 || words.length < 12 || words.length > 24) {
    throw new Error('invalid mnemonic length');
  }
  const bits = [];
  for (const w of words) {
    const idx = WORDLIST.indexOf(w);
    if (idx === -1) throw new Error(`invalid mnemonic word: ${w}`);
    for (let i = 10; i >= 0; i--) bits.push((idx >> i) & 1);
  }
  const csLen = bits.length / 33; // total = ENT + ENT/32; ENT/32 = total/33
  const entBits = bits.slice(0, bits.length - csLen);
  const csBits = bits.slice(bits.length - csLen);

  const entropy = new Uint8Array(entBits.length / 8);
  for (let i = 0; i < entropy.length; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | entBits[i * 8 + j];
    entropy[i] = b;
  }
  const hash = await sha256(entropy);
  const expected = bytesToBits(hash).slice(0, csLen);
  for (let i = 0; i < csLen; i++) if (csBits[i] !== expected[i]) throw new Error('bad mnemonic checksum');
  return entropy;
}

/** True iff `mnemonic` is a well-formed, checksum-valid phrase. */
export async function validateMnemonic(mnemonic) {
  try { await mnemonicToEntropy(mnemonic); return true; } catch { return false; }
}

/**
 * Generate a fresh mnemonic from CSPRNG entropy.
 * @param {number} strength bits of entropy: 128 (12 words, default) or 256 (24 words).
 */
export async function generateMnemonic(strength = 128) {
  if (strength % 32 !== 0 || strength < 128 || strength > 256) throw new Error('strength must be 128..256, multiple of 32');
  const entropy = crypto.getRandomValues(new Uint8Array(strength / 8));
  return entropyToMnemonic(entropy);
}

/** NFKD-normalize and collapse whitespace (BIP-39 requires NFKD before hashing/stretching). */
function normalize(str) {
  return str.normalize('NFKD').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Stretch a mnemonic (+ optional passphrase, the "25th word") into the 64-byte BIP-32 seed.
 * PBKDF2-HMAC-SHA512, 2048 iterations, salt = "mnemonic" + passphrase (both NFKD).
 * @returns {Promise<Uint8Array>} 64 bytes
 */
export async function mnemonicToSeed(mnemonic, passphrase = '') {
  const pw = enc.encode(normalize(mnemonic));
  const salt = enc.encode('mnemonic' + passphrase.normalize('NFKD'));
  const baseKey = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 2048, hash: 'SHA-512' },
    baseKey,
    512,
  );
  return new Uint8Array(bits);
}

export { WORDLIST };
