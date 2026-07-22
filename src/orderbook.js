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
const bitcoin = require('bitcoinjs-lib');
const {
  verifyListingVariant, verifyBid, pickVariant, feeFor,
} = require('./swap');

const OUTPOINT_RE = /^[0-9a-fA-F]{64}:\d+$/;
const MAX_BIDS_PER_CARRIER = 50;
const MAX_LISTINGS = 5000;
const MAX_SALES = 1000; // rolling activity log

class OrderBook {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir  persistent dir (file market.json lives here)
   * @param {object} opts.network  bitcoinjs network (Verge)
   * @param {object} opts.chain    { carrierInfo, outpointSpent } async on-chain reads
   * @param {function} [opts.now]  () => unix seconds
   */
  constructor({ dataDir, network, chain, now, feeBps, feeAddress }) {
    this.file = path.join(dataDir, 'market.json');
    this.network = network;
    this.chain = chain;
    this.now = now || (() => Math.floor(Date.now() / 1000));
    // Marketplace fee taken from the seller's proceeds and paid to feeAddress. 0 = no fee. A listing
    // or bid submitted here must carry exactly this fee, or it is rejected (the enforcement point).
    this.feeBps = feeBps || 0;
    this.feeAddress = feeAddress || null;
    // listings: outpoint->listing ; bids: outpoint->[bid] ; sales: rolling log of detected sales
    this.state = { listings: {}, bids: {}, sales: [] };
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { listings: s.listings || {}, bids: s.bids || {}, sales: s.sales || [] };
    } catch (_) {
      this.state = { listings: {}, bids: {}, sales: [] };
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

    // Enforce the marketplace fee: the listing must have signed the net (price - fee) to the seller
    // and name the pool address, or we refuse it. This is where the fee is guaranteed, not the UI.
    const expectedFee = feeFor(listing.priceUnits, this.feeBps);
    if ((listing.feeUnits || 0) !== expectedFee) throw new Error('listing fee does not match the marketplace fee');
    if (expectedFee > 0 && listing.feeAddress !== this.feeAddress) throw new Error('listing fee is not payable to the marketplace');

    const info = await this.chain.carrierInfo(carrier.txid, carrier.vout);
    if (!info || info.spent) throw new Error('carrier is spent or unknown');
    if (!info.inscription) throw new Error('this UTXO does not carry a Verginal');

    for (const v of listing.variants) {
      const r = verifyListingVariant({
        network: this.network, carrier, priceUnits: listing.priceUnits,
        sellerAddress: listing.sellerAddress, time: v.time, scriptSig: v.scriptSig,
        feeUnits: listing.feeUnits || 0,
      });
      if (!r.ok) throw new Error(`a variant signature is invalid (nTime ${v.time})`);
      if (r.address !== info.address) throw new Error('a variant was not signed by the carrier owner');
    }

    if (Object.keys(this.state.listings).length >= MAX_LISTINGS && !this.state.listings[this._key(carrier)]) {
      throw new Error('the order book is full');
    }
    // Record the carrier's current value and the inscription's unit offset so a buyer can build a
    // constant-postage completion without re-deriving them (swap.completeListing needs both). The
    // inscription's identity is kept too, so a sale can be attributed (activity feed, collection
    // stats) even after the carrier has been spent and the index has moved on.
    const ins = info.inscription || {};
    const carrierOffset = ins.offset || 0;
    const stored = Object.assign({}, listing, {
      at: this.now(), carrierValue: info.valueUnits, carrierOffset,
      inscriptionId: ins.id || null,
      collectionNumber: ins.collectionNumber != null ? ins.collectionNumber : null,
      collectionSlug: ins.collectionSlug || null,
    });
    this.state.listings[this._key(carrier)] = stored;
    this._save();
    return { listed: true, carrier: this._key(carrier), variants: listing.variants.length };
  }

  /** The completion-ready variant for a buyer, or null if none is valid yet. */
  variantFor(carrierKey, { maxCoinTime }) {
    const l = this.state.listings[carrierKey];
    if (!l || l.pendingSale) return null; // pendingSale: carrier already spent, awaiting the indexer
    return pickVariant(l, { now: this.now(), maxCoinTime: maxCoinTime || 0 });
  }

  /** Remove a listing if its carrier has been spent (sold or cancelled) or it has expired. */
  async _pruneListing(key) {
    const l = this.state.listings[key];
    if (!l) return false;
    if (this.now() > (l.expiresAt || 0)) { delete this.state.listings[key]; return true; }
    const [txid, vout] = key.split(':');
    if (await this.chain.outpointSpent(txid, Number(vout))) {
      // The spend is visible on the live RPC immediately, but only the (periodically synced)
      // indexer can say whether it was a sale or a cancel. Until the indexer has processed the
      // spend it still reports the inscription AT the spent outpoint (or errors); deleting the
      // listing then would lose the sale forever, since the listing record is the only place the
      // price survives. Keep the listing and retry on the next prune; expiry still bounds how
      // long an undecidable one can linger. `pendingSale` hides it from floor/listed stats.
      const verdict = await this._recordSaleIfMoved(l, key);
      if (verdict === 'pending') {
        if (!l.pendingSale) { l.pendingSale = this.now(); this._save(); }
        return false;
      }
      delete this.state.listings[key];
      return true;
    }
    return false;
  }

