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
    this.gateUsed = new Map();    // `${runeRef}|${leafHex}` -> units already taken (§5)
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
      for (const runeRef of [...m.keys()].sort(orderRefs)) {
        yield { outpoint, runeRef, amount: m.get(runeRef) };
      }
    }
  }

  /** §8: a checkpoint commits to what a reference means, not only to how much of it sits where. */
  *runeEntries() {
    for (const runeRef of [...this.definitions.keys()].sort(orderRefs)) {
      const d = this.definitions.get(runeRef);
      yield { runeRef, ticker: d.ticker, divisibility: d.divisibility, supply: d.supply, spacers: d.spacers };
    }
  }

  balanceOf(outpoint, runeRef) {
    const m = this.balances().get(outpoint);
    return (m && m.get(runeRef)) || 0;
  }
}

// §4.1, re-derived. A reference is the PAIR (height, txIndex), written as one canonical string and
// never folded into a single number: any packing `height * K + txIndex` collides as soon as a block
// holds K transactions, and the pair has no such cliff to choose a constant against.
const refOf = (height, txIndex) => `${height}:${txIndex}`;

/** Order references by height, then by position. Never by string comparison: "100:1" < "99:2". */
function orderRefs(a, b) {
  const x = String(a).split(':');
  const y = String(b).split(':');
  return (Number(x[0]) - Number(y[0])) || (Number(x[1]) - Number(y[1]));
}

/** §2.2, re-derived: terms are numbers or they are not terms. Undefined means "present but unusable". */
function validTerms(t) {
  if (t == null) return null;
  if (typeof t !== 'object') return undefined;
  const ok = (v) => Number.isInteger(v) && v >= 0;
  if (!Number.isInteger(t.amount) || t.amount < 1) return undefined;
  const out = { amount: t.amount };
  for (const [from, to] of [['cap', 'cap'], ['openHeight', 'openHeight'], ['closeHeight', 'closeHeight'], ['price', 'price']]) {
    if (t[from] == null) continue;
    if (!ok(t[from])) return undefined;
    out[to] = t[from];
  }
  if (out.openHeight != null && out.closeHeight != null && out.closeHeight < out.openHeight) return undefined;
  return out;
}

/** Spec §2.1 validity. Anything failing this is not a rune. */
function validDefinition(e) {
  const ticker = String(e.ticker || '').toUpperCase();
  if (!/^[A-Z]{1,26}$/.test(ticker)) return null;
  const d = Number(e.divisibility || 0);
  const s = Number(e.supply || 0);
  const p = Number(e.premine || 0);
  if (![d, s, p].every(Number.isInteger)) return null;
  if (d < 0 || d > 6) return null;
  if (s < 0 || p < 0 || p > s) return null;
  const terms = validTerms(e.terms);
  if (terms === undefined) return null;
  const root = e.allowlistRoot || null;
  if (root !== null && (!Buffer.isBuffer(root) || root.length !== 32)) return null;
  // §7.1, re-derived: bits are only meaningful in the gaps between characters, and anything past
  // the end is masked off rather than rejected. Arithmetic, not `&`, so a long name cannot wrap
  // around the 32-bit boundary that JS bitwise operators impose.
  const raw = Number(e.spacers);
  const gaps = Math.min(Math.max(0, ticker.length - 1), 31);
  const spacers = (Number.isInteger(raw) && raw > 0 && gaps > 0) ? raw % Math.pow(2, gaps) : 0;
  return { ticker, supply: s, premine: p, divisibility: d, spacers, terms, allowlistRoot: root };
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

  // Every paying output must carry a readable whole number of units. Summing blindly and comparing
  // is not enough: one output with a fractional value would push the total over the price without
  // anyone having paid it, and one with a value that is not a number at all makes the comparison
  // meaningless. A payment check fails closed or it is not a payment check.
  let paid = 0;
  for (const o of tx.outputs || []) {
    if (!o.scriptPubKey || !Buffer.isBuffer(o.scriptPubKey) || !o.scriptPubKey.equals(spk)) continue;
    if (!Number.isInteger(o.value) || o.value < 0) return false;
    paid += o.value;
  }
  return paid >= owed;
}

/** §2.2: a priced mint owes its price in transaction fee, and an unknown fee is not a paid one. */
function feeCovers(tx, terms) {
  const price = Number((terms && terms.price) || 0);
  if (!(price > 0)) return true;
  return typeof tx.fee === 'number' && Number.isFinite(tx.fee) && tx.fee >= price;
}

/**
 * Spec §5, re-derived. Two things beyond "is this key on the list":
 *
 *   - the leaf is TAGGED and the key is LENGTH-PREFIXED, so one entry has exactly one preimage.
 *     Concatenating the key and the amount directly made `key||"12"` and `(key||"1")||"2"` the same
 *     leaf, which is two entitlements sharing one entry.
 *   - `maxAmount` is a running entitlement, not a label. Without the ledger the same proof mints for
 *     ever, which makes an allowlist a door rather than an allocation.
 *
 * Every field is type-checked before use: an unchecked path element reaching Buffer.compare threw
 * out of the whole scan.
 */
function allowlistGate(tx, def, ref, per, journal) {
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest();
  const p = tx.allowlistProof;
  if (!p || !Array.isArray(p.path) || !Buffer.isBuffer(p.scriptPubKey) || !p.scriptPubKey.length) return null;
  if (!Number.isInteger(p.maxAmount) || p.maxAmount < 1) return null;
  for (const s of p.path) if (!Buffer.isBuffer(s) || s.length !== 32) return null;

  const spends = (tx.inputs || []).some((i) => i.scriptPubKey
    && Buffer.compare(Buffer.from(i.scriptPubKey), p.scriptPubKey) === 0);
  if (!spends) return null;

  const size = Buffer.alloc(4);
  size.writeUInt32BE(p.scriptPubKey.length, 0);
  let node = sha(Buffer.concat([Buffer.from([0x00]), size, p.scriptPubKey,
    Buffer.from(String(p.maxAmount), 'utf8')]));
  const slot = `${ref}|${node.toString('hex')}`;
  for (const sib of p.path) {
    node = Buffer.compare(node, sib) <= 0
      ? sha(Buffer.concat([Buffer.from([0x01]), node, sib]))
      : sha(Buffer.concat([Buffer.from([0x01]), sib, node]));
  }
  if (!Buffer.isBuffer(def.allowlistRoot) || !node.equals(def.allowlistRoot)) return null;

  const taken = journal.gateUsed.get(slot) || 0;
  return taken + per > p.maxAmount ? null : { slot, taken };
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
    if (def && lockedEnough(tx, def.ticker, tx.etching.lock)
      && !journal.tickerOwner.has(def.ticker) && !journal.definitions.has(ref)) {
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
    const per = t ? t.amount : 0;
    const withinWindow = t
      && (t.openHeight == null || tx.height >= t.openHeight)
      && (t.closeHeight == null || tx.height <= t.closeHeight);
    const underCap = t && (t.cap == null || iss.mintCount < t.cap);
    const underSupply = def && (def.premine + iss.minted + per <= def.supply);
    const feeOk = feeCovers(tx, t);
    const gate = (def && def.allowlistRoot && per > 0)
      ? allowlistGate(tx, def, message.runeRef, per, journal) : null;
    const gateOk = !def || !def.allowlistRoot || gate !== null;
    if (def && per > 0 && withinWindow && underCap && underSupply && gateOk && feeOk) {
      iss.minted += per;
      iss.mintCount += 1;
      if (gate) journal.gateUsed.set(gate.slot, gate.taken + per);
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

module.exports = { Journal, apply, index, refOf, orderRefs };
