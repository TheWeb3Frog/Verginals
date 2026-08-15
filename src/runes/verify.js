'use strict';
// Verge Runes: a SECOND implementation of the state machine, written from RUNES-SPEC-v0 alone.
//
// Why this file exists. Checkpoints (checkpoint.js) are only worth anything if independent indexers
// can be shown to agree; with a single implementation, a root proves nothing except that the code
// agrees with itself. This is a deliberate re-derivation, and it is built to fail DIFFERENTLY:
//
//   indexer.js  mutable Maps, balances updated in place, state carried forward
//   verify.js   an append-only journal of deltas, folded into balances only when asked
//
// The architectures share no data structure, so a structural mistake in one is unlikely to be
// mirrored in the other. test/runes-conformance.test.js drives both over randomised histories and
// compares their roots.
//
// HONEST LIMITATION, stated here rather than in a commit message: both files were written by the
// same author, from the same reading of the spec. This catches implementation slips, not a shared
// misunderstanding of the specification. A genuinely independent implementation, by someone else,
// remains a launch requirement.

const codec = require('./codec');

const OP = (txid, vout) => `${txid}:${vout}`;

/**
 * The journal: an ordered list of { outpoint, runeRef, delta } records plus rune definitions.
 * Balances are never stored, they are derived. Replaying the journal in a different order would
 * give a different answer, so order is the only state that matters.
 */
class Journal {
  constructor() {
    this.records = [];
    this.definitions = new Map(); // runeRef -> definition
    this.tickerOwner = new Map(); // TICKER -> runeRef
    this.issued = new Map();      // runeRef -> { minted, mintCount }
  }

  record(outpoint, runeRef, delta) {
    if (delta !== 0) this.records.push({ outpoint, runeRef, delta });
  }

  /** Fold the journal down to live balances. */
  balances() {
    const acc = new Map(); // outpoint -> Map(runeRef -> amount)
    for (const r of this.records) {
      let m = acc.get(r.outpoint);
      if (!m) { m = new Map(); acc.set(r.outpoint, m); }
      const next = (m.get(r.runeRef) || 0) + r.delta;
      if (next === 0) m.delete(r.runeRef); else m.set(r.runeRef, next);
      if (m.size === 0) acc.delete(r.outpoint);
    }
    return acc;
  }

  /** Same sorted (outpoint, runeRef, amount) stream the checkpoint tree consumes. */
  *entries() {
    const acc = this.balances();
    for (const outpoint of [...acc.keys()].sort()) {
      const m = acc.get(outpoint);
      for (const runeRef of [...m.keys()].sort((a, b) => a - b)) {
        yield { outpoint, runeRef, amount: m.get(runeRef) };
      }
    }
  }

  balanceOf(outpoint, runeRef) {
    const m = this.balances().get(outpoint);
    return (m && m.get(runeRef)) || 0;
  }
}

const refOf = (height, txIndex) => height * 1000 + txIndex;