  /**
   * When a listed carrier is spent, decide whether it was a SALE (the inscription moved to a new
   * owner, which under a signed listing can only happen at the listed price), a cancel/self-move,
   * or not yet decidable (indexer hasn't processed the spend). Returns 'sale' | 'cancel' |
   * 'pending'. Sales are logged into the rolling activity feed.
   */
  async _recordSaleIfMoved(listing, spentKey) {
    if (!listing || !listing.inscriptionId || typeof this.chain.inscriptionOwner !== 'function') {
      return 'cancel'; // nothing to record against: treat as a plain prune
    }
    let owner = null;
    try { owner = await this.chain.inscriptionOwner(listing.inscriptionId); } catch (_) { return 'pending'; }
    if (!owner || !owner.address) return 'pending'; // indexer doesn't know yet: retry next prune
    // Indexer still maps the inscription to the outpoint we KNOW is spent -> it lags the chain.
    if (spentKey && owner.location === spentKey) return 'pending';
    if (owner.address === listing.sellerAddress) return 'cancel'; // still the seller's: cancel/self-move
    this.state.sales.push({
      inscriptionId: listing.inscriptionId,
      collectionNumber: listing.collectionNumber != null ? listing.collectionNumber : null,
      collectionSlug: listing.collectionSlug || null,
      priceUnits: listing.priceUnits,
      sellerAddress: listing.sellerAddress,
      buyerAddress: owner.address,
      at: this.now(),
    });
    if (this.state.sales.length > MAX_SALES) this.state.sales = this.state.sales.slice(-MAX_SALES);
    return 'sale';
  }

  /** True for an Alpha Verginal (a collection mint with no launchpad slug). */
  static _isAlpha(x) {
    return x && x.collectionNumber != null && !x.collectionSlug;
  }

  /**
   * Marketplace-side numbers for the Alpha collection: how many are listed, the floor (lowest
   * listed price), lifetime sale count and volume from the activity log. Supply and holders are
   * chain facts the caller adds. Prunes stale listings first so the counts are live.
   */
  async stats() {
    for (const key of Object.keys(this.state.listings)) await this._pruneListing(key);
    this._save();
    const listed = Object.values(this.state.listings).filter((l) => OrderBook._isAlpha(l) && !l.pendingSale);
    const floorUnits = listed.reduce((m, l) => (m == null || l.priceUnits < m ? l.priceUnits : m), null);
    const sales = this.state.sales.filter(OrderBook._isAlpha);
    const volumeUnits = sales.reduce((s, x) => s + (x.priceUnits || 0), 0);
    return { listedCount: listed.length, floorUnits, salesCount: sales.length, volumeUnits };
  }

  /** Recent Alpha activity: sales and live listings, newest first, capped at `limit`. */
  activity(limit = 50) {
    const sales = this.state.sales.filter(OrderBook._isAlpha)
      .map((s) => ({ type: 'sale', at: s.at, collectionNumber: s.collectionNumber, priceUnits: s.priceUnits, sellerAddress: s.sellerAddress, buyerAddress: s.buyerAddress }));
    const lists = Object.values(this.state.listings).filter((l) => OrderBook._isAlpha(l) && !l.pendingSale)
      .map((l) => ({ type: 'list', at: l.at, collectionNumber: l.collectionNumber, priceUnits: l.priceUnits, sellerAddress: l.sellerAddress }));
    return sales.concat(lists).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
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

    // Enforce the marketplace fee on the actual signed outputs (not just the bid's metadata): the
    // seller output must be the net, and the fee output must pay the pool the exact fee.
    const expectedFee = feeFor(bid.priceUnits, this.feeBps);
    const sellerVal = bid.vout && bid.vout[2] ? bid.vout[2].value : -1;
    if (sellerVal !== bid.priceUnits - expectedFee) throw new Error('bid does not pay the seller the net price');
    if (expectedFee > 0) {
      const feeScript = bitcoin.address.toOutputScript(this.feeAddress, this.network).toString('hex');
      const hasFee = (bid.vout || []).some((o) => o.value === expectedFee && o.script === feeScript);
      if (!hasFee) throw new Error('bid does not pay the marketplace fee');
    }

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
    return Object.values(this.state.listings)
      .filter((l) => !l.pendingSale) // spent carrier awaiting the indexer's sale/cancel verdict
      .map((l) => ({
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
