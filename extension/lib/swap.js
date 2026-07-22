// Trustless marketplace primitives for the browser wallet (ESM, MV3-safe, Uint8Array in/out).
// Byte-for-byte mirror of src/swap.js, proven against it in extension/test-swap.mjs. See
// spec/MARKETPLACE-SPEC-v0.md for the transaction layout and the two Verge timestamp rules.
//
// The seller half-signs their carrier input with SIGHASH_SINGLE|ANYONECANPAY (commits only
// "vout[2] pays me my price"); the buyer completes with two dust pads at vin[0..1], funds and
// change. Two pads push the carrier to input index 2 so SIGHASH_SINGLE pairs it with the price;
// vout[0] swallows the pads plus the carrier's pre-inscription sats so the inscribed sat becomes
// the first unit of vout[1], a fresh constant-POSTAGE carrier. Bids invert it: the buyer builds
// and SIGHASH_ALL-signs the whole transaction, the seller accepts by signing the carrier input.

import * as V from './verge.js';

export const SELLER_INDEX = 2;
export const LISTING_SIGHASH = V.SIGHASH_SINGLE | V.SIGHASH_ANYONECANPAY;
export const POSTAGE_UNITS = 100000; // 0.1 XVG: the constant value a Verginal-bearing carrier holds
export const DEFAULT_SCHEDULE = [0, 900, 3600, 14400, 43200, 86400, 172800, 345600, 604800, 1209600, 2592000];

const ZERO_TXID = '00'.repeat(32);
const { concatBytes, bytesToHex, hexToBytes } = V;

/** pushData(sig) || pushData(pubkey) as a scriptSig (matches verge.js buildAndSignP2PKH). */
function scriptSig(sig, pubkey) {
  const push = (b) => {
    const len = b.length;
    if (len < 0x4c) return concatBytes(new Uint8Array([len]), b);
    if (len <= 0xff) return concatBytes(new Uint8Array([0x4c, len]), b);
    const two = new Uint8Array([0x4d, len & 0xff, (len >> 8) & 0xff]);
    return concatBytes(two, b);
  };
  return concatBytes(push(sig), push(pubkey));
}

/**
 * Half-sign one listing variant at nTime `time`. The seller signs the NET of the marketplace fee
 * (priceUnits - feeUnits); the buyer adds the fee output later, after the seller output, so it
 * stays outside the SIGHASH_SINGLE commitment. Returns { time, scriptSig(hex) }.
 */
export async function signListingVariant({ carrier, priceUnits, sellerAddress, priv, time, feeUnits }) {
  const sellerReceive = priceUnits - (feeUnits || 0);
  const pub = V.publicKeyFromPrivate(priv);
  const carrierScript = await V.p2pkhScript(await V.addressFromPubkey(pub));
  const tx = {
    version: 1, time, locktime: 0,
    vin: [
      { txid: ZERO_TXID, vout: 0 },
      { txid: ZERO_TXID, vout: 1 },
      { txid: carrier.txid, vout: carrier.vout },
    ],
    vout: [
      { value: 0, script: new Uint8Array(0) },
      { value: 0, script: new Uint8Array(0) },
      { value: sellerReceive, script: await V.p2pkhScript(sellerAddress) },
    ],
  };
  const sighash = await V.legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  const sig = await V.signHashWith(sighash, priv, LISTING_SIGHASH);
  return { time, scriptSig: bytesToHex(scriptSig(sig, pub)) };
}

/** Build a full listing (all scheduled variants) ready to POST to the order book. */
export async function buildListing({ carrier, priceUnits, sellerAddress, priv, startTime, offsets, feeUnits, feeAddress }) {
  const t0 = startTime == null ? Math.floor(Date.now() / 1000) : startTime;
  const sched = offsets || DEFAULT_SCHEDULE;
  const fee = feeUnits || 0;
  if (fee > 0 && !feeAddress) throw new Error('a fee needs a fee address');
  if (fee >= priceUnits) throw new Error('fee cannot exceed the price');
  const variants = [];
  for (const off of sched) variants.push(await signListingVariant({ carrier, priceUnits, sellerAddress, priv, time: t0 + off, feeUnits: fee }));
  return {
    kind: 'verginals-listing-v2',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits, feeUnits: fee, feeAddress: fee > 0 ? feeAddress : null,
    sellerAddress, version: 1, locktime: 0,
    startTime: t0, expiresAt: t0 + sched[sched.length - 1], variants,
  };
}

