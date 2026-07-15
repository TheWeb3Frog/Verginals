'use strict';
// Marketplace order book: a validated store of signed listings and bids. It is PURELY
// informational. It never holds keys, funds or assets, never broadcasts, and cannot execute a
// trade. It stores messages that buyers/sellers signed themselves, checks they are well-formed
// and currently valid on-chain, and serves them so the counterparty (or the site) can act.
//
// On-chain facts are read through an injected `chain` so the module stays unit-testable:
//   chain.carrierInfo(txid, vout) -> { address, valueUnits, spent, inscription } | null
//   chain.outpointSpent(txid, vout) -> boolean
// `now()` is injectable too. Persistence mirrors the other controllers: one JSON file, atomic
// write. Listings are keyed by carrier outpoint (one live listing per Verginal); bids are a list.

const fs = require('fs');
const path = require('path');
const {
  verifyListingVariant, verifyBid, pickVariant,
} = require('./swap');

const OUTPOINT_RE = /^[0-9a-fA-F]{64}:\d+$/;
const MAX_BIDS_PER_CARRIER = 50;
const MAX_LISTINGS = 5000;

class OrderBook {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir  persistent dir (file market.json lives here)
   * @param {object} opts.network  bitcoinjs network (Verge)
   * @param {object} opts.chain    { carrierInfo, outpointSpent } async on-chain reads
   * @param {function} [opts.now]  () => unix seconds
   */
  constructor({ dataDir, network, chain, now }) {
    this.file = path.join(dataDir, 'market.json');
    this.network = network;
    this.chain = chain;
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this.state = { listings: {}, bids: {} }; // listings: outpoint->listing ; bids: outpoint->[bid]
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { listings: s.listings || {}, bids: s.bids || {} };
    } catch (_) {
      this.state = { listings: {}, bids: {} };
    }
    return this;
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  _key(carrier) {
    return `${carrier.txid}:${carrier.vout}`;
  }

  // --- listings ----------------------------------------------------------------------------

  /**
   * Accept a signed listing (buildListingSchedule output). Verifies: the carrier still carries a
   * Verginal and is unspent; every variant's signature verifies AND was signed by the carrier's
   * owner; the price is sane. Throws with a clear message otherwise. Never broadcasts.
   */
  async addListing(listing) {
    if (!listing || listing.kind !== 'verginals-listing-v2') throw new Error('not a listing');
    const carrier = listing.carrier || {};
    if (!OUTPOINT_RE.test(`${carrier.txid}:${carrier.vout}`)) throw new Error('bad carrier outpoint');
    if (!(listing.priceUnits > 0)) throw new Error('price must be positive');
    if (!Array.isArray(listing.variants) || !listing.variants.length) throw new Error('no signed variants');

    const info = await this.chain.carrierInfo(carrier.txid, carrier.vout);
    if (!info || info.spent) throw new Error('carrier is spent or unknown');
    if (!info.inscription) throw new Error('this UTXO does not carry a Verginal');

    for (const v of listing.variants) {
      const r = verifyListingVariant({
        network: this.network, carrier, priceUnits: listing.priceUnits,
        sellerAddress: listing.sellerAddress, time: v.time, scriptSig: v.scriptSig,
      });
      if (!r.ok) throw new Error(`a variant signature is invalid (nTime ${v.time})`);
      if (r.address !== info.address) throw new Error('a variant was not signed by the carrier owner');
    }

    if (Object.keys(this.state.listings).length >= MAX_LISTINGS && !this.state.listings[this._key(carrier)]) {
      throw new Error('the order book is full');
    }
    // Record the carrier's current value and the inscription's unit offset so a buyer can build a
    // constant-postage completion without re-deriving them (swap.completeListing needs both).
    const carrierOffset = (info.inscription && info.inscription.offset) || 0;
    const stored = Object.assign({}, listing, { at: this.now(), carrierValue: info.valueUnits, carrierOffset });
    this.state.listings[this._key(carrier)] = stored;
    this._save();
    return { listed: true, carrier: this._key(carrier), variants: listing.variants.length };
  }

  /** The completion-ready variant for a buyer, or null if none is valid yet. */
  variantFor(carrierKey, { maxCoinTime }) {
    const l = this.state.listings[carrierKey];
    if (!l) return null;
    return pickVariant(l, { now: this.now(), maxCoinTime: maxCoinTime || 0 });
  }

