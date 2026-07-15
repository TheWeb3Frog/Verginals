'use strict';
// Trustless marketplace primitives: atomic sale of an inscription-carrying UTXO for XVG.
//
// A LISTING is a half-signed transaction. The seller signs their carrier input with
// SIGHASH_SINGLE | SIGHASH_ANYONECANPAY, which commits to exactly one thing: "this coin may
// only move in a transaction whose output at my input's index pays me my price". Everything
// else (who buys, which coins fund it, where the inscription lands, the change) is the
// buyer's to build. Settlement is atomic: the same transaction pays the seller and delivers
// the carrier, so no party (and no server) ever holds both sides.
//
// Final transaction layout (the padded ordinal-listing shape):
//   vin[0]  buyer pad A (dust)          vout[0]  padA + padB + offset -> buyer  (padding-out)
//   vin[1]  buyer pad B (dust)          vout[1]  POSTAGE -> buyer  (new carrier, inscription @ 0)
//   vin[2]  seller carrier (signed)     vout[2]  price -> seller  (signed, SELLER_INDEX)
//   vin[3+] buyer funds                 vout[3]  change -> buyer (optional)
//
// The two pad inputs push the carrier to global input index 2 so SIGHASH_SINGLE pairs it with
// vout[2] (the price). vout[0] is sized to swallow exactly the two pads PLUS the carrier's
// pre-inscription sats (its offset), so the inscribed sat becomes the FIRST unit of vout[1].
// That resets the inscription to offset 0 inside a fresh, constant POSTAGE carrier: the "locked"
// value never grows, and it travels out of the seller's carrier into the buyer's new one. The
// leftover carrier value (beyond one postage) is returned to the buyer as change.
//
// The seller's signature also pins nVersion, nTime and nLockTime, so the completed transaction
// must reuse the listing's values verbatim.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const {
  serializeTx, txid, legacySighash,
  SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY,
} = require('./vergetx');

const SELLER_INDEX = 2; // the seller's input/output index in the final transaction
const LISTING_SIGHASH = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY;
const POSTAGE_UNITS = 100000; // 0.1 XVG: the constant value a Verginal-bearing carrier holds

/** P2PKH scriptPubKey for an address on `network`. */
function p2pkhScript(address, network) {
  return bitcoin.address.toOutputScript(address, network);
}

/** The listing template the seller signs: carrier at SELLER_INDEX, price at the paired output. */
function listingTemplate(carrier, priceUnits, sellerScript, nTime) {
  // Two placeholder inputs sit before the carrier so it lands at input index SELLER_INDEX.
  // Under ANYONECANPAY only vin[SELLER_INDEX] is serialized; under SINGLE the lower outputs
  // serialize as null and higher ones are dropped, so the placeholders never reach the hash.
  return {
    version: 1,
    time: nTime,
    locktime: 0,
    vin: [
      { txid: '00'.repeat(32), vout: 0 },
      { txid: '00'.repeat(32), vout: 1 },
      { txid: carrier.txid, vout: carrier.vout },
    ],
    vout: [
      { value: 0, script: Buffer.alloc(0) },
      { value: 0, script: Buffer.alloc(0) },
      { value: priceUnits, script: sellerScript },
    ],
  };
}

/**
 * Build and half-sign a listing.
 * @param {Object} p
 * @param {Object} p.network      bitcoinjs network (Verge params)
 * @param {Object} p.carrier      { txid, vout, value } the inscription-carrying UTXO (P2PKH)
 * @param {number} p.priceUnits   what the seller must receive, in atomic units
 * @param {string} p.sellerAddress where the price is paid (usually the carrier's own address)
 * @param {Object} p.sellerKey    ECPair controlling the carrier
 * @param {number} [p.time]       transaction nTime (pinned by the signature; defaults to now)
 * @returns a JSON-safe listing object: everything a buyer needs, no private material
 */