/**
 * Complete a chosen listing variant into a broadcastable transaction. Re-verifies the seller's
 * half-signature against the FINAL transaction before signing any buyer input, so a corrupted or
 * malicious variant can never spend the buyer's coins.
 * @returns {{ hex, txid, outputs }}
 */
export async function completeListing({ variant, pads, funds, buyerAddress, priv, feeUnits, carrierOffset, postage }) {
  if (!Array.isArray(pads) || pads.length !== SELLER_INDEX) throw new Error(`a swap needs exactly ${SELLER_INDEX} small pad coins`);
  const g = carrierOffset || 0;
  const post = postage == null ? POSTAGE_UNITS : postage;
  const carrierValue = variant.carrier.value;
  if (carrierValue - g < post) throw new Error('carrier is too small to reset the inscription onto a fresh postage');

  const buyerScript = await V.p2pkhScript(buyerAddress);
  const sellerScript = await V.p2pkhScript(variant.sellerAddress);
  const padTotal = pads.reduce((s, u) => s + u.value, 0);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const totalIn = padTotal + carrierValue + fundsTotal;
  const marketFee = variant.feeUnits || 0; // taken from the seller's proceeds, paid to the pool
  const sellerReceive = variant.priceUnits - marketFee; // exactly what the seller signed at vout[2]
  const padOut = padTotal + g;
  // Buyer cost is the full price (seller net + fee are two slices), so change ignores the market fee.
  const change = totalIn - padOut - post - variant.priceUnits - feeUnits;
  if (change < 0) throw new Error('funds do not cover price + fee');

  const vout = [
    { value: padOut, script: buyerScript },
    { value: post, script: buyerScript },
    { value: sellerReceive, script: sellerScript },
  ];
  if (marketFee > 0) vout.push({ value: marketFee, script: await V.p2pkhScript(variant.feeAddress) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const sellerScriptSig = hexToBytes(variant.scriptSig);
  const vin = [
    ...pads.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, script: new Uint8Array(0) })),
    { txid: variant.carrier.txid, vout: variant.carrier.vout, sequence: 0xffffffff, script: sellerScriptSig },
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, script: new Uint8Array(0) })),
  ];
  const tx = { version: variant.version, time: variant.time, locktime: variant.locktime, vin, vout };

  // Cross-check the seller signature against the assembled transaction.
  const sellerPub = V.pubkeyFromScriptSig(sellerScriptSig);
  if (!sellerPub) throw new Error('malformed seller scriptSig');
  const carrierScript = await V.p2pkhScript(await V.addressFromPubkey(sellerPub));
  const check = await V.legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  const sellerSig = readFirstPush(sellerScriptSig);
  if (!V.verifySig(check, sellerPub, sellerSig)) throw new Error('seller signature does not verify against this transaction');

  await signBuyerInputs(tx, priv, SELLER_INDEX);
  const ser = V.serializeTx(tx);
  return { hex: bytesToHex(ser), txid: await V.txid(tx), outputs: vout.map((o) => ({ value: o.value })) };
}

