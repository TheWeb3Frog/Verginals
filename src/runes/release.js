'use strict';
// The pre-signed release: how a locked ticker price comes back without anybody keeping a key.
//
// THE IDEA. A ticker price sits in a P2SH CLTV output for 1460 days. Today the etcher has to keep
// a private key alive for four years, and the coins are not at that key's ordinary address, so
// importing it into any other wallet shows a balance of zero. That is the single most likely way
// somebody concludes their money is gone when it is not.
//
// So we sign the spend NOW, at etch time, while the key is in hand and the etcher is paying
// attention, and we write those bytes to the chain. The transaction carries nLockTime = T and a
// non-final sequence, so no node will relay it before the lock opens. On the day it opens, anybody
// at all can broadcast it: a friend, a bot, a block explorer, us. It can only pay the address the
// etcher chose, so publishing it costs nothing and helps everybody.
//
// WHAT THAT BUYS. Recovery stops needing a key. It stops needing our wallet, our server, or any
// software that understands P2SH CLTV. The money lands at an ordinary P2PKH address that every
// Verge wallet already derives from the same twelve words, so a person who migrated to a different
// wallet years earlier just receives a normal payment one day and never learns any of this existed.
//
// WHAT IT COSTS, stated plainly:
//   - The fee is fixed today for a transaction that relays in 2030. Overpay: a few XVG against a
//     2500 XVG lock is under a tenth of a percent, and it clears a far stricter policy than today's.
//   - The destination is fixed at etch time. You can move the coins on the moment they land, but
//     you cannot change your mind about where they land first.
//   - It is not a replacement for the key. Keep the derived key as the fallback, for the day the
//     fee turns out to be too small after all.
//
// verifyRelease() is the load-bearing function here. Before anyone is told they may stop worrying
// about a key, the transaction has to be checked the way a stranger would check it in 2030: parsed
// from its own bytes, with the signature verified against the redeem script found inside it and
// nothing taken on trust from the code that produced it.

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { serializeTx, txid: txidOf, legacySighash, SIGHASH_ALL } = require('../vergetx');
const { NON_FINAL } = require('./recover');

const MAGIC = Buffer.from('VRLS', 'ascii');   // Verge Runes ReLeaSe
const VERSION = 1;

// Verge's relay floor is 0.1 XVG in absolute terms. Four years of policy drift is the whole risk
// this number exists to absorb, so it is deliberately far above what today's node would take. On a
// 2500 XVG ticker price this is 0.08%.
const DEFAULT_FEE = 2 * 1e6;

const hash160 = (b) => crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(b).digest()).digest();

// --- the inscription payload -------------------------------------------------------------------

/** `VRLS | version | raw transaction`. Small, self describing, and readable by anything. */
function encodeRelease(txHex) {
  const raw = Buffer.from(String(txHex), 'hex');
  if (!raw.length) throw new Error('encodeRelease: empty transaction');
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), raw]);
}

/** Read a payload back. Returns null rather than throwing: a stranger's parser meets junk. */
function decodeRelease(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'hex');
  if (b.length < MAGIC.length + 2) return null;
  if (!b.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const version = b[MAGIC.length];
  if (version !== VERSION) return null;
  return { version, txHex: b.subarray(MAGIC.length + 1).toString('hex') };
}

const CONTENT_TYPE = 'application/vnd.verge.runes.release';

// --- reading a Verge transaction back out of its bytes -----------------------------------------

