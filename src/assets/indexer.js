'use strict';
// Verge Assets: the state machine (ASSETS-SPEC-v0 §2, §3, §5).
//
// A pure, deterministic reduction of transactions into asset state. No chain access, no disk, no
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

class AssetState {
  constructor() {
    this.assets = new Map();   // assetRef -> etching record
    this.tickers = new Map();  // TICKER -> assetRef (uniqueness, spec §7)
    this.balances = new Map(); // outpoint -> Map(assetRef -> amount)
    this.height = 0;
  }

  /** Balance of one asset at one outpoint. */
  balanceOf(op, assetRef) {
    const m = this.balances.get(op);
    return (m && m.get(assetRef)) || 0;
  }

  credit(op, assetRef, amount) {
    if (amount <= 0) return;
    let m = this.balances.get(op);
    if (!m) { m = new Map(); this.balances.set(op, m); }
    m.set(assetRef, (m.get(assetRef) || 0) + amount);
  }

  /** Every (outpoint, assetRef, amount) triple, sorted, for checkpointing. */
  *entries() {
    const ops = [...this.balances.keys()].sort();
    for (const op of ops) {
      const refs = [...this.balances.get(op).keys()].sort((a, b) => a - b);
      for (const ref of refs) yield { outpoint: op, assetRef: ref, amount: this.balances.get(op).get(ref) };
    }
  }
}

/** Pack a location into the compact reference used on the wire (spec §4.1). */
const assetRefOf = (height, txIndex) => height * 1000 + txIndex;

/**
 * Apply one transaction.
 *
 * @param {AssetState} state
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
  const pool = new Map(); // assetRef -> amount
  for (const inp of tx.inputs || []) {
    const op = outpoint(inp.txid, inp.vout);
    const held = state.balances.get(op);
    if (!held) continue;
    for (const [ref, amt] of held) pool.set(ref, (pool.get(ref) || 0) + amt);
    state.balances.delete(op);
  }

  // 2) An etching creates a new asset and may premine into the pool.
  if (tx.etching) {
    const ref = assetRefOf(tx.height, tx.txIndex);
    const rec = normaliseEtching(tx.etching, ref);
    // The price has to be locked in this same transaction (spec §7.2), or the ticker is not taken.
    // Checked here rather than by the caller because it is what makes a ticker allocation valid, and
    // an indexer that skipped it would hand out names for free and then disagree with every other.
    const paid = rec ? tickers.isLocked(tx, rec.ticker, tx.etching.lock) : null;
    if (rec && paid.ok && !state.tickers.has(rec.ticker)) {
      state.assets.set(ref, rec);
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
      const available = pool.get(e.assetRef) || 0;
      if (available <= 0) continue;
      if (!eligible.includes(e.output)) continue;
      const amount = e.amount === 0 ? available : Math.min(e.amount, available);
      state.credit(outpoint(tx.txid, e.output), e.assetRef, amount);
      pool.set(e.assetRef, available - amount);
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

function normaliseEtching(e, ref) {
  const ticker = String(e.ticker || '').toUpperCase();
  if (!/^[A-Z0-9]{1,26}$/.test(ticker)) return null;
  const divisibility = Number(e.divisibility || 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) return null;
  const supply = Number(e.supply || 0);
  const premine = Number(e.premine || 0);
  if (!Number.isInteger(supply) || supply < 0) return null;
  if (!Number.isInteger(premine) || premine < 0 || premine > supply) return null;
  return {
    ref, ticker, name: e.name || ticker, divisibility, supply, premine,
    // Normalised at indexing time, so every indexer renders the same name from the same etching
    // and a mask with bits past the end of the ticker is ignored rather than fatal (§7.1).
    spacers: tickers.normalizeSpacers(ticker, Number(e.spacers) || 0),
    terms: e.terms || null,          // { amount, cap, openHeight, closeHeight, price }
    allowlistRoot: e.allowlistRoot || null,
    parent: e.parent || null,
    metadataRef: e.metadataRef || null,
    minted: 0,                       // atomic units issued by open mints
    mintCount: 0,
  };
}

/** An open mint credits the pool if every term still holds (spec §2.2, §5). */
function applyMint(state, tx, msg, pool) {
  const asset = state.assets.get(msg.assetRef);
  if (!asset || !asset.terms) return;
  const t = asset.terms;
  const amount = Number(t.amount || 0);
  if (amount <= 0) return;
  if (t.openHeight != null && tx.height < t.openHeight) return;
  if (t.closeHeight != null && tx.height > t.closeHeight) return;
  if (t.cap != null && asset.mintCount >= t.cap) return;
  if (asset.premine + asset.minted + amount > asset.supply) return;
  if (!feePaid(tx, t)) return;
  if (asset.allowlistRoot && !allowlistOk(tx, asset, msg)) return;

  asset.minted += amount;
  asset.mintCount += 1;
  pool.set(msg.assetRef, (pool.get(msg.assetRef) || 0) + amount);
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

/**
 * Allowlist check (spec §5): the transaction must spend an input whose scriptPubKey is proven to be
 * a leaf of the etched merkle root. The proof travels alongside the transaction, supplied by the
 * caller as tx.allowlistProof = { scriptPubKey, maxAmount, path: [Buffer] }.
 */
function allowlistOk(tx, asset, _msg) {
  const p = tx.allowlistProof;
  if (!p || !Array.isArray(p.path)) return false;
  const spends = (tx.inputs || []).some((i) => i.scriptPubKey && Buffer.isBuffer(p.scriptPubKey)
    && Buffer.compare(Buffer.from(i.scriptPubKey), p.scriptPubKey) === 0);
  if (!spends) return false;
  let node = sha256(Buffer.concat([p.scriptPubKey, Buffer.from(String(p.maxAmount || 0))]));
  for (const sib of p.path) {
    node = Buffer.compare(node, sib) <= 0 ? sha256(Buffer.concat([node, sib])) : sha256(Buffer.concat([sib, node]));
  }
  return Buffer.isBuffer(asset.allowlistRoot) && node.equals(asset.allowlistRoot);
}

/** Replay a list of transactions in order. Deterministic: same input, same state. */
function index(txs, opts = {}) {
  const state = new AssetState();
  for (const tx of txs) applyTx(state, tx, opts);
  return state;
}

module.exports = { AssetState, applyTx, index, assetRefOf, outpoint };
