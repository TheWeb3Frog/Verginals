// The key that opens a locked ticker price, derived rather than invented.
//
// Etching a Verge Rune locks the ticker price in a P2SH CLTV output for 1460 days. The first
// version made a fresh random key in the page and told the etcher to save it, which is the worst
// backup story this project has: an orphan key, unrelated to anything they already keep, needed
// exactly once, four years later. Worse, the coins are NOT at that key's ordinary address, so
// importing it into any wallet shows a balance of zero and looks like theft.
//
// The key now comes from the same twelve words the wallet is already built on, at its own hardened
// BIP-44 account. Nothing new to write down: the backup happened years earlier, when they wrote
// down their seed.
//
// WHY A SEPARATE ACCOUNT AND NOT A SEPARATE CHANGE BRANCH. Account 1' is hardened, so a watch-only
// export of account 0' can never be used to derive lock keys, and wallets that scan only account 0'
// (which is nearly all of them) will never sweep one by accident. Sweeping one would take nothing
// anyway, because the lock key's ordinary address is always empty, but a wallet showing a stray
// empty address to a user is a support question nobody needs.
//
// THIS PATH IS A PROMISE. It is published in spec/RUNES-SPEC-v0.md and in the recovery kit, because
// somebody in 2036 with twelve words and no Verginals software must be able to rederive the key
// with any BIP-32 tool. Never change it.

import { derivePrivateKey } from './bip32.js';
import * as verge from './verge.js';

/** m / purpose' / Verge / lock account' / external / index */
export const LOCK_ACCOUNT = "m/44'/77'/1'/0";
export const lockPath = (index) => `${LOCK_ACCOUNT}/${index}`;

// How far a wallet looks when hunting for its own locks. An etcher who made twenty coins is already
// remarkable, and the scan is a few hundred hashes, so this is generous rather than tuned.
export const DEFAULT_SCAN = 50;

/**
 * The lock key at one index. Returns the public half by default: the page composing an etch needs
 * the pubkey and must never see the private one.
 */
export async function deriveLockKey(seed, index, { includePrivate = false } = {}) {
  const priv = await derivePrivateKey(seed, lockPath(index));
  const pub = verge.publicKeyFromPrivate(priv);
  const out = { index, path: lockPath(index), pubkey: verge.bytesToHex(pub) };
  if (includePrivate) out.privateKey = priv;
  return out;
}

/** The public keys this seed would publish, indexes 0..count-1. */
export async function lockPubkeys(seed, count = DEFAULT_SCAN) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await deriveLockKey(seed, i));
  return out;
}

/**
 * Which of the locks published on chain belong to this seed.
 *
 * An etching publishes `l = { t, k }`, so every lock's public key is already on the chain, for
 * everybody. That is what makes discovery possible without an address index, without scanning, and
 * without telling anybody anything: the wallet derives its own candidates and compares locally. The
 * server hands out the same public list to everyone and never learns which ones are yours.
 *
 * @param {Uint8Array} seed
 * @param {Array<{pubkey:string}>} published  lock records read off the chain
 * @param {number} scan                       how many derivation indexes to try
 * @returns {Promise<Array>} the matching records, each tagged with its index and path
 */
export async function matchPublishedLocks(seed, published, scan = DEFAULT_SCAN) {
  const mine = new Map();
  for (const k of await lockPubkeys(seed, scan)) mine.set(k.pubkey.toLowerCase(), k);
  const out = [];
  for (const rec of published || []) {
    const hit = mine.get(String(rec.pubkey || '').toLowerCase());
    if (hit) out.push({ ...rec, index: hit.index, path: hit.path });
  }
  return out;
}

/** The next index to use, given what this seed has already published. Never reuses a key. */
export function nextLockIndex(matched) {
  if (!matched || !matched.length) return 0;
  return Math.max(...matched.map((m) => m.index)) + 1;
}

