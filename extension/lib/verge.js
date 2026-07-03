// Verge wallet crypto core for the browser (ESM, MV3-safe: no Node, no WASM).
//
// This is the browser port of the proven server-side signer (src/vergetx.js + bitcoinjs P2PKH
// paths). It uses ONLY WebCrypto (SHA-256) + two vendored dependencies:
//   - vendor/secp256k1.js  (@noble/secp256k1 v2, audited, pure JS, low-S by default)
//   - vendor/ripemd160.js  (standalone RIPEMD-160; WebCrypto has no ripemd160)
//
// Verge wire format (see src/vergetx.js): [int32 version][uint32 nTime][vin][vout][uint32 lock],
// NO witness ever serialized. Legacy sighash includes nTime. Everything here is Uint8Array in /
// Uint8Array out; hashing is async because WebCrypto's digest() is async.

import * as secp from '../vendor/secp256k1.js';
import { ripemd160 } from '../vendor/ripemd160.js';

// ---------------------------------------------------------------------------
// Network parameters (mirror of src/networks.js, the only two we ship).
// ---------------------------------------------------------------------------
export const NETWORKS = {
  mainnet: { name: 'verge', pubKeyHash: 30, scriptHash: 33, wif: 158 },
  testnet: { name: 'verge-testnet', pubKeyHash: 115, scriptHash: 198, wif: 243 },
};

export const COIN = 1_000_000; // 6 decimals; atomic unit = 0.000001 XVG
const SIGHASH_ALL = 0x01;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
export function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function reverseBytes(a) {
  const b = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) b[i] = a[a.length - 1 - i];
  return b;
}
function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function i32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0, true);
  return b;
}
function i64le(value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(value), true);
  return b;
}

// ---------------------------------------------------------------------------
// Hashing (WebCrypto SHA-256, async) + hash160
// ---------------------------------------------------------------------------
export async function sha256(data) {
  const d = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(d);
}
export async function dsha256(data) {
  return sha256(await sha256(data));
}
export async function hash160(data) {
  return ripemd160(await sha256(data));
}

// ---------------------------------------------------------------------------
// Base58 / Base58Check
// ---------------------------------------------------------------------------
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = (() => {
  const m = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]] = i;
  return m;
})();

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

export function base58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    const val = B58_MAP[str[i]];
    if (val === undefined) throw new Error('invalid base58 char');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export async function base58CheckEncode(payload) {
  const checksum = (await dsha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

export async function base58CheckDecode(str) {
  const full = base58Decode(str);
  if (full.length < 5) throw new Error('base58check too short');
  const payload = full.slice(0, full.length - 4);
  const checksum = full.slice(full.length - 4);
  const expected = (await dsha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) throw new Error('bad checksum');
  return payload;
}

// ---------------------------------------------------------------------------
// Keys / addresses / WIF
// ---------------------------------------------------------------------------
/** Random 32-byte private key (valid scalar). */
export function generatePrivateKey() {
  return secp.utils.randomSecretKey ? secp.utils.randomSecretKey() : secp.utils.randomPrivateKey();
}

/** Compressed public key (33 bytes) from a 32-byte private key. */
export function publicKeyFromPrivate(priv) {
  return secp.getPublicKey(priv, true);
}

/** P2PKH address from a compressed pubkey. */
export async function addressFromPubkey(pubkey, network = NETWORKS.mainnet) {
  const h = await hash160(pubkey);
  return base58CheckEncode(concatBytes(new Uint8Array([network.pubKeyHash]), h));
}

export async function addressFromPrivate(priv, network = NETWORKS.mainnet) {
  return addressFromPubkey(publicKeyFromPrivate(priv), network);
}

/** Encode a 32-byte private key to WIF (compressed). */
export async function privateKeyToWIF(priv, network = NETWORKS.mainnet) {
  const payload = concatBytes(new Uint8Array([network.wif]), priv, new Uint8Array([0x01]));
  return base58CheckEncode(payload);
}

/** Decode a WIF -> { privateKey: Uint8Array(32), compressed: bool }. Auto-detects network. */
export async function wifToPrivateKey(wif) {
  const payload = await base58CheckDecode(wif);
  const version = payload[0];
  let net = null;
  for (const k of Object.keys(NETWORKS)) if (NETWORKS[k].wif === version) net = NETWORKS[k];
  let priv, compressed;
  if (payload.length === 34) { // 1 version + 32 key + 1 compression flag
    if (payload[33] !== 0x01) throw new Error('bad WIF compression flag');
    priv = payload.slice(1, 33);
    compressed = true;
  } else if (payload.length === 33) { // uncompressed
    priv = payload.slice(1, 33);
    compressed = false;
  } else {
    throw new Error('bad WIF length');
  }
  return { privateKey: priv, compressed, network: net };
}

/** Decode a P2PKH address -> { hash160: Uint8Array(20), version }. */
export async function decodeAddress(addr) {
  const payload = await base58CheckDecode(addr);
  return { version: payload[0], hash160: payload.slice(1) };
}

/** scriptPubKey for a P2PKH output: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG. */
export async function p2pkhScript(addr) {
  const { hash160: h } = await decodeAddress(addr);
  return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), h, new Uint8Array([0x88, 0xac]));
}
function p2pkhScriptFromHash(h) {
  return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), h, new Uint8Array([0x88, 0xac]));
}