function buildListing({ network, carrier, priceUnits, sellerAddress, sellerKey, time }) {
  if (!(priceUnits > 0)) throw new Error('price must be positive');
  const nTime = time == null ? Math.floor(Date.now() / 1000) : time;
  const sellerScript = p2pkhScript(sellerAddress, network);
  const tx = listingTemplate(carrier, priceUnits, sellerScript, nTime);

  const carrierScript = bitcoin.payments.p2pkh({ pubkey: Buffer.from(sellerKey.publicKey), network }).output;
  const sighash = legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  const priv = Buffer.from(sellerKey.privateKey);
  const sig = Buffer.from(ecc.sign(sighash, priv));
  if (!ecc.verify(sighash, Buffer.from(sellerKey.publicKey), sig)) throw new Error('listing signature self-check failed');
  const scriptSig = bitcoin.script.compile([
    bitcoin.script.signature.encode(sig, LISTING_SIGHASH),
    Buffer.from(sellerKey.publicKey),
  ]);

  return {
    kind: 'verginals-listing-v2',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits,
    sellerAddress,
    time: nTime,
    version: 1,
    locktime: 0,
    scriptSig: scriptSig.toString('hex'),
  };
}

/**
 * Complete a listing into a broadcastable transaction.
 * @param {Object} p
 * @param {Object} p.network
 * @param {Object} p.listing       as produced by buildListing
 * @param {Array}  p.pads          exactly two small buyer coins [{ txid, vout, value }] (indices 0,1)
 * @param {Array}  p.funds         [{ txid, vout, value }] buyer coins paying the price + fee
 * @param {string} p.buyerAddress  where the inscription output and the change go
 * @param {Object} p.buyerKey      ECPair controlling pads + funds
 * @param {number} p.feeUnits      miner fee
 * @param {number} p.carrierOffset the inscribed sat's unit offset inside the carrier (from the indexer)
 * @param {number} [p.postage]     the constant carrier value to leave with the buyer (default POSTAGE_UNITS)
 * @returns {{ hex: string, txid: string, outputs: Array }} ready to broadcast
 */
function completeListing({ network, listing, pads, funds, buyerAddress, buyerKey, feeUnits, carrierOffset, postage }) {
  if (!Array.isArray(pads) || pads.length !== SELLER_INDEX) {
    throw new Error(`a swap needs exactly ${SELLER_INDEX} small pad coins`);
  }
  const g = carrierOffset || 0;
  const post = postage == null ? POSTAGE_UNITS : postage;
  const carrierValue = listing.carrier.value;
  if (carrierValue - g < post) {
    throw new Error('carrier is too small to reset the inscription onto a fresh postage');
  }
  const buyerScript = p2pkhScript(buyerAddress, network);
  const sellerScript = p2pkhScript(listing.sellerAddress, network);
  const padTotal = pads.reduce((s, u) => s + u.value, 0);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const totalIn = padTotal + carrierValue + fundsTotal;

  const padOut = padTotal + g; // returns the pads and the carrier's pre-inscription sats to the buyer
  const change = totalIn - padOut - post - listing.priceUnits - feeUnits;
  if (change < 0) throw new Error('buyer funds do not cover price + fee');

  const vout = [
    { value: padOut, script: buyerScript }, // padding-out -> buyer (resets the inscription to offset 0)
    { value: post, script: buyerScript }, // new carrier -> buyer (inscription @ offset 0)
    { value: listing.priceUnits, script: sellerScript }, // exactly what the seller signed
  ];
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    ...pads.map((u) => ({ txid: u.txid, vout: u.vout })),
    { txid: listing.carrier.txid, vout: listing.carrier.vout, script: Buffer.from(listing.scriptSig, 'hex') },
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout })),
  ];
  const tx = { version: listing.version, time: listing.time, locktime: listing.locktime, vin, vout };

  // Cross-check the seller's half-signature against the FINAL transaction before spending
  // buyer funds on it: recomputing the SINGLE|ANYONECANPAY hash here must match what the
  // seller signed at listing time, whatever we put in the buyer-controlled slots.
  const sellerPub = bitcoin.script.decompile(Buffer.from(listing.scriptSig, 'hex'))[1];
  const sellerSigEncoded = bitcoin.script.decompile(Buffer.from(listing.scriptSig, 'hex'))[0];
  const carrierScript = bitcoin.payments.p2pkh({ pubkey: sellerPub, network }).output;
  const check = legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  const { signature } = bitcoin.script.signature.decode(sellerSigEncoded);
  if (!ecc.verify(check, sellerPub, signature)) {
    throw new Error('listing signature does not verify against the completed transaction');
  }

  // Sign every buyer input (pads + funds) with plain SIGHASH_ALL.
  const buyerPub = Buffer.from(buyerKey.publicKey);
  const buyerP2pkh = bitcoin.payments.p2pkh({ pubkey: buyerPub, network }).output;
  const priv = Buffer.from(buyerKey.privateKey);
  for (let i = 0; i < vin.length; i++) {
    if (i === SELLER_INDEX) continue;
    const sighash = legacySighash(tx, i, buyerP2pkh, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, buyerPub, sig)) throw new Error(`buyer signature self-check failed for input ${i}`);
    vin[i].script = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), buyerPub]);
  }

  const hex = serializeTx(tx).toString('hex');
  return { hex, txid: txid(tx), outputs: vout.map((o) => ({ value: o.value })) };
}

