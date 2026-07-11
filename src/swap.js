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
// Final transaction layout (the classic ordinal-listing shape):
//   vin[0]  buyer's small "dummy" coin              vout[0]  dummy + carrier value -> buyer
//   vin[1]  seller's carrier (half-signed)          vout[1]  price -> seller  (signed)
//   vin[2+] buyer's funding coins                   vout[2]  change -> buyer (optional)
//
// vout[0] swallows the whole carrier, so by the indexer's FIFO sat-tracking the inscribed
// sat always lands with the buyer no matter where it sits inside the carrier. The seller's
// input must stay at index 1 (SIGHASH_SINGLE pairs an input with the output at ITS index).
//
// The seller's signature also pins nVersion, nTime and nLockTime, so the completed
// transaction must reuse the listing's values verbatim.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const {
  serializeTx, txid, legacySighash,
  SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY,
} = require('./vergetx');

const SELLER_INDEX = 1; // the seller's input/output index in the final transaction
const LISTING_SIGHASH = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY;

/** P2PKH scriptPubKey for an address on `network`. */
function p2pkhScript(address, network) {
  return bitcoin.address.toOutputScript(address, network);
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

  // Template with the final indices: a null placeholder where the buyer's dummy will sit.
  // Under ANYONECANPAY only vin[SELLER_INDEX] is serialized, and under SINGLE vout[0]
  // serializes as a null output, so the placeholder contents never reach the hash.
  const tx = {
    version: 1,
    time: nTime,
    locktime: 0,
    vin: [
      { txid: '00'.repeat(32), vout: 0 }, // buyer dummy placeholder
      { txid: carrier.txid, vout: carrier.vout },
    ],
    vout: [
      { value: 0, script: Buffer.alloc(0) }, // buyer inscription output placeholder
      { value: priceUnits, script: sellerScript },
    ],
  };

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
    kind: 'verginals-listing-v1',
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
 * @param {Object} p.dummy         { txid, vout, value } a small buyer coin (pads vout[0])
 * @param {Array}  p.funds         [{ txid, vout, value }] buyer coins paying the price + fee
 * @param {string} p.buyerAddress  where the inscription output and the change go
 * @param {Object} p.buyerKey      ECPair controlling dummy + funds
 * @param {number} p.feeUnits      miner fee
 * @returns {{ hex: string, txid: string, outputs: Array }} ready to broadcast
 */
function completeListing({ network, listing, dummy, funds, buyerAddress, buyerKey, feeUnits }) {
  const buyerScript = p2pkhScript(buyerAddress, network);
  const sellerScript = p2pkhScript(listing.sellerAddress, network);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const change = fundsTotal - listing.priceUnits - feeUnits;
  if (change < 0) throw new Error('buyer funds do not cover price + fee');

  const vout = [
    { value: dummy.value + listing.carrier.value, script: buyerScript }, // inscription -> buyer
    { value: listing.priceUnits, script: sellerScript }, // exactly what the seller signed
  ];
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    { txid: dummy.txid, vout: dummy.vout },
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

  // Sign every buyer input (dummy + funds) with plain SIGHASH_ALL.
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

module.exports = { buildListing, completeListing, SELLER_INDEX, LISTING_SIGHASH };