// ---------------------------------------------------------------------------
// Transaction serialization (Uint8Array port of src/vergetx.js)
// ---------------------------------------------------------------------------
export function varint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  if (n <= 0xffffffff) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b; }
  const b = new Uint8Array(9); b[0] = 0xff; new DataView(b.buffer).setBigUint64(1, BigInt(n), true); return b;
}
function withLength(bytes) {
  return concatBytes(varint(bytes.length), bytes);
}
function serializeInput(inp) {
  const prevTxid = reverseBytes(hexToBytes(inp.txid));
  const vout = u32le(inp.vout);
  const script = inp.script && inp.script.length ? inp.script : new Uint8Array(0);
  const seq = u32le(inp.sequence == null ? 0xffffffff : inp.sequence);
  return concatBytes(prevTxid, vout, withLength(script), seq);
}
function serializeOutput(out) {
  return concatBytes(i64le(out.value), withLength(out.script));
}
export function serializeTx(tx) {
  const parts = [
    i32le(tx.version == null ? 1 : tx.version),
    u32le(tx.time >>> 0),
    varint(tx.vin.length),
    ...tx.vin.map(serializeInput),
    varint(tx.vout.length),
    ...tx.vout.map(serializeOutput),
    u32le((tx.locktime || 0) >>> 0),
  ];
  return concatBytes(...parts);
}
export async function txid(tx) {
  return bytesToHex(reverseBytes(await dsha256(serializeTx(tx))));
}

/** Legacy sighash for input nIn against scriptCode; SIGHASH_ALL only (see src/vergetx.js). */
export async function legacySighash(tx, nIn, scriptCode, hashType = SIGHASH_ALL) {
  if ((hashType & 0x1f) !== SIGHASH_ALL || hashType & 0x80) throw new Error('only SIGHASH_ALL supported');
  const vin = tx.vin.map((inp, i) => ({
    txid: inp.txid,
    vout: inp.vout,
    sequence: inp.sequence,
    script: i === nIn ? scriptCode : new Uint8Array(0),
  }));
  const ser = serializeTx({ version: tx.version, time: tx.time, vin, vout: tx.vout, locktime: tx.locktime });
  return dsha256(concatBytes(ser, u32le(hashType)));
}

