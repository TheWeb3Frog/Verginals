'use strict';
// Verge Runes: the state machine (RUNES-SPEC-v0 §2, §3, §5).
//
// A pure, deterministic reduction of transactions into rune state. No chain access, no disk, no
// clock: feed it the same blocks and it produces the same state, byte for byte. That property is
// what makes checkpoints (checkpoint.js) meaningful, since two independent indexers can only
// disagree if one of them is wrong.
//
// Balances live on OUTPOINTS, never on addresses (spec §3): owning the utxo is owning the balance.
//
// The safety rule that shapes everything: a transaction the protocol does not understand must never
// destroy value. Unknown, malformed and invalid messages all fall through to the same default
// assignment, which sends the pooled balance to the first spendable output.

const crypto = require('crypto');
const codec = require('./codec');
const tickers = require('./tickers');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const outpoint = (txid, vout) => `${txid}:${vout}`;

class RuneState {
  constructor() {
    this.runes = new Map();   // runeRef -> etching record
    this.tickers = new Map();  // TICKER -> runeRef (uniqueness, spec §7)
    this.balances = new Map(); // outpoint -> Map(runeRef -> amount)
    // How much each allowlist entry has already taken, so `maxAmount` is a real entitlement rather
    // than decoration: `${runeRef}|${leafHex}` -> units minted so far (spec §5).
    this.allowlistMinted = new Map();
    this.height = 0;
  }

  /** Balance of one rune at one outpoint. */
  balanceOf(op, runeRef) {
    const m = this.balances.get(op);
    return (m && m.get(runeRef)) || 0;
  }

  credit(op, runeRef, amount) {
    if (amount <= 0) return;
    let m = this.balances.get(op);
    if (!m) { m = new Map(); this.balances.set(op, m); }
    m.set(runeRef, (m.get(runeRef) || 0) + amount);
  }

  /** Every (outpoint, runeRef, amount) triple, sorted, for checkpointing. */
  *entries() {
    const ops = [...this.balances.keys()].sort();
    for (const op of ops) {
      const refs = [...this.balances.get(op).keys()].sort(codec.compareRefs);
      for (const ref of refs) yield { outpoint: op, runeRef: ref, amount: this.balances.get(op).get(ref) };
    }
  }

  /** Every registered rune, sorted, so a checkpoint can commit to what a reference MEANS. */
  *runeEntries() {
    for (const ref of [...this.runes.keys()].sort(codec.compareRefs)) {
      const r = this.runes.get(ref);
      yield { runeRef: ref, ticker: r.ticker, divisibility: r.divisibility, supply: r.supply, spacers: r.spacers };
    }
  }

  /**
   * Plain-object form, so a service can put this on disk and pick it up again.
   *
   * Kept here rather than in the service because this is where the shape is defined: balances are a
   * map of maps and allowlist entitlements are keyed by a composite, and a writer that guessed at
   * either would produce a file that loads into a subtly different state. Buffers (the allowlist
   * root) go to hex and come back, because JSON has no opinion about bytes.
   */
  toJSON() {
    return {
      height: this.height,
      runes: [...this.runes.entries()].map(([ref, r]) => [ref, Object.assign({}, r, {
        allowlistRoot: r.allowlistRoot ? r.allowlistRoot.toString('hex') : null,
      })]),
      tickers: [...this.tickers.entries()],
      balances: [...this.balances.entries()].map(([op, m]) => [op, [...m.entries()]]),
      allowlistMinted: [...this.allowlistMinted.entries()],
    };
  }

  static fromJSON(obj) {
    const s = new RuneState();
    if (!obj) return s;
    s.height = Number(obj.height || 0);
    for (const [ref, r] of obj.runes || []) {
      s.runes.set(ref, Object.assign({}, r, {
        allowlistRoot: r.allowlistRoot ? Buffer.from(r.allowlistRoot, 'hex') : null,
      }));
    }
    for (const [t, ref] of obj.tickers || []) s.tickers.set(t, ref);
    for (const [op, entries] of obj.balances || []) s.balances.set(op, new Map(entries));
    for (const [k, v] of obj.allowlistMinted || []) s.allowlistMinted.set(k, v);
    return s;
  }
}

/** The identity of the rune etched at this position (spec §4.1). Two numbers, never combined. */
const runeRefOf = (height, txIndex) => codec.refOf(height, txIndex);