/** The P2PKH address that produced a scriptSig `[sig, pubkey]`, on `network`. */
function addressOfScriptSig(scriptSigHex, network) {
  const parts = bitcoin.script.decompile(Buffer.from(scriptSigHex, 'hex'));
  if (!parts || parts.length !== 2 || !Buffer.isBuffer(parts[1])) return null;
  try {
    return bitcoin.payments.p2pkh({ pubkey: parts[1], network }).address;
  } catch (_) {
    return null;
  }
}

/**
 * Verify a single listing variant with NO buyer data: reconstruct the exact template the seller
 * signed (carrier at SELLER_INDEX, price to sellerAddress at the paired output, the given nTime)
 * and check the SINGLE|ANYONECANPAY signature. Returns { ok, address } where address is the
 * signer's P2PKH address; the caller must confirm it owns the carrier on-chain.
 */
function verifyListingVariant({ network, carrier, priceUnits, sellerAddress, time, scriptSig }) {
  const parts = bitcoin.script.decompile(Buffer.from(scriptSig, 'hex'));
  if (!parts || parts.length !== 2 || !Buffer.isBuffer(parts[0]) || !Buffer.isBuffer(parts[1])) return { ok: false };
  const pubkey = parts[1];
  const address = (() => { try { return bitcoin.payments.p2pkh({ pubkey, network }).address; } catch { return null; } })();
  if (!address) return { ok: false };
  const tx = listingTemplate(carrier, priceUnits, p2pkhScript(sellerAddress, network), time);
  const carrierScript = bitcoin.payments.p2pkh({ pubkey, network }).output;
  const sighash = legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  let sig;
  try { sig = bitcoin.script.signature.decode(parts[0]).signature; } catch { return { ok: false }; }
  return { ok: ecc.verify(sighash, pubkey, sig), address };
}

/**
 * Verify a bid's buyer signatures against the transaction it commits to (every input except the
 * carrier). Returns { ok, inputs } where inputs lists each signed input's { txid, vout, address }
 * so the caller can confirm those coins are unspent and owned by the buyer.
 */