/** Build a bid: the buyer signs the whole transaction, leaving the carrier input for the seller. */
export async function buildBid({ carrier, priceUnits, sellerAddress, pads, funds, buyerAddress, priv, feeUnits, marketFeeUnits, feeAddress, carrierOffset, postage, time }) {
  if (!Array.isArray(pads) || pads.length !== SELLER_INDEX) throw new Error(`a bid needs exactly ${SELLER_INDEX} small pad coins`);
  const g = carrierOffset || 0;
  const post = postage == null ? POSTAGE_UNITS : postage;
  if (carrier.value - g < post) throw new Error('carrier is too small to reset the inscription onto a fresh postage');
  const marketFee = marketFeeUnits || 0; // taken from the seller's proceeds (same model as listings)
  const sellerReceive = priceUnits - marketFee;
  if (sellerReceive <= 0) throw new Error('fee cannot exceed the price');
  if (marketFee > 0 && !feeAddress) throw new Error('a fee needs a fee address');
  const nTime = time == null ? Math.floor(Date.now() / 1000) : time;
  const buyerScript = await V.p2pkhScript(buyerAddress);
  const sellerScript = await V.p2pkhScript(sellerAddress);
  const padTotal = pads.reduce((s, u) => s + u.value, 0);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const totalIn = padTotal + carrier.value + fundsTotal;
  const padOut = padTotal + g;
  const change = totalIn - padOut - post - priceUnits - feeUnits;
  if (change < 0) throw new Error('funds do not cover price + fee');

  const vout = [
    { value: padOut, script: buyerScript },
    { value: post, script: buyerScript },
    { value: sellerReceive, script: sellerScript },
  ];
  if (marketFee > 0) vout.push({ value: marketFee, script: await V.p2pkhScript(feeAddress) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    ...pads.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, script: new Uint8Array(0) })),
    { txid: carrier.txid, vout: carrier.vout, sequence: 0xffffffff, script: new Uint8Array(0) },
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, script: new Uint8Array(0) })),
  ];
  const tx = { version: 1, time: nTime, locktime: 0, vin, vout };
  const scriptSigs = await signBuyerInputs(tx, priv, SELLER_INDEX);

  return {
    kind: 'verginals-bid-v2',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits, feeUnits: marketFee, feeAddress: marketFee > 0 ? feeAddress : null,
    sellerAddress, buyerAddress, time: nTime, version: 1, locktime: 0,
    vin: vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    vout: vout.map((o) => ({ value: o.value, script: bytesToHex(o.script) })),
    scriptSigs,
  };
}

/** Accept a bid: the seller signs the carrier input and returns the broadcastable transaction. */
export async function acceptBid({ bid, priv }) {
  const vout = bid.vout.map((o) => ({ value: o.value, script: hexToBytes(o.script) }));
  const vin = bid.vin.map((v, i) => ({
    txid: v.txid, vout: v.vout, sequence: 0xffffffff,
    script: bid.scriptSigs[i] ? hexToBytes(bid.scriptSigs[i]) : new Uint8Array(0),
  }));
  const tx = { version: bid.version, time: bid.time, locktime: bid.locktime, vin, vout };
  const pub = V.publicKeyFromPrivate(priv);
  const carrierScript = await V.p2pkhScript(await V.addressFromPubkey(pub));
  const sighash = await V.legacySighash(tx, SELLER_INDEX, carrierScript, V.SIGHASH_ALL);
  const sig = await V.signHashWith(sighash, priv, V.SIGHASH_ALL);
  tx.vin[SELLER_INDEX].script = scriptSig(sig, pub);
  const ser = V.serializeTx(tx);
  return { hex: bytesToHex(ser), txid: await V.txid(tx) };
}

/** Pick the newest minable variant not older than the buyer's coins (see spec 2.1). */
export function pickVariant(listing, { now, maxCoinTime }) {
  const usable = listing.variants
    .filter((v) => v.time <= now && v.time >= maxCoinTime)
    .sort((a, b) => b.time - a.time);
  if (!usable.length) return null;
  const v = usable[0];
  return {
    kind: 'verginals-listing-v2', carrier: listing.carrier, priceUnits: listing.priceUnits,
    feeUnits: listing.feeUnits || 0, feeAddress: listing.feeAddress || null,
    sellerAddress: listing.sellerAddress, time: v.time, version: listing.version,
    locktime: listing.locktime, scriptSig: v.scriptSig,
  };
}

// --- internals -------------------------------------------------------------------------------
function readFirstPush(script) {
  let i = 0;
  const op = script[i++];
  let len;
  if (op < 0x4c) len = op;
  else if (op === 0x4c) len = script[i++];
  else { len = script[i] | (script[i + 1] << 8); i += 2; }
  return script.slice(i, i + len);
}

/** Sign every input except `skip` with the buyer key (SIGHASH_ALL); returns {index:hex}. */
async function signBuyerInputs(tx, priv, skip) {
  const pub = V.publicKeyFromPrivate(priv);
  const scriptCode = await V.p2pkhScript(await V.addressFromPubkey(pub));
  const out = {};
  for (let i = 0; i < tx.vin.length; i++) {
    if (i === skip) continue;
    const sighash = await V.legacySighash(tx, i, scriptCode, V.SIGHASH_ALL);
    const sig = await V.signHashWith(sighash, priv, V.SIGHASH_ALL);
    tx.vin[i].script = scriptSig(sig, pub);
    out[i] = bytesToHex(tx.vin[i].script);
  }
  return out;
}