/** Spec §2.1 validity. Anything failing this is not a rune. */
function validDefinition(e) {
  const ticker = String(e.ticker || '').toUpperCase();
  if (!/^[A-Z0-9]{1,26}$/.test(ticker)) return null;
  const d = Number(e.divisibility || 0);
  const s = Number(e.supply || 0);
  const p = Number(e.premine || 0);
  if (![d, s, p].every(Number.isInteger)) return null;
  if (d < 0 || d > 6) return null;
  if (s < 0 || p < 0 || p > s) return null;
  // §7.1, re-derived: bits are only meaningful in the gaps between characters, and anything past
  // the end is masked off rather than rejected.
  const raw = Number(e.spacers) || 0;
  const spacers = raw > 0 ? raw & ((1 << Math.max(0, ticker.length - 1)) - 1) : 0;
  return {
    ticker, supply: s, premine: p, divisibility: d, spacers,
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

// --- §7.2, re-derived ----------------------------------------------------------------------------
//
// Deliberately not calling tickers.js. Sharing that code would make a slip in it invisible to the
// conformance harness, and the price schedule plus the script shape are exactly the sort of thing
// two implementations must agree on independently or the ticker namespace splits.

const LOCK_SECONDS_V = 126144000;
const LOCK_GRACE_V = 86400;
const SCHEDULE_V = [0, 100000, 50000, 25000, 10000, 5000, 2500, 1000, 500, 250, 100, 50];

function priceUnits(ticker) {
  const n = ticker.length;
  const xvg = n >= 12 ? 10 : SCHEDULE_V[n];
  return xvg == null ? null : Math.round(xvg * 1e6);
}

/** Rebuild the output the etching's `l` field commits to, then read the transaction for it. */
function lockedEnough(tx, ticker, lock) {
  const owed = priceUnits(ticker);
  if (owed == null || !lock) return false;
  const key = Buffer.isBuffer(lock.k) ? lock.k : null;
  const when = Number(lock.t);
  if (!key || key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) return false;
  if (!Number.isInteger(when) || when < 500000000) return false;

  const stamp = Number(tx.time || 0);
  if (!stamp || when < stamp + LOCK_SECONDS_V - LOCK_GRACE_V) return false;

  // <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG, wrapped in P2SH.
  const num = [];
  let rest = when;
  while (rest > 0) { num.push(rest & 0xff); rest = Math.floor(rest / 256); }
  if (num[num.length - 1] & 0x80) num.push(0);
  const redeem = Buffer.concat([
    Buffer.from([num.length]), Buffer.from(num),
    Buffer.from([0xb1, 0x75]),
    Buffer.from([key.length]), key,
    Buffer.from([0xac]),
  ]);
  const crypto = require('crypto');
  const h = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(redeem).digest()).digest();
  const spk = Buffer.concat([Buffer.from([0xa9, 0x14]), h, Buffer.from([0x87])]);

  let paid = 0;
  for (const o of tx.outputs || []) {
    if (o.scriptPubKey && Buffer.isBuffer(o.scriptPubKey) && o.scriptPubKey.equals(spk)) paid += o.value;
  }
  return paid >= owed;
}

/** §2.2: a priced mint owes its price in transaction fee, and an unknown fee is not a paid one. */
function feeCovers(tx, terms) {
  const price = Number((terms && terms.price) || 0);
  if (!(price > 0)) return true;
  return typeof tx.fee === 'number' && Number.isFinite(tx.fee) && tx.fee >= price;
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
 * Apply one transaction to the journal. Mirrors RUNES-SPEC-v0 §2-§5 step by step, but arrives
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
    if (def && lockedEnough(tx, def.ticker, tx.etching.lock) && !journal.tickerOwner.has(def.ticker)) {
      journal.definitions.set(ref, def);
      journal.tickerOwner.set(def.ticker, ref);
      journal.issued.set(ref, { minted: 0, mintCount: 0 });
      if (def.premine > 0) pooled.set(ref, (pooled.get(ref) || 0) + def.premine);
    }
  }

  const message = messageOf(tx);

  // (c) an open mint
  if (message && message.type === 'mint') {
    const def = journal.definitions.get(message.runeRef);
    const iss = journal.issued.get(message.runeRef);
    const t = def && def.terms;
    const per = t ? Number(t.amount || 0) : 0;
    const withinWindow = t
      && (t.openHeight == null || tx.height >= t.openHeight)
      && (t.closeHeight == null || tx.height <= t.closeHeight);
    const underCap = t && (t.cap == null || iss.mintCount < t.cap);
    const underSupply = def && (def.premine + iss.minted + per <= def.supply);
    const gateOk = !def || !def.allowlistRoot || allowlistOk(tx, def);
    const feeOk = feeCovers(tx, t);
    if (def && per > 0 && withinWindow && underCap && underSupply && gateOk && feeOk) {
      iss.minted += per;
      iss.mintCount += 1;
      pooled.set(message.runeRef, (pooled.get(message.runeRef) || 0) + per);
    }
  }

  // (d) outputs that may hold a balance
  const eligible = [];
  (tx.outputs || []).forEach((o, i) => { if (!o.isOpReturn && o.value >= dust) eligible.push(i); });

  // (e) edicts
  if (message && message.type === 'edicts') {
    for (const e of message.edicts) {
      const have = pooled.get(e.runeRef) || 0;
      if (have <= 0 || !eligible.includes(e.output)) continue;
      const move = e.amount === 0 ? have : Math.min(e.amount, have);
      journal.record(OP(tx.txid, e.output), e.runeRef, move);
      pooled.set(e.runeRef, have - move);
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