function verifyBid({ network, bid }) {
  const vout = bid.vout.map((o) => ({ value: o.value, script: Buffer.from(o.script, 'hex') }));
  const vin = bid.vin.map((v, i) => ({
    txid: v.txid, vout: v.vout,
    script: bid.scriptSigs[i] ? Buffer.from(bid.scriptSigs[i], 'hex') : undefined,
  }));
  const tx = { version: bid.version, time: bid.time, locktime: bid.locktime, vin, vout };
  const inputs = [];
  for (let i = 0; i < vin.length; i++) {
    if (i === SELLER_INDEX) continue; // carrier, unsigned by design
    const ss = bid.scriptSigs[i];
    if (!ss) return { ok: false };
    const parts = bitcoin.script.decompile(Buffer.from(ss, 'hex'));
    if (!parts || parts.length !== 2 || !Buffer.isBuffer(parts[1])) return { ok: false };
    const pubkey = parts[1];
    const p2pkh = bitcoin.payments.p2pkh({ pubkey, network });
    const sighash = legacySighash(tx, i, p2pkh.output, SIGHASH_ALL);
    let sig;
    try { sig = bitcoin.script.signature.decode(parts[0]).signature; } catch { return { ok: false }; }
    if (!ecc.verify(sighash, pubkey, sig)) return { ok: false };
    inputs.push({ txid: vin[i].txid, vout: vin[i].vout, address: p2pkh.address });
  }
  return { ok: true, inputs };
}

// Default variant schedule (seconds from listing time), spanning a 30-day listing: dense near
// the start so a fresh-coin buyer waits minutes, sparse later to keep the message small. See
// spec section 2.1 for why a listing needs multiple nTime variants.
const DEFAULT_SCHEDULE = [0, 900, 3600, 14400, 43200, 86400, 172800, 345600, 604800, 1209600, 2592000];

/**
 * Sign a full listing: the same sale re-signed at each scheduled nTime, so a buyer can later
 * pick a variant valid for the age of their coins (spec 2.1). Returns one listing object whose
 * `variants` array holds { time, scriptSig }; everything else (carrier, price) is shared.
 */
function buildListingSchedule({ network, carrier, priceUnits, sellerAddress, sellerKey, startTime, offsets }) {
  const t0 = startTime == null ? Math.floor(Date.now() / 1000) : startTime;
  const sched = offsets || DEFAULT_SCHEDULE;
  const variants = sched.map((off) => {
    const l = buildListing({ network, carrier, priceUnits, sellerAddress, sellerKey, time: t0 + off });
    return { time: l.time, scriptSig: l.scriptSig };
  });
  return {
    kind: 'verginals-listing-v2',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits,
    sellerAddress,
    version: 1,
    locktime: 0,
    startTime: t0,
    expiresAt: t0 + sched[sched.length - 1],
    variants,
  };
}

/**
 * Choose the best usable variant for a buyer: the one with the largest nTime that is already
 * minable (time <= now) and not older than the buyer's newest coin (time >= maxCoinTime, so R1
 * holds). Returns a single-variant listing ready for completeListing, or null if none fits yet.
 */
function pickVariant(listing, { now, maxCoinTime }) {
  const usable = listing.variants
    .filter((v) => v.time <= now && v.time >= maxCoinTime)
    .sort((a, b) => b.time - a.time);
  if (!usable.length) return null;
  const v = usable[0];
  return {
    kind: 'verginals-listing-v2',
    carrier: listing.carrier,
    priceUnits: listing.priceUnits,
    sellerAddress: listing.sellerAddress,
    time: v.time,
    version: listing.version,
    locktime: listing.locktime,
    scriptSig: v.scriptSig,
  };
}

/**
 * Build a bid: the buyer builds the WHOLE transaction against a public carrier outpoint, pins
 * nTime = now, and signs only their own inputs (SIGHASH_ALL). The carrier input at SELLER_INDEX
 * is left unsigned for the seller to fill on acceptance. No timestamp constraint (spec 3). The
 * padded layout mirrors completeListing so an accepted offer leaves the inscription on a fresh
 * constant-postage carrier too.
 * @returns a JSON-safe bid: the unsigned-carrier transaction plus its metadata.
 */