/** Seconds until a lock opens, and a plain phrase for it. Negative means it is already open. */
export function timeUntil(locktime, now = Math.floor(Date.now() / 1000)) {
  const left = Number(locktime) - now;
  if (left <= 0) return { left, open: true, text: 'open now' };
  const days = Math.floor(left / 86400);
  if (days >= 365) {
    const years = Math.floor(days / 365), months = Math.floor((days % 365) / 30);
    return { left, open: false, text: `${years} year${years > 1 ? 's' : ''}` + (months ? ` ${months} month${months > 1 ? 's' : ''}` : '') };
  }
  if (days >= 1) return { left, open: false, text: `${days} day${days > 1 ? 's' : ''}` };
  return { left, open: false, text: `${Math.floor(left / 3600)}h` };
}

// --- the pre-signed release ---------------------------------------------------------------------
//
// Signed at etch time, while the key is in hand, and written to the chain. It carries nLockTime = T
// and a non-final sequence, so nothing relays it early; on the day the lock opens, anybody can
// broadcast it and it can only pay the address the etcher chose. Recovery then needs no key at all.
//
// This lives in the extension because the private half must not leave it. The node side has the
// same builder in src/runes/recover.js, and extension/test-runelock.mjs compares them byte for
// byte: two implementations that disagree about this transaction would be a lock nobody can open.

const NON_FINAL = 0xfffffffe;

function pushData(bytes) {
  if (bytes.length < 0x4c) return verge.concatBytes(new Uint8Array([bytes.length]), bytes);
  if (bytes.length <= 0xff) return verge.concatBytes(new Uint8Array([0x4c, bytes.length]), bytes);
  return verge.concatBytes(new Uint8Array([0x4d, bytes.length & 0xff, bytes.length >> 8]), bytes);
}

/** Minimal CScriptNum, the encoding OP_CHECKLOCKTIMEVERIFY expects. */
function encodeScriptNum(n) {
  if (n === 0) return new Uint8Array(0);
  const bytes = [];
  let abs = Math.abs(n);
  while (abs > 0) { bytes.push(abs & 0xff); abs = Math.floor(abs / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(n < 0 ? 0x80 : 0x00);
  else if (n < 0) bytes[bytes.length - 1] |= 0x80;
  return new Uint8Array(bytes);
}

/** `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG` */
export function lockRedeemScript(locktime, pubkey) {
  return verge.concatBytes(
    pushData(encodeScriptNum(locktime)),
    new Uint8Array([0xb1, 0x75]),
    pushData(pubkey),
    new Uint8Array([0xac]),
  );
}

/** The P2SH address the ticker price is actually paid into. Never the key's ordinary address. */
export async function lockAddress(locktime, pubkey, network) {
  const redeem = lockRedeemScript(locktime, pubkey);
  const h = await verge.hash160(redeem);
  return { redeem, address: await verge.base58CheckEncode(verge.concatBytes(new Uint8Array([network.scriptHash]), h)) };
}

/**
 * Build and sign the release.
 *
 * @param {Uint8Array} privateKey  the lock key, derived
 * @param {object} o  { locktime, txid, vout, value, to, fee, network, time }
 * @returns {Promise<{hex:string, txid:string}>}
 */
export async function buildRelease(privateKey, { locktime, txid, vout, value, to, fee, network, time }) {
  const pubkey = verge.publicKeyFromPrivate(privateKey);
  const redeem = lockRedeemScript(locktime, pubkey);
  const out = value - fee;
  if (out <= 0) throw new Error('the fee leaves nothing of the locked price');

  const tx = {
    version: 1,
    time: time == null ? Math.floor(Date.now() / 1000) : time,
    vin: [{ txid, vout, sequence: NON_FINAL, script: new Uint8Array(0) }],
    vout: [{ value: out, script: await verge.outputScript(to) }],
    locktime,
  };

  const sighash = await verge.legacySighash(tx, 0, redeem, verge.SIGHASH_ALL);
  const sig = await verge.signHashWith(sighash, privateKey, verge.SIGHASH_ALL);
  // A bad signature here is money locked forever with no second chance, so it is checked before it
  // is handed back, against the public key the etching will publish.
  if (!verge.verifySig(sighash, pubkey, sig)) throw new Error('release signature self-check failed');
  tx.vin[0].script = verge.concatBytes(pushData(sig), pushData(redeem));

  return { hex: verge.bytesToHex(verge.serializeTx(tx)), txid: await verge.txid(tx) };
}