  /** Remove a listing if its carrier has been spent (sold or cancelled) or it has expired. */
  async _pruneListing(key) {
    const l = this.state.listings[key];
    if (!l) return false;
    if (this.now() > (l.expiresAt || 0)) { delete this.state.listings[key]; return true; }
    const [txid, vout] = key.split(':');
    if (await this.chain.outpointSpent(txid, Number(vout))) { delete this.state.listings[key]; return true; }
    return false;
  }

  // --- bids --------------------------------------------------------------------------------

  /**
   * Accept a signed bid (buildBid output). Verifies the carrier carries a Verginal, the buyer
   * signatures are valid, and the funded inputs are unspent and owned by the signer. Stored under
   * the carrier so a seller can list the offers on their Verginal.
   */
  async addBid(bid) {
    if (!bid || bid.kind !== 'verginals-bid-v2') throw new Error('not a bid');
    const carrier = bid.carrier || {};
    const key = `${carrier.txid}:${carrier.vout}`;
    if (!OUTPOINT_RE.test(key)) throw new Error('bad carrier outpoint');
    if (!(bid.priceUnits > 0)) throw new Error('price must be positive');

    const info = await this.chain.carrierInfo(carrier.txid, carrier.vout);
    if (!info || info.spent) throw new Error('carrier is spent or unknown');
    if (!info.inscription) throw new Error('this UTXO does not carry a Verginal');

    const v = verifyBid({ network: this.network, bid });
    if (!v.ok) throw new Error('bid signatures are invalid');
    for (const inp of v.inputs) {
      if (await this.chain.outpointSpent(inp.txid, inp.vout)) throw new Error('a funding coin is already spent');
    }

    const list = this.state.bids[key] || [];
    if (list.length >= MAX_BIDS_PER_CARRIER) throw new Error('too many bids on this item');
    // One live bid per buyer address per carrier: a new bid from the same buyer replaces the old.
    const buyer = bid.buyerAddress;
    const filtered = list.filter((b) => b.buyerAddress !== buyer);
    filtered.push(Object.assign({}, bid, { at: this.now() }));
    filtered.sort((a, b) => b.priceUnits - a.priceUnits);
    this.state.bids[key] = filtered;
    this._save();
    return { bid: true, carrier: key, priceUnits: bid.priceUnits };
  }

  /** Drop bids whose carrier moved or whose funding coins were spent (stale offers). */
  async _pruneBids(key) {
    const list = this.state.bids[key];
    if (!list || !list.length) return false;
    const [ctxid, cvout] = key.split(':');
    if (await this.chain.outpointSpent(ctxid, Number(cvout))) { delete this.state.bids[key]; return true; }
    const kept = [];
    for (const b of list) {
      const v = verifyBid({ network: this.network, bid: b });
      let alive = v.ok;
      if (alive) {
        for (const inp of v.inputs) {
          if (await this.chain.outpointSpent(inp.txid, inp.vout)) { alive = false; break; }
        }
      }
      if (alive) kept.push(b);
    }
    if (kept.length !== list.length) {
      if (kept.length) this.state.bids[key] = kept; else delete this.state.bids[key];
      return true;
    }
    return false;
  }

  // --- reads (prune lazily as we go) -------------------------------------------------------

  async listings() {
    let changed = false;
    for (const key of Object.keys(this.state.listings)) {
      if (await this._pruneListing(key)) changed = true;
    }
    if (changed) this._save();
    return Object.values(this.state.listings).map((l) => ({
      carrier: this._key(l.carrier),
      priceUnits: l.priceUnits,
      sellerAddress: l.sellerAddress,
      expiresAt: l.expiresAt,
      at: l.at,
    }));
  }

  async bidsFor(carrierKey) {
    if (await this._pruneBids(carrierKey)) this._save();
    return (this.state.bids[carrierKey] || []).map((b) => ({
      priceUnits: b.priceUnits, buyerAddress: b.buyerAddress, at: b.at,
    }));
  }

  getListing(carrierKey) {
    return this.state.listings[carrierKey] || null;
  }

  getBid(carrierKey, buyerAddress) {
    return (this.state.bids[carrierKey] || []).find((b) => b.buyerAddress === buyerAddress) || null;
  }
}

module.exports = { OrderBook };
