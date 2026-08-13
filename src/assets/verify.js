'use strict';
// Verge Assets: a SECOND implementation of the state machine, written from ASSETS-SPEC-v0 alone.
//
// Why this file exists. Checkpoints (checkpoint.js) are only worth anything if independent indexers
// can be shown to agree; with a single implementation, a root proves nothing except that the code
// agrees with itself. This is a deliberate re-derivation, and it is built to fail DIFFERENTLY:
//
//   indexer.js  mutable Maps, balances updated in place, state carried forward
//   verify.js   an append-only journal of deltas, folded into balances only when asked
//
// The architectures share no data structure, so a structural mistake in one is unlikely to be
// mirrored in the other. test/assets-conformance.test.js drives both over randomised histories and
// compares their roots.
//
// HONEST LIMITATION, stated here rather than in a commit message: both files were written by the
// same author, from the same reading of the spec. This catches implementation slips, not a shared
// misunderstanding of the specification. A genuinely independent implementation, by someone else,
// remains a launch requirement.

const codec = require('./codec');

const OP = (txid, vout) => `${txid}:${vout}`;

/**
 * The journal: an ordered list of { outpoint, assetRef, delta } records plus asset definitions.
 * Balances are never stored, they are derived. Replaying the journal in a different order would
 * give a different answer, so order is the only state that matters.
 */
class Journal {
  constructor() {
    this.records = [];
    this.definitions = new Map(); // assetRef -> definition
    this.tickerOwner = new Map(); // TICKER -> assetRef
    this.issued = new Map();      // assetRef -> { minted, mintCount }
  }

  record(outpoint, assetRef, delta) {
    if (delta !== 0) this.records.push({ outpoint, assetRef, delta });
  }

  /** Fold the journal down to live balances. */
  balances() {
    const acc = new Map(); // outpoint -> Map(assetRef -> amount)
    for (const r of this.records) {
      let m = acc.get(r.outpoint);
      if (!m) { m = new Map(); acc.set(r.outpoint, m); }
      const next = (m.get(r.assetRef) || 0) + r.delta;
      if (next === 0) m.delete(r.assetRef); else m.set(r.assetRef, next);
      if (m.size === 0) acc.delete(r.outpoint);
    }
    return acc;
  }

  /** Same sorted (outpoint, assetRef, amount) stream the checkpoint tree consumes. */
  *entries() {
    const acc = this.balances();
    for (const outpoint of [...acc.keys()].sort()) {
      const m = acc.get(outpoint);
      for (const assetRef of [...m.keys()].sort((a, b) => a - b)) {
        yield { outpoint, assetRef, amount: m.get(assetRef) };
      }
    }
  }

  balanceOf(outpoint, assetRef) {
    const m = this.balances().get(outpoint);
    return (m && m.get(assetRef)) || 0;
  }
}

const refOf = (height, txIndex) => height * 1000 + txIndex;

/** Spec §2.1 validity. Anything failing this is not an asset. */
function validDefinition(e) {
  const ticker = String(e.ticker || '').toUpperCase();
  if (!/^[A-Z0-9]{1,26}$/.test(ticker)) return null;
  const d = Number(e.divisibility || 0);
  const s = Number(e.supply || 0);
  const p = Number(e.premine || 0);
  if (![d, s, p].every(Number.isInteger)) return null;
  if (d < 0 || d > 6) return null;
  if (s < 0 || p < 0 || p > s) return null;
  return {
    ticker, supply: s, premine: p, divisibility: d,
    terms: e.terms || null, allowlistRoot: e.allowlistRoot || null,
  };
}

/** Spec §4: the first decodable message among the OP_RETURN outputs. */
function messageOf(tx) {
  for (const o of tx.outputs || []) {
    if (!o.isOpReturn || !o.opReturnData) continue;
    const m = codec.decode(o.opReturnData);
    if (m) return m;
  }
  return null;
}

