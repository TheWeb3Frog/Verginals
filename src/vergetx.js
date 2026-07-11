'use strict';
// Verge transaction primitives: serialization, txid, and the LEGACY sighash.
//
// Verge does NOT use Bitcoin's segwit/BIP144 wire format. A Verge transaction is:
//     [int32 nVersion][uint32 nTime][vin][vout][uint32 nLockTime]
// i.e. the classic format with a PoS-style 4-byte nTime inserted after the version, and NO
// witness/marker/flag (CTxIn serializes only prevout/scriptSig/nSequence, witness data is
// never put on the wire). Verified byte-identical against on-chain testnet txs.
//
// Because witness is unusable, inscriptions are revealed via a P2SH redeemScript in the
// scriptSig (see builder.js), and inputs are signed with the LEGACY sighash. On Verge that
// sighash also includes nTime after the version (interpreter.cpp CTransactionSignatureSerializer),
// so bitcoinjs's hashForSignature does NOT apply here; this is the authoritative implementation.

const crypto = require('crypto');

const SIGHASH_ALL = 0x01;
const SIGHASH_NONE = 0x02;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_ANYONECANPAY = 0x80;

function dsha256(buf) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
}

/** CompactSize / varint encoder. */
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.allocUnsafe(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.allocUnsafe(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.allocUnsafe(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

/** length-prefixed script (or any byte string). */
function withLength(buf) {
  return Buffer.concat([varint(buf.length), buf]);
}

/**
 * Serialize one input. `script` is the scriptSig (empty for unsigned / non-signed inputs
 * during sighash). txid is the usual big-endian hex; serialized little-endian on the wire.
 */
function serializeInput(inp) {
  const prevTxid = Buffer.from(inp.txid, 'hex').reverse();
  const vout = Buffer.allocUnsafe(4);
  vout.writeUInt32LE(inp.vout >>> 0);
  const script = inp.script && inp.script.length ? inp.script : Buffer.alloc(0);
  const seq = Buffer.allocUnsafe(4);
  seq.writeUInt32LE((inp.sequence == null ? 0xffffffff : inp.sequence) >>> 0);
  return Buffer.concat([prevTxid, vout, withLength(script), seq]);
}

/** Serialize one output. `value` is in atomic units (integer). */
function serializeOutput(out) {
  const value = Buffer.allocUnsafe(8);
  value.writeBigInt64LE(BigInt(out.value));
  return Buffer.concat([value, withLength(out.script)]);
}

/**
 * Serialize a Verge transaction.
 * @param {{version?:number, time:number, vin:Array, vout:Array, locktime?:number}} tx
 * @returns {Buffer}
 */
function serializeTx(tx) {
  const ver = Buffer.allocUnsafe(4);
  ver.writeInt32LE(tx.version == null ? 1 : tx.version);
  const time = Buffer.allocUnsafe(4);
  time.writeUInt32LE(tx.time >>> 0);
  const lock = Buffer.allocUnsafe(4);
  lock.writeUInt32LE((tx.locktime || 0) >>> 0);
  return Buffer.concat([
    ver,
    time,
    varint(tx.vin.length),
    ...tx.vin.map(serializeInput),
    varint(tx.vout.length),
    ...tx.vout.map(serializeOutput),
    lock,
  ]);
}

/** Transaction id (big-endian hex), = reverse(dSHA256(serialize(tx))). */
function txid(tx) {
  return Buffer.from(dsha256(serializeTx(tx))).reverse().toString('hex');
}

/**
 * Legacy signature hash for input `nIn`, signing against `scriptCode` (the redeemScript for a
 * P2SH input, the scriptPubKey for a P2PKH one). Full legacy semantics, mirroring Verge's
 * CTransactionSignatureSerializer (Bitcoin's, plus nTime after the version):
 *   - ALL:    every input (scriptCode on nIn, empty elsewhere) and every output are committed.
 *   - NONE:   no outputs; other inputs keep their prevouts but their nSequence is zeroed.
 *   - SINGLE: only the output at index nIn is committed; earlier outputs serialize as null
 *             (value -1, empty script) so the completer may set them freely; other inputs'
 *             nSequence is zeroed. nIn beyond the outputs reproduces the historical
 *             "SIGHASH_SINGLE bug" (the hash is uint256(1)), kept for consensus fidelity.
 *   - ANYONECANPAY (flag): only input nIn is serialized, so anyone may add inputs.
 * SINGLE|ANYONECANPAY is what a marketplace listing signs: it pins "my coin moves only in a
 * transaction that pays output nIn exactly as written", everything else is the buyer's to build.
 * @returns {Buffer} 32-byte hash to ECDSA-sign
 */
function legacySighash(tx, nIn, scriptCode, hashType = SIGHASH_ALL) {
  const base = hashType & 0x1f;
  const anyoneCanPay = !!(hashType & SIGHASH_ANYONECANPAY);
  if (base !== SIGHASH_ALL && base !== SIGHASH_NONE && base !== SIGHASH_SINGLE) {
    throw new Error('legacySighash: unknown base hash type ' + base);
  }
  // The historical SIGHASH_SINGLE bug: signing input nIn with no matching output hashes the
  // constant 1. Never build such a transaction; replicated only so verification matches consensus.
  if (base === SIGHASH_SINGLE && nIn >= tx.vout.length) {
    const one = Buffer.alloc(32);
    one[0] = 0x01;
    return one;
  }

  let vin = tx.vin.map((inp, i) => ({
    txid: inp.txid,
    vout: inp.vout,
    // For NONE/SINGLE the other inputs' sequences are zeroed so the completer may change them.
    sequence: i === nIn || base === SIGHASH_ALL ? inp.sequence : 0,
    script: i === nIn ? scriptCode : Buffer.alloc(0),
  }));
  if (anyoneCanPay) vin = [vin[nIn]];

  let vout;
  if (base === SIGHASH_NONE) {
    vout = [];
  } else if (base === SIGHASH_SINGLE) {
    const NULL_OUT = { value: -1n, script: Buffer.alloc(0) };
    vout = tx.vout.slice(0, nIn + 1).map((o, i) => (i === nIn ? o : NULL_OUT));
  } else {
    vout = tx.vout;
  }

  const ser = serializeTx({ version: tx.version, time: tx.time, vin, vout, locktime: tx.locktime });
  const ht = Buffer.allocUnsafe(4);
  ht.writeUInt32LE(hashType >>> 0);
  return dsha256(Buffer.concat([ser, ht]));
}

module.exports = {
  SIGHASH_ALL,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_ANYONECANPAY,
  dsha256,
  varint,
  withLength,
  serializeInput,
  serializeOutput,
  serializeTx,
  txid,
  legacySighash,
};