function buildBid({ network, carrier, priceUnits, sellerAddress, pads, funds, buyerAddress, buyerKey, feeUnits, feeOutput, carrierOffset, postage, time }) {
  if (!(priceUnits > 0)) throw new Error('price must be positive');
  if (!Array.isArray(pads) || pads.length !== SELLER_INDEX) {
    throw new Error(`a bid needs exactly ${SELLER_INDEX} small pad coins`);
  }
  const g = carrierOffset || 0;
  const post = postage == null ? POSTAGE_UNITS : postage;
  if (carrier.value - g < post) throw new Error('carrier is too small to reset the inscription onto a fresh postage');
  const nTime = time == null ? Math.floor(Date.now() / 1000) : time;
  const buyerScript = p2pkhScript(buyerAddress, network);
  const sellerScript = p2pkhScript(sellerAddress, network);
  const fee = feeOutput ? feeOutput.value : 0;
  const padTotal = pads.reduce((s, u) => s + u.value, 0);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const totalIn = padTotal + carrier.value + fundsTotal;
  const padOut = padTotal + g;
  const change = totalIn - padOut - post - priceUnits - feeUnits - fee;
  if (change < 0) throw new Error('bid funds do not cover price + fee');

  const vout = [
    { value: padOut, script: buyerScript },
    { value: post, script: buyerScript },
    { value: priceUnits, script: sellerScript },
  ];
  if (feeOutput) vout.push({ value: feeOutput.value, script: p2pkhScript(feeOutput.address, network) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    ...pads.map((u) => ({ txid: u.txid, vout: u.vout })),
    { txid: carrier.txid, vout: carrier.vout }, // seller fills this on acceptance
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout })),
  ];
  const tx = { version: 1, time: nTime, locktime: 0, vin, vout };

  const buyerPub = Buffer.from(buyerKey.publicKey);
  const buyerP2pkh = bitcoin.payments.p2pkh({ pubkey: buyerPub, network }).output;
  const priv = Buffer.from(buyerKey.privateKey);
  const scriptSigs = {}; // index -> hex, buyer inputs only
  for (let i = 0; i < vin.length; i++) {
    if (i === SELLER_INDEX) continue;
    const sighash = legacySighash(tx, i, buyerP2pkh, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, buyerPub, sig)) throw new Error(`bid signature self-check failed for input ${i}`);
    scriptSigs[i] = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), buyerPub]).toString('hex');
  }

  return {
    kind: 'verginals-bid-v2',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits,
    sellerAddress,
    buyerAddress,
    time: nTime,
    version: 1,
    locktime: 0,
    vin: vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    vout: vout.map((o) => ({ value: o.value, script: o.script.toString('hex') })),
    scriptSigs,
  };
}

/**
 * Accept a bid: the seller signs the carrier input (SIGHASH_ALL) with their key and returns the
 * broadcastable transaction. The seller changes nothing, the buyer already committed the whole
 * transaction, so acceptance is a pure yes/no.
 */
function acceptBid({ network, bid, sellerKey }) {
  const vout = bid.vout.map((o) => ({ value: o.value, script: Buffer.from(o.script, 'hex') }));
  const vin = bid.vin.map((v, i) => ({
    txid: v.txid,
    vout: v.vout,
    script: bid.scriptSigs[i] ? Buffer.from(bid.scriptSigs[i], 'hex') : undefined,
  }));
  const tx = { version: bid.version, time: bid.time, locktime: bid.locktime, vin, vout };

  const sellerPub = Buffer.from(sellerKey.publicKey);
  const carrierScript = bitcoin.payments.p2pkh({ pubkey: sellerPub, network }).output;
  const sighash = legacySighash(tx, SELLER_INDEX, carrierScript, SIGHASH_ALL);
  const priv = Buffer.from(sellerKey.privateKey);
  const sig = Buffer.from(ecc.sign(sighash, priv));
  if (!ecc.verify(sighash, sellerPub, sig)) throw new Error('accept signature self-check failed');
  vin[SELLER_INDEX].script = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), sellerPub]);

  return { hex: serializeTx(tx).toString('hex'), txid: txid(tx) };
}

module.exports = {
  buildListing, completeListing, buildListingSchedule, pickVariant, buildBid, acceptBid,
  verifyListingVariant, verifyBid, addressOfScriptSig,
  SELLER_INDEX, LISTING_SIGHASH, POSTAGE_UNITS, DEFAULT_SCHEDULE,
};