/**
 * Apply one transaction.
 *
 * @param {RuneState} state
 * @param {Object} tx  {
 *   txid, height, txIndex,
 *   inputs:  [{ txid, vout, scriptPubKey? }],
 *   outputs: [{ value, scriptPubKey, isOpReturn, opReturnData? }],
 *   etching?: {...}   // decoded from an inscription in this tx, if any (spec §1)
 * }
 * @param {Object} [opts] { dustUnits }
 */
function applyTx(state, tx, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : 100000;
  state.height = Math.max(state.height, tx.height || 0);

  // 1) Pool everything the inputs carried, and consume those outpoints.
  const pool = new Map(); // runeRef -> amount
  for (const inp of tx.inputs || []) {
    const op = outpoint(inp.txid, inp.vout);
    const held = state.balances.get(op);
    if (!held) continue;
    for (const [ref, amt] of held) pool.set(ref, (pool.get(ref) || 0) + amt);
    state.balances.delete(op);
  }

  // 2) An etching creates a new rune and may premine into the pool.
  if (tx.etching) {
    const ref = runeRefOf(tx.height, tx.txIndex);
    const rec = normaliseEtching(tx.etching, ref);
    // The price has to be locked in this same transaction (spec §7.2), or the ticker is not taken.
    // Checked here rather than by the caller because it is what makes a ticker allocation valid, and
    // an indexer that skipped it would hand out names for free and then disagree with every other.
    const paid = rec ? tickers.isLocked(tx, rec.ticker, tx.etching.lock) : { ok: false };
    if (rec && paid.ok
      && !state.tickers.has(rec.ticker) && !state.runes.has(ref)) {
      // Keep the lock, because it is the etcher's money and they will want it back in four years.
      // The locktime and the public key were already published in the etching, so none of this is
      // new information; recording it here is what lets a wallet find the owner's own locks by
      // comparing derived keys against a public list, with no address index and nothing disclosed.
      //
      // Hex, never Buffers: this record is serialised to JSON on every snapshot, and a Buffer comes
      // back from that as {type:'Buffer',data:[...]}, which would compare equal to nothing.
      rec.lock = lockRecordFor(tx, tx.etching.lock, paid.locked);
      state.runes.set(ref, rec);
      state.tickers.set(rec.ticker, ref);
      if (rec.premine > 0) pool.set(ref, (pool.get(ref) || 0) + rec.premine);
    }
    // A duplicate ticker or an unpaid one is ignored, not fatal: the transaction still moves
    // whatever it carried.
  }

  // 3) Decode the protocol message, if the transaction carries one.
  const msg = readMessage(tx);

  if (msg && msg.type === 'mint') applyMint(state, tx, msg, pool);

  // 4) Which outputs may receive: never the OP_RETURN, never a dust output.
  const eligible = [];
  (tx.outputs || []).forEach((o, i) => { if (!o.isOpReturn && o.value >= dust) eligible.push(i); });

  // 5) Explicit edicts, in order. An edict naming an impossible output invalidates only itself.
  if (msg && msg.type === 'edicts') {
    for (const e of msg.edicts) {
      const available = pool.get(e.runeRef) || 0;
      if (available <= 0) continue;
      if (!eligible.includes(e.output)) continue;
      const amount = e.amount === 0 ? available : Math.min(e.amount, available);
      state.credit(outpoint(tx.txid, e.output), e.runeRef, amount);
      pool.set(e.runeRef, available - amount);
    }
  }

  // 6) Whatever is left goes to the first eligible output; with none, it is burned (spec §3).
  //    This is what makes a protocol-unaware wallet safe: a plain send moves the balance instead
  //    of destroying it.
  const fallback = eligible.length > 0 ? eligible[0] : null;
  for (const [ref, amt] of pool) {
    if (amt <= 0) continue;
    if (fallback === null) continue; // burned
    state.credit(outpoint(tx.txid, fallback), ref, amt);
  }

  return state;
}

/** The first decodable protocol message among the transaction's OP_RETURN outputs. */
function readMessage(tx) {
  for (const o of tx.outputs || []) {
    if (!o.isOpReturn || !o.opReturnData) continue;
    const m = codec.decode(o.opReturnData);
    if (m) return m;
  }
  return null;
}