/** Spec §5. */
function allowlistOk(tx, def) {
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest();
  const p = tx.allowlistProof;
  if (!p || !Array.isArray(p.path) || !Buffer.isBuffer(p.scriptPubKey)) return false;
  const spends = (tx.inputs || []).some((i) => i.scriptPubKey
    && Buffer.compare(Buffer.from(i.scriptPubKey), p.scriptPubKey) === 0);
  if (!spends) return false;
  let node = sha(Buffer.concat([p.scriptPubKey, Buffer.from(String(p.maxAmount || 0))]));
  for (const sib of p.path) {
    node = Buffer.compare(node, sib) <= 0 ? sha(Buffer.concat([node, sib])) : sha(Buffer.concat([sib, node]));
  }
  return Buffer.isBuffer(def.allowlistRoot) && node.equals(def.allowlistRoot);
}

/**
 * Apply one transaction to the journal. Mirrors ASSETS-SPEC-v0 §2-§5 step by step, but arrives
 * there by a different route from indexer.js.
 */
function apply(journal, tx, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : 100000;

  // (a) drain the inputs into a pool, recording the negative deltas
  const pooled = new Map();
  for (const i of tx.inputs || []) {
    const op = OP(i.txid, i.vout);
    const held = journal.balances().get(op);
    if (!held) continue;
    for (const [ref, amt] of held) {
      pooled.set(ref, (pooled.get(ref) || 0) + amt);
      journal.record(op, ref, -amt);
    }
  }

  // (b) an etching, if the ticker is free
  if (tx.etching) {
    const ref = refOf(tx.height, tx.txIndex);
    const def = validDefinition(tx.etching);
    if (def && !journal.tickerOwner.has(def.ticker)) {
      journal.definitions.set(ref, def);
      journal.tickerOwner.set(def.ticker, ref);
      journal.issued.set(ref, { minted: 0, mintCount: 0 });
      if (def.premine > 0) pooled.set(ref, (pooled.get(ref) || 0) + def.premine);
    }
  }

  const message = messageOf(tx);

  // (c) an open mint
  if (message && message.type === 'mint') {
    const def = journal.definitions.get(message.assetRef);
    const iss = journal.issued.get(message.assetRef);
    const t = def && def.terms;
    const per = t ? Number(t.amount || 0) : 0;
    const withinWindow = t
      && (t.openHeight == null || tx.height >= t.openHeight)
      && (t.closeHeight == null || tx.height <= t.closeHeight);
    const underCap = t && (t.cap == null || iss.mintCount < t.cap);
    const underSupply = def && (def.premine + iss.minted + per <= def.supply);
    const gateOk = !def || !def.allowlistRoot || allowlistOk(tx, def);
    if (def && per > 0 && withinWindow && underCap && underSupply && gateOk) {
      iss.minted += per;
      iss.mintCount += 1;
      pooled.set(message.assetRef, (pooled.get(message.assetRef) || 0) + per);
    }
  }

  // (d) outputs that may hold a balance
  const eligible = [];
  (tx.outputs || []).forEach((o, i) => { if (!o.isOpReturn && o.value >= dust) eligible.push(i); });

  // (e) edicts
  if (message && message.type === 'edicts') {
    for (const e of message.edicts) {
      const have = pooled.get(e.assetRef) || 0;
      if (have <= 0 || !eligible.includes(e.output)) continue;
      const move = e.amount === 0 ? have : Math.min(e.amount, have);
      journal.record(OP(tx.txid, e.output), e.assetRef, move);
      pooled.set(e.assetRef, have - move);
    }
  }

  // (f) the remainder, or a burn when there is nowhere for it to go
  const fallback = eligible.length ? eligible[0] : null;
  if (fallback !== null) {
    for (const [ref, amt] of pooled) if (amt > 0) journal.record(OP(tx.txid, fallback), ref, amt);
  }
  return journal;
}

/** Replay a history. Returns a Journal, which exposes the same entries() the checkpoint tree wants. */
function index(txs, opts = {}) {
  const journal = new Journal();
  for (const tx of txs) apply(journal, tx, opts);
  return journal;
}

module.exports = { Journal, apply, index, refOf };