// There is a serializer in src/vergetx.js and there was no parser, because until now nothing had to
// read a transaction it did not build. Verification does: taking the shape on trust from the code
// that wrote it would check nothing at all.
function parseTx(hex) {
  const b = Buffer.from(String(hex), 'hex');
  let o = 0;
  const need = (n) => { if (o + n > b.length) throw new Error('truncated transaction'); };
  const u8 = () => { need(1); return b[o++]; };
  const u32 = () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { need(4); const v = b.readInt32LE(o); o += 4; return v; };
  const u64 = () => { need(8); const v = b.readBigUInt64LE(o); o += 8; return v; };
  const varint = () => {
    const n = u8();
    if (n < 0xfd) return n;
    if (n === 0xfd) { need(2); const v = b.readUInt16LE(o); o += 2; return v; }
    if (n === 0xfe) { need(4); const v = b.readUInt32LE(o); o += 4; return v; }
    need(8); const v = b.readBigUInt64LE(o); o += 8; return Number(v);
  };
  const slice = (n) => { need(n); const v = b.subarray(o, o + n); o += n; return v; };

  const version = i32();
  const time = u32();
  const vin = [];
  for (let i = varint(); i > 0; i--) {
    const txid = Buffer.from(slice(32)).reverse().toString('hex');
    const vout = u32();
    const script = Buffer.from(slice(varint()));
    const sequence = u32();
    vin.push({ txid, vout, script, sequence });
  }
  const vout = [];
  for (let i = varint(); i > 0; i--) {
    const value = u64();
    const script = Buffer.from(slice(varint()));
    vout.push({ value, script });
  }
  const locktime = u32();
  if (o !== b.length) throw new Error('trailing bytes after the transaction');
  return { version, time, vin, vout, locktime };
}

/** Pull the two pushes out of a P2SH scriptSig: the signature, then the script it satisfies. */
function splitScriptSig(script) {
  const out = [];
  let o = 0;
  while (o < script.length) {
    const op = script[o++];
    let len;
    if (op > 0 && op < 0x4c) len = op;
    else if (op === 0x4c) { len = script[o]; o += 1; }
    else if (op === 0x4d) { len = script.readUInt16LE(o); o += 2; }
    else return null;                       // an opcode: not the shape we sign
    if (o + len > script.length) return null;
    out.push(script.subarray(o, o + len));
    o += len;
  }
  return out;
}

/** Read `<locktime> CLTV DROP <pubkey> CHECKSIG` back into its two numbers. */
function parseRedeem(redeem) {
  const parts = [];
  let o = 0;
  const nums = [];
  while (o < redeem.length) {
    const op = redeem[o++];
    if (op > 0 && op < 0x4c) { nums.push(redeem.subarray(o, o + op)); o += op; parts.push('push'); }
    else { parts.push(op); }
  }
  // push(locktime), 0xb1, 0x75, push(pubkey), 0xac
  if (parts.length !== 5) return null;
  if (parts[0] !== 'push' || parts[1] !== 0xb1 || parts[2] !== 0x75 || parts[3] !== 'push' || parts[4] !== 0xac) return null;
  const [numBytes, pubkey] = nums;
  if (pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3)) return null;
  let locktime = 0;
  for (let i = numBytes.length - 1; i >= 0; i--) locktime = locktime * 256 + numBytes[i];
  return { locktime, pubkey };
}

// --- the verifier -------------------------------------------------------------------------------

/**
 * Check a release transaction the way somebody would who found it in 2030 and had never seen this
 * repository: from the raw bytes, plus the two facts the chain itself supplies about the output it
 * spends.
 *
 * @param {string} hex               the release transaction
 * @param {Buffer} lockScriptPubKey  the locked output's script, read off the chain
 * @param {number} lockValue         the locked output's value, in units
 * @param {object} network           bitcoinjs network (for reading the destination address)
 * @returns {{ok:boolean, reason?:string, ...}}
 */