/**
 * Mint terms, or null when they are not usable.
 *
 * Every number here is checked, and an etching whose terms do not check out is not registered at
 * all. Waving them through was a real hole: a fractional `amount` mints happily and then produces a
 * balance no edict can encode, so the units exist and can never be moved again. Dropping just the
 * terms would be worse than refusing the etching, because it silently turns a mint-gated rune into a
 * premine-only one, which is a different rune from the one the etcher paid for.
 */
function normaliseTerms(t) {
  if (t == null) return null;
  if (typeof t !== 'object') return undefined;   // present but unusable
  const whole = (v) => Number.isInteger(v) && v >= 0;
  const amount = t.amount;
  if (!Number.isInteger(amount) || amount <= 0) return undefined;
  const out = { amount };
  if (t.cap != null) { if (!whole(t.cap)) return undefined; out.cap = t.cap; }
  if (t.openHeight != null) { if (!whole(t.openHeight)) return undefined; out.openHeight = t.openHeight; }
  if (t.closeHeight != null) { if (!whole(t.closeHeight)) return undefined; out.closeHeight = t.closeHeight; }
  if (t.price != null) { if (!whole(t.price)) return undefined; out.price = t.price; }
  if (out.openHeight != null && out.closeHeight != null && out.closeHeight < out.openHeight) return undefined;
  return out;
}

function normaliseEtching(e, ref) {
  const ticker = String(e.ticker || '').toUpperCase();
  if (!/^[A-Z]{1,26}$/.test(ticker)) return null;
  const divisibility = Number(e.divisibility || 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) return null;
  const supply = Number(e.supply || 0);
  const premine = Number(e.premine || 0);
  if (!Number.isInteger(supply) || supply < 0) return null;
  if (!Number.isInteger(premine) || premine < 0 || premine > supply) return null;
  const terms = normaliseTerms(e.terms);
  if (terms === undefined) return null;
  const allowlistRoot = e.allowlistRoot || null;
  if (allowlistRoot !== null && (!Buffer.isBuffer(allowlistRoot) || allowlistRoot.length !== 32)) return null;
  return {
    ref, ticker,
    // The ticker IS the name. Anything an etching still carries under an old free text field is
    // ignored rather than trusted: a name nobody can verify is a name somebody will abuse.
    name: ticker,
    symbol: typeof e.symbol === 'string' && Array.from(e.symbol).length === 1 ? e.symbol : null,
    divisibility, supply, premine,
    // Normalised at indexing time, so every indexer renders the same name from the same etching
    // and a mask with bits past the end of the ticker is ignored rather than fatal (§7.1).
    spacers: tickers.normalizeSpacers(ticker, Number(e.spacers) || 0),
    terms,                           // { amount, cap, openHeight, closeHeight, price } or null
    allowlistRoot,
    parent: e.parent || null,
    metadataRef: e.metadataRef || null,
    minted: 0,                       // atomic units issued by open mints
    mintCount: 0,
  };
}

/**
 * Where the ticker price actually sits, as plain data: which outputs of the etching hold it, how
 * much, until when, and whose key opens it. Everything here is already on the chain.
 */
function lockRecordFor(tx, lock, locked) {
  const script = tickers.lockScriptFor(lock);
  if (!script) return null;
  const vouts = [];
  (tx.outputs || []).forEach((o, i) => {
    if (o.scriptPubKey && Buffer.isBuffer(o.scriptPubKey) && o.scriptPubKey.equals(script.scriptPubKey)) vouts.push(i);
  });
  return {
    locktime: script.locktime,
    pubkey: Buffer.isBuffer(lock.k) ? lock.k.toString('hex') : String(lock.k),
    scriptPubKey: script.scriptPubKey.toString('hex'),
    vouts,
    value: locked,
  };
}