// ---------------------------------------------------------------------------
// Signatures: DER encode + push-encode
// ---------------------------------------------------------------------------
function derEncodeInt(x) { // x: Uint8Array big-endian minimal, may need a leading 0x00 if high bit set
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++; // strip leading zeros
  let v = x.slice(i);
  if (v[0] & 0x80) v = concatBytes(new Uint8Array([0x00]), v);
  return concatBytes(new Uint8Array([0x02, v.length]), v);
}
/** DER-encode an ECDSA signature from r,s bigints. */
export function derEncodeSig(r, s) {
  const rb = derEncodeInt(bigintToBytes(r));
  const sb = derEncodeInt(bigintToBytes(s));
  const body = concatBytes(rb, sb);
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}
function bigintToBytes(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}
/** Minimal push opcode(s) for a data element (used for pushing sig / pubkey into scriptSig). */
function pushData(bytes) {
  const len = bytes.length;
  if (len < 0x4c) return concatBytes(new Uint8Array([len]), bytes);
  if (len <= 0xff) return concatBytes(new Uint8Array([0x4c, len]), bytes);
  if (len <= 0xffff) { const b = new Uint8Array([0x4d, len & 0xff, (len >> 8) & 0xff]); return concatBytes(b, bytes); }
  const b = new Uint8Array([0x4e, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);
  return concatBytes(b, bytes);
}

/** Sign a 32-byte hash with priv; returns DER sig + SIGHASH_ALL byte appended. Low-S enforced. */
export async function signHash(hash, priv) {
  const sig = await secp.signAsync(hash, priv); // lowS: true by default
  const der = derEncodeSig(sig.r, sig.s);
  return concatBytes(der, new Uint8Array([SIGHASH_ALL]));
}

// ---------------------------------------------------------------------------
// Message signing (Bitcoin/Verge "magic hash" + recoverable signature, base64)
// ---------------------------------------------------------------------------
const MSG_PREFIX = '\x18Verge Signed Message:\n';
function bigintTo32(n) {
  const b = new Uint8Array(32);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const raw = hexToBytes(hex);
  b.set(raw, 32 - raw.length);
  return b;
}
function varstr(bytes) { return concatBytes(varint(bytes.length), bytes); }

/** Verge magic hash of a message: dsha256(varstr(prefix) || varstr(message)). */
export async function magicHash(message) {
  const enc = new TextEncoder();
  return dsha256(concatBytes(varstr(enc.encode(MSG_PREFIX)), varstr(enc.encode(message))));
}

/**
 * Sign a text message the Verge/Bitcoin way. Returns base64 of [header][r32][s32], where
 * header = 27 + recoveryId + (compressed ? 4 : 0). Verifiable by standard verifymessage.
 */
export async function signMessage(message, priv, compressed = true) {
  const h = await magicHash(message);
  const sig = await secp.signAsync(h, priv); // lowS + recovery bit
  const rec = sig.recovery & 1; // low-S normalization keeps recovery in {0,1}
  const header = new Uint8Array([27 + rec + (compressed ? 4 : 0)]);
  const packed = concatBytes(header, bigintTo32(sig.r), bigintTo32(sig.s));
  return btoa(String.fromCharCode(...packed));
}

// ---------------------------------------------------------------------------
// Build + sign a P2PKH transaction (all inputs are P2PKH carriers / funders)
// ---------------------------------------------------------------------------
/**
 * @param {Object} p
 * @param {Array}  p.inputs   [{ txid, vout, value, privateKey }]  (privateKey: Uint8Array(32))
 * @param {Array}  p.outputs  [{ address, value }]
 * @param {number} p.time     nTime (unix seconds) to stamp the tx
 * @param {number} [p.version=1]
 * @param {number} [p.locktime=0]
 * @returns {{ hex:string, txid:string, size:number }}
 */
export async function buildAndSignP2PKH({ inputs, outputs, time, version = 1, locktime = 0 }) {
  const vout = [];
  for (const o of outputs) vout.push({ value: o.value, script: await p2pkhScript(o.address) });
  const vin = inputs.map((inp) => ({ txid: inp.txid, vout: inp.vout, sequence: 0xffffffff, script: new Uint8Array(0) }));
  const tx = { version, time, vin, vout, locktime };

  for (let i = 0; i < inputs.length; i++) {
    const priv = inputs[i].privateKey;
    const pub = publicKeyFromPrivate(priv);
    const h = await hash160(pub);
    const scriptCode = p2pkhScriptFromHash(h);
    const sighash = await legacySighash(tx, i, scriptCode, SIGHASH_ALL);
    const sig = await signHash(sighash, priv);
    tx.vin[i].script = concatBytes(pushData(sig), pushData(pub));
  }

  const ser = serializeTx(tx);
  return { hex: bytesToHex(ser), txid: await txid(tx), size: ser.length };
}

// ---------------------------------------------------------------------------
// Inscription-aware transfer
// ---------------------------------------------------------------------------
/**
 * Build a transfer that moves ONE inscription carrier UTXO to a recipient, funding the fee from
 * ordinary spendable UTXOs. Ordinal-safe: the carrier is input 0 AND output 0 (the inscription's
 * sat rides on the first sat of the first output), so it is never merged/spent as fee. Change goes
 * back to changeAddress. Any UTXO flagged `inscription` (other than the chosen carrier) is refused
 * as a funder so we never accidentally destroy another inscription.
 *
 * @param {Object} p
 * @param {Object} p.carrier        { txid, vout, value, privateKey }  the inscription UTXO to move
 * @param {Array}  p.funders        [{ txid, vout, value, privateKey, inscription? }] spendable UTXOs
 * @param {string} p.toAddress      recipient P2PKH address
 * @param {string} p.changeAddress  where change (and the carrier's own key) returns
 * @param {number} p.feePerKb       fee rate in atomic units per 1000 bytes (>= 200000 = 0.2 XVG)
 * @param {number} p.time           nTime
 * @param {number} [p.dustThreshold=100000]  min output value in atomic units
 */
export async function buildInscriptionTransfer({ carrier, funders, toAddress, changeAddress, feePerKb, time, dustThreshold = 100000 }) {
  if (!carrier || carrier.privateKey == null) throw new Error('carrier + its privateKey required');
  const safeFunders = (funders || []).filter((u) => !u.inscription);
  // Estimate size: ~148 B per P2PKH input + ~34 B per output + ~14 B overhead. Iterate to
  // include just enough funders to cover fee + keep carrier value intact on output 0.
  const carrierOut = carrier.value; // preserve the carrier value on output 0 (sat stays put)
  let chosen = [];
  let fee = 0;
  for (let attempt = 0; attempt <= safeFunders.length; attempt++) {
    const inputsCount = 1 + chosen.length;
    const outputsCount = 2; // recipient carrier + change (worst case)
    const estSize = 14 + inputsCount * 148 + outputsCount * 34;
    fee = Math.max(feePerKb, Math.ceil((estSize / 1000) * feePerKb));
    const fundTotal = chosen.reduce((a, u) => a + u.value, 0);
    // We need funders to cover the fee (carrier value is preserved 1:1 on output 0).
    if (fundTotal >= fee + dustThreshold || (fundTotal >= fee && attempt === safeFunders.length)) break;
    if (attempt < safeFunders.length) chosen.push(safeFunders[attempt]);
  }
  const fundTotal = chosen.reduce((a, u) => a + u.value, 0);
  if (fundTotal < fee) throw new Error(`insufficient funds for fee: need ${fee}, have ${fundTotal}`);

  const inputs = [
    { txid: carrier.txid, vout: carrier.vout, value: carrier.value, privateKey: carrier.privateKey },
    ...chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, privateKey: u.privateKey })),
  ];
  const outputs = [{ address: toAddress, value: carrierOut }];
  const change = fundTotal - fee;
  if (change >= dustThreshold) outputs.push({ address: changeAddress, value: change });
  // else: change is dust, it is absorbed into the fee.

  return buildAndSignP2PKH({ inputs, outputs, time });
}
