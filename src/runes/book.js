'use strict';
// The rune book: a relay, never a custodian.
//
// It holds signed messages other people made, checks they are well formed and still live on chain,
// and serves them so a counterparty can act. It never holds a key, never broadcasts, never settles,
// and cannot make a trade happen. Delete this file and every bid already in someone's hands still
// works: a bid is a self contained transaction missing only the seller's signature.
//
// That is the whole design claim, so it is worth being concrete about what the book CAN do if it
// turns hostile. It can hide an order, serve a stale one, or drop a bid. It cannot alter one: every
// message carries its own signature over its own contents, and the seller's wallet re-checks
// everything against its own node before signing. The worst a bad book achieves is NO TRADE.
//
// On-chain facts come through an injected `chain` so this stays unit-testable:
//   chain.outpointSpent(txid, vout) -> boolean
//   chain.carrierRunes(txid, vout)  -> { value, script, runes: {ref: amount} } | null

const fs = require('fs');
const path = require('path');
const { verifyRuneBid } = require('./bid');
const { verifyOrder, verifyCancel, remaining, scriptFor } = require('./order');

const MAX_ORDERS = 5000;
const MAX_BIDS_PER_SELLER = 200;
const MAX_FILLS = 1000;

const orderKey = (address, nonce) => `${address}|${nonce}`;

class RuneBook {
  constructor({ dataDir, network, chain, now }) {
    this.file = path.join(dataDir, 'runebook.json');
    this.network = network;
    this.chain = chain;
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this.state = { orders: {}, sold: {}, bids: {}, fills: [] };
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { orders: s.orders || {}, sold: s.sold || {}, bids: s.bids || {}, fills: s.fills || [] };
    } catch (_) {
      this.state = { orders: {}, sold: {}, bids: {}, fills: [] };
    }
    return this;
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Publish a standing order. Re-publishing the same (address, nonce) REPLACES it, which is how a
   * seller changes their price without a round trip: sign the new terms on the same nonce.
   */
  putOrder(order) {
    const v = verifyOrder({ network: this.network, order, now: this.now() });
    if (!v.ok) throw new Error(v.reason);
    const key = orderKey(order.address, order.nonce);
    if (!this.state.orders[key] && Object.keys(this.state.orders).length >= MAX_ORDERS) {
      throw new Error('the book is full');
    }
    this.state.orders[key] = order;
    this._save();
    return key;
  }

  cancelOrder(cancel) {
    const key = orderKey(cancel.address, cancel.nonce);
    const v = verifyCancel({ cancel, order: this.state.orders[key] });
    if (!v.ok) throw new Error(v.reason);
    delete this.state.orders[key];
    this._save();
    return true;
  }

  /** Live orders, optionally for one rune. Expired ones are dropped as they are noticed. */
  orders({ runeRef } = {}) {
    const t = this.now();
    const out = [];
    let dirty = false;
    for (const [key, o] of Object.entries(this.state.orders)) {
      if (Number(o.expiresAt) < t) { delete this.state.orders[key]; dirty = true; continue; }
      if (runeRef && o.runeRef !== runeRef) continue;
      const sold = Number(this.state.sold[key] || 0);
      const left = remaining(o, sold);
      if (left <= 0) continue; // spent out, but kept until expiry so a late fill can still be seen
      out.push({ key, order: o, sold, remaining: left });
    }
    if (dirty) this._save();
    return out;
  }

  /**
   * Take a bid and file it under the seller it is aimed at.
   *
   * The book verifies against the CHAIN, not against the bid's own claims, for the same reason the
   * seller does: a bid arrives from a stranger. A bid that fails here would have failed in the
   * seller's wallet too, so refusing it early only saves everybody a round trip.
   */
  async putBid(bid) {
    if (!bid || !Array.isArray(bid.carriers) || bid.carriers.length === 0) throw new Error('malformed bid');
    const onChain = [];
    for (const c of bid.carriers) {
      if (await this.chain.outpointSpent(c.txid, c.vout)) throw new Error(`carrier ${c.txid}:${c.vout} is already spent`);
      const info = await this.chain.carrierRunes(c.txid, c.vout);
      if (!info) throw new Error(`carrier ${c.txid}:${c.vout} is unknown to this node`);
      onChain.push({ txid: c.txid, vout: c.vout, ...info });
    }
    const v = verifyRuneBid({ network: this.network, bid, onChain });
    if (!v.ok) throw new Error(v.reason);

    const seller = onChain[0].script;
    const list = this.state.bids[seller] || (this.state.bids[seller] = []);
    if (list.length >= MAX_BIDS_PER_SELLER) throw new Error('this seller already has as many bids as the book will hold');
    // A buyer who bids twice on the same carriers is replacing their own offer, not adding one: all
    // their bids spend the same coins and only one could ever confirm, so keeping both would only
    // show the seller a choice that does not exist.
    const same = list.findIndex((b) => b.buyerAddress === bid.buyerAddress && sameCarriers(b, bid));
    if (same >= 0) list[same] = bid; else list.push(bid);
    this._save();
    return { seller, receives: v.receives, gives: v.gives };
  }

  /**
   * The bids aimed at one seller's script, freshest facts first: anything whose carriers or whose
   * buyer coins have been spent is dropped here rather than shown and then failing at signing.
   */
  async bidsFor(script) {
    const list = this.state.bids[script] || [];
    const live = [];
    for (const bid of list) {
      let dead = false;
      for (const v of bid.vin) {
        if (await this.chain.outpointSpent(v.txid, v.vout)) { dead = true; break; }
      }
      if (!dead) live.push(bid);
    }
    if (live.length !== list.length) {
      if (live.length === 0) delete this.state.bids[script]; else this.state.bids[script] = live;
      this._save();
    }
    return live;
  }

  /**
   * Record that an order sold some. The book's accounting is ADVISORY: the hard cap is the chain,
   * because every bid against a carrier spends that carrier and only one can confirm. This exists so
   * a seller is not shown offers their order has already used up.
   */
  recordFill({ address, nonce, amount, txid }) {
    const key = orderKey(address, nonce);
    this.state.sold[key] = Number(this.state.sold[key] || 0) + Number(amount);
    this.state.fills.unshift({ key, amount: Number(amount), txid, at: this.now() });
    if (this.state.fills.length > MAX_FILLS) this.state.fills.length = MAX_FILLS;
    this._save();
    return this.state.sold[key];
  }

  soldFor(address, nonce) {
    return Number(this.state.sold[orderKey(address, nonce)] || 0);
  }

  /** Everything a buyer needs to pick a seller: live orders plus the carriers backing them. */
  async depth(runeRef) {
    const rows = [];
    for (const row of this.orders({ runeRef })) {
      rows.push({ ...row, script: scriptFor(row.order) });
    }
    return rows.sort((a, b) => (a.order.minPrice.units / a.order.minPrice.per) - (b.order.minPrice.units / b.order.minPrice.per));
  }
}

function sameCarriers(a, b) {
  if (a.carriers.length !== b.carriers.length) return false;
  const key = (x) => x.carriers.map((c) => `${c.txid}:${c.vout}`).sort().join(',');
  return key(a) === key(b);
}

module.exports = { RuneBook, MAX_ORDERS, MAX_BIDS_PER_SELLER, orderKey };