/** An open mint credits the pool if every term still holds (spec §2.2, §5). */
function applyMint(state, tx, msg, pool) {
  const rune = state.runes.get(msg.runeRef);
  if (!rune || !rune.terms) return;
  const t = rune.terms;
  const amount = t.amount;
  if (t.openHeight != null && tx.height < t.openHeight) return;
  if (t.closeHeight != null && tx.height > t.closeHeight) return;
  if (t.cap != null && rune.mintCount >= t.cap) return;
  if (rune.premine + rune.minted + amount > rune.supply) return;
  if (!feePaid(tx, t)) return;

  // The allowlist is an entitlement, not just a door: an entry may take up to `maxAmount` units in
  // total, and the running total is kept here so the same proof cannot be replayed for ever.
  let gate = null;
  if (rune.allowlistRoot) {
    gate = allowlistGate(tx, rune, amount, state);
    if (!gate) return;
  }

  rune.minted += amount;
  rune.mintCount += 1;
  if (gate) state.allowlistMinted.set(gate.key, gate.used + amount);
  pool.set(msg.runeRef, (pool.get(msg.runeRef) || 0) + amount);
}

/**
 * Did this mint pay what the etcher asked for?
 *
 * The price is a transaction FEE, so there is no output to look at and nothing to address: the
 * miner of the block receives it, exactly like any other fee. That is the whole reason it works as
 * a price, because it needs no beneficiary and no payout address in the protocol.
 *
 * Fails CLOSED. `tx.fee` is supplied by the caller (scanner.resolveFee), and an indexer that cannot
 * resolve it must refuse the mint rather than wave it through, or two indexers reading the same
 * chain would produce different balances depending on how their node is configured.
 */
function feePaid(tx, terms) {
  const price = Number(terms.price || 0);
  if (price <= 0) return true;
  const fee = tx.fee;
  if (typeof fee !== 'number' || !Number.isFinite(fee)) return false;
  return fee >= price;
}

// Leaves and interior nodes are hashed with different tags, so no interior node can ever be replayed
// as a leaf, and the scriptPubKey is length-prefixed so that (key, amount) has exactly one encoding.
// Without the prefix, scriptPubKey||"12" and (scriptPubKey||"1")||"2" are the same preimage, which
// means two different entitlements share one leaf.
const AL_LEAF = Buffer.from([0x00]);
const AL_NODE = Buffer.from([0x01]);

function allowlistLeaf(scriptPubKey, maxAmount) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(scriptPubKey.length, 0);
  return sha256(Buffer.concat([AL_LEAF, len, scriptPubKey, Buffer.from(String(maxAmount), 'utf8')]));
}

/**
 * Allowlist check (spec §5): the transaction must spend an input whose scriptPubKey is proven to be
 * a leaf of the etched merkle root, and that entry must have headroom left. The proof travels
 * alongside the transaction, supplied by the caller as
 * tx.allowlistProof = { scriptPubKey, maxAmount, path: [Buffer] }.
 *
 * Every field is type-checked before it is used. An earlier version passed a caller-supplied array
 * straight to Buffer.compare, so one hostile transaction with a non-Buffer in its path threw out of
 * applyTx and stopped the whole scan.
 *
 * @returns {{ key, used }|null} null when the gate does not open
 */
function allowlistGate(tx, rune, amount, state) {
  const p = tx.allowlistProof;
  if (!p || !Array.isArray(p.path) || !Buffer.isBuffer(p.scriptPubKey) || p.scriptPubKey.length === 0) return null;
  if (!Number.isInteger(p.maxAmount) || p.maxAmount <= 0) return null;
  if (!p.path.every((s) => Buffer.isBuffer(s) && s.length === 32)) return null;

  const spends = (tx.inputs || []).some((i) => i.scriptPubKey
    && Buffer.compare(Buffer.from(i.scriptPubKey), p.scriptPubKey) === 0);
  if (!spends) return null;

  let node = allowlistLeaf(p.scriptPubKey, p.maxAmount);
  const leafKey = `${rune.ref}|${node.toString('hex')}`;
  for (const sib of p.path) {
    node = Buffer.compare(node, sib) <= 0
      ? sha256(Buffer.concat([AL_NODE, node, sib]))
      : sha256(Buffer.concat([AL_NODE, sib, node]));
  }
  if (!node.equals(rune.allowlistRoot)) return null;

  const used = state.allowlistMinted.get(leafKey) || 0;
  if (used + amount > p.maxAmount) return null;
  return { key: leafKey, used };
}

/** Replay a list of transactions in order. Deterministic: same input, same state. */
function index(txs, opts = {}) {
  const state = new RuneState();
  for (const tx of txs) applyTx(state, tx, opts);
  return state;
}

module.exports = { RuneState, applyTx, index, runeRefOf, outpoint, allowlistLeaf, AL_NODE };