function verifyRelease({ hex, lockScriptPubKey, lockValue, network }) {
  let tx;
  try { tx = parseTx(hex); } catch (e) { return { ok: false, reason: 'unparseable: ' + e.message }; }

  if (tx.vin.length !== 1) return { ok: false, reason: 'a release spends exactly one output' };
  if (tx.vout.length !== 1) return { ok: false, reason: 'a release pays exactly one address' };

  const input = tx.vin[0];
  if (input.sequence === 0xffffffff) return { ok: false, reason: 'the input is final, so nLockTime would be ignored' };

  const pushes = splitScriptSig(input.script);
  if (!pushes || pushes.length !== 2) return { ok: false, reason: 'the scriptSig is not signature plus redeem script' };
  const [sigWithHashType, redeem] = pushes;

  const parsed = parseRedeem(redeem);
  if (!parsed) return { ok: false, reason: 'the redeem script is not a CLTV lock' };
  const { locktime, pubkey } = parsed;

  // The redeem script must be the one the locked output committed to. This is what ties the
  // transaction to the money; without it a valid signature over some other script proves nothing.
  const spk = Buffer.isBuffer(lockScriptPubKey) ? lockScriptPubKey : Buffer.from(String(lockScriptPubKey), 'hex');
  const expected = Buffer.concat([Buffer.from([0xa9, 0x14]), hash160(redeem), Buffer.from([0x87])]);
  if (!spk.equals(expected)) return { ok: false, reason: 'this release does not open that lock' };

  if (tx.locktime < locktime) return { ok: false, reason: 'nLockTime is below the lock, the node would refuse it' };

  // The signature, checked against the pubkey found inside the redeem script and a sighash
  // recomputed from the transaction's own bytes.
  let decoded;
  try { decoded = bitcoin.script.signature.decode(sigWithHashType); }
  catch (e) { return { ok: false, reason: 'the signature is not canonical DER' }; }
  if (decoded.hashType !== SIGHASH_ALL) return { ok: false, reason: 'unexpected sighash type ' + decoded.hashType };

  const sighash = legacySighash(tx, 0, redeem, SIGHASH_ALL);
  if (!ecc.verify(sighash, pubkey, decoded.signature)) return { ok: false, reason: 'the signature does not verify' };

  const out = tx.vout[0];
  const value = Number(out.value);
  const fee = Number(lockValue) - value;
  if (fee <= 0) return { ok: false, reason: 'the release pays no fee, so nothing will relay it' };

  let to = null;
  try { to = bitcoin.address.fromOutputScript(out.script, network); } catch (e) { /* not a standard form */ }
  if (!to) return { ok: false, reason: 'the destination is not an address any wallet can receive at' };
  // The whole point is that the money lands somewhere an ordinary wallet already watches, so a
  // release that pays into another script is a release nobody benefits from.
  const isP2PKH = out.script.length === 25 && out.script[0] === 0x76 && out.script[1] === 0xa9 && out.script[23] === 0x88 && out.script[24] === 0xac;
  if (!isP2PKH) return { ok: false, reason: 'the destination is not an ordinary address' };

  return {
    ok: true,
    txid: txidOf(tx),
    locktime,
    opensAt: new Date(locktime * 1000).toISOString(),
    to,
    value,
    fee,
    pubkey: pubkey.toString('hex'),
    spends: { txid: input.txid, vout: input.vout },
  };
}

// --- putting it on the chain, and finding it again -----------------------------------------------

/**
 * The inscription that carries a release.
 *
 * The platform already writes arbitrary bytes into a P2SH redeem script as dead code
 * (`OP_FALSE OP_IF ... OP_ENDIF`, src/envelope.js), which is how every Verginal is inscribed. A
 * release is 209 bytes, so it is a small one. Nothing new had to be invented for storage.
 *
 * @returns {{contentType:string, body:Buffer}} ready for buildInscriptionScripts
 */
function releaseInscription(txHex) {
  return { contentType: CONTENT_TYPE, body: encodeRelease(txHex) };
}

/**
 * Pull a release out of whatever an inscription reader handed back.
 *
 * Deliberately forgiving about the shape: in four years the thing reading this may not be our code,
 * and refusing a valid release because the wrapper looked unfamiliar is the failure this whole
 * design exists to prevent. It accepts a Buffer, a hex string, a base64 string, or an object with
 * a `body`/`content` field, and returns null for anything that is not a release.
 */
function readInscribedRelease(content) {
  if (!content) return null;
  if (typeof content === 'object' && !Buffer.isBuffer(content)) {
    return readInscribedRelease(content.body || content.content || content.data || null);
  }
  let buf = null;
  if (Buffer.isBuffer(content)) buf = content;
  else {
    const s = String(content).trim();
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) buf = Buffer.from(s, 'hex');
    else { try { buf = Buffer.from(s, 'base64'); } catch (_) { return null; } }
  }
  return decodeRelease(buf);
}

module.exports = {
  MAGIC, VERSION, CONTENT_TYPE, DEFAULT_FEE, NON_FINAL,
  encodeRelease, decodeRelease, parseTx, splitScriptSig, parseRedeem, verifyRelease,
  releaseInscription, readInscribedRelease,
};
