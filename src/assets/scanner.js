'use strict';
// Verge Assets: turning real chain data into the shape the state machine expects (ASSETS-PLAN §2.1).
//
// This is the only place that knows what a Verge RPC transaction looks like. Everything downstream
// (indexer.js, checkpoint.js) stays pure, so the protocol rules can be reasoned about and tested
// without a node. Keeping the boundary here is what lets two independent implementations agree.

const codec = require('./codec');
const cbor = require('../cbor');
const { parseInscriptionScript } = require('../envelope');
const { extractRedeemScript } = require('../rpc');

/** The content type that marks an inscription as an asset etching (spec §1). */
const ETCH_CONTENT_TYPE = 'application/vnd.verge-asset+cbor';

/**
 * Coerce a decoded CBOR byte string to a Buffer. The project's CBOR decoder hands byte strings back
 * as a plain object with numeric keys rather than a Buffer, so accept that shape too. Returns null
 * for anything that is not a clean byte sequence, and callers must treat null as "unreadable".
 */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v && typeof v === 'object') {
    const vals = Object.values(v);
    if (vals.length && vals.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(vals);
  }
  return null;
}

/**
 * Find an asset etching in a reveal transaction.
 *
 * An etching is an ordinary inscription whose content type is ETCH_CONTENT_TYPE, so this reuses the
 * existing envelope parser rather than inventing a second one: the body may be split across several
 * P2SH inputs and is concatenated in input order, exactly as the inscription indexer does it.
 *
 * Returns the etching in the shape the state machine expects, or null. A malformed body returns null
 * rather than throwing: an unreadable etching must be ignored, never fatal.
 */
function detectEtching(tx) {
  let contentType = null;
  const chunks = [];
  let found = false;
  for (const vin of tx.vin || []) {
    const redeem = extractRedeemScript(vin.scriptSig);
    if (!redeem) continue;
    const parsed = parseInscriptionScript(redeem);
    if (!parsed) continue;
    found = true;
    // The envelope parser hands back the content type as raw bytes, not a string.
    if (contentType === null && parsed.contentType) contentType = Buffer.from(parsed.contentType).toString('utf8');
    chunks.push(parsed.body);
  }
  if (!found || contentType !== ETCH_CONTENT_TYPE) return null;

  let body;
  try { body = cbor.decode(Buffer.concat(chunks)); } catch { return null; }
  if (!body || typeof body !== 'object') return null;

  // Short CBOR keys back to readable fields (spec §2.1).
  const etching = {
    ticker: body.t, name: body.n, divisibility: body.d, supply: body.s, premine: body.p,
  };
  if (body.m) {
    etching.terms = { amount: body.m.a };
    if (body.m.c != null) etching.terms.cap = body.m.c;
    if (body.m.h0 != null) etching.terms.openHeight = body.m.h0;
    if (body.m.h1 != null) etching.terms.closeHeight = body.m.h1;
  }
  if (body.a != null) {
    // A gated mint whose gate cannot be read must NOT be registered as an open one: dropping an
    // unreadable allowlist would quietly turn a whitelist-only drop into a free-for-all.
    const root = toBuffer(body.a);
    if (!root || root.length !== 32) return null;
    etching.allowlistRoot = root;
  }
  if (body.i) etching.metadataRef = body.i;
  if (body.k) etching.parent = body.k;
  return etching;
}

/** Is this output an OP_RETURN, and what does it carry? scriptPubKey.hex starts with 6a (OP_RETURN). */
function readOpReturn(vout) {
  const spk = vout.scriptPubKey || {};
  const hex = spk.hex || '';
  if (!hex.startsWith('6a')) return null;
  // 6a <pushopcode> <data>. Handle the direct push (<=75 bytes) and OP_PUSHDATA1, which is all an
  // 83-byte payload can ever need.
  const buf = Buffer.from(hex, 'hex');
  let off = 1;
  if (off >= buf.length) return Buffer.alloc(0);
  const op = buf[off];
  if (op <= 75) { off += 1; }
  else if (op === 0x4c) { off += 2; }      // OP_PUSHDATA1
  else return Buffer.alloc(0);             // anything larger cannot be one of our messages
  return buf.slice(off);
}

/**
 * Convert one RPC transaction into the applyTx() shape.
 *
 * @param {Object} tx      verbose getrawtransaction / block tx
 * @param {number} height
 * @param {number} txIndex position in the block
 * @param {Object} [opts]  { etching } when this tx also carries an asset inscription
 */
function toIndexerTx(tx, height, txIndex, opts = {}) {
  const inputs = (tx.vin || [])
    .filter((i) => i.txid) // a coinbase has no previous output
    .map((i) => ({ txid: i.txid, vout: i.vout, scriptPubKey: i.scriptPubKey ? Buffer.from(i.scriptPubKey.hex || '', 'hex') : null }));

  const outputs = (tx.vout || []).map((o) => {
    const data = readOpReturn(o);
    const addresses = (o.scriptPubKey && o.scriptPubKey.addresses) || [];
    return {
      value: Math.round(Number(o.value) * 1e6),
      scriptPubKey: Buffer.from((o.scriptPubKey && o.scriptPubKey.hex) || '', 'hex'),
      address: addresses.length === 1 ? addresses[0] : null,
      isOpReturn: data !== null,
      opReturnData: data || undefined,
    };
  });

  // An etching passed in by the caller wins; otherwise look for one in this transaction's
  // inscription envelope, so a scan needs no outside help to find new assets.
  const extra = Object.assign({}, opts);
  if (!extra.etching) {
    const found = detectEtching(tx);
    if (found) extra.etching = found;
  }
  return Object.assign({ txid: tx.txid, height, txIndex, inputs, outputs }, extra);
}

/** True when a transaction carries something this protocol should look at (cheap pre-filter). */
function isRelevant(tx) {
  return (tx.vout || []).some((o) => {
    const d = readOpReturn(o);
    return d !== null && codec.decode(d) !== null;
  });
}

/**
 * Scan a range of blocks and apply every transaction, in order, to the given state.
 *
 * @param {Object} chain  { getBlockHash(h), getBlock(hash, verbosity) }
 * @param {AssetState} state
 * @param {number} from   first height (inclusive)
 * @param {number} to     last height (inclusive)
 * @param {Function} applyTx
 * @param {Object} [opts] { etchingsByTxid } to inject etchings resolved from inscriptions
 */
async function scanRange(chain, state, from, to, applyTx, opts = {}) {
  const etchings = opts.etchingsByTxid || {};
  let applied = 0;
  for (let h = from; h <= to; h++) {
    const hash = await chain.getBlockHash(h);
    const block = await chain.getBlock(hash, 2); // verbosity 2 = full transactions
    (block.tx || []).forEach((tx, i) => {
      const etching = etchings[tx.txid];
      // Everything is applied, not just "relevant" transactions: an ordinary send still MOVES a
      // balance through the default assignment, and skipping it would silently lose funds.
      applyTx(state, toIndexerTx(tx, h, i, etching ? { etching } : {}), opts);
      applied += 1;
    });
  }
  return { applied, height: to };
}

module.exports = { ETCH_CONTENT_TYPE, readOpReturn, detectEtching, toIndexerTx, isRelevant, scanRange };
