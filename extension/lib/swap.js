// Trustless marketplace primitives for the browser wallet (ESM, MV3-safe, Uint8Array in/out).
// Byte-for-byte mirror of src/swap.js, proven against it in extension/test-swap.mjs. See
// spec/MARKETPLACE-SPEC-v0.md for the transaction layout and the two Verge timestamp rules.
//
// The seller half-signs their carrier input with SIGHASH_SINGLE|ANYONECANPAY (commits only
// "vout[1] pays me my price"); the buyer completes with a dummy at vin[0], funds and change.
// Bids invert it: the buyer builds and SIGHASH_ALL-signs the whole transaction, the seller
// accepts by signing the carrier input.

import * as V from './verge.js';

export const SELLER_INDEX = 1;
export const LISTING_SIGHASH = V.SIGHASH_SINGLE | V.SIGHASH_ANYONECANPAY;
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

/** Half-sign one listing variant at nTime `time`. Returns { time, scriptSig(hex) }. */
export async function signListingVariant({ carrier, priceUnits, sellerAddress, priv, time }) {
  const pub = V.publicKeyFromPrivate(priv);
  const carrierScript = await V.p2pkhScript(await V.addressFromPubkey(pub));
  const tx = {
    version: 1, time, locktime: 0,
    vin: [{ txid: ZERO_TXID, vout: 0 }, { txid: carrier.txid, vout: carrier.vout }],
    vout: [{ value: 0, script: new Uint8Array(0) }, { value: priceUnits, script: await V.p2pkhScript(sellerAddress) }],
  };
  const sighash = await V.legacySighash(tx, SELLER_INDEX, carrierScript, LISTING_SIGHASH);
  const sig = await V.signHashWith(sighash, priv, LISTING_SIGHASH);
  return { time, scriptSig: bytesToHex(scriptSig(sig, pub)) };
}

/** Build a full listing (all scheduled variants) ready to POST to the order book. */
export async function buildListing({ carrier, priceUnits, sellerAddress, priv, startTime, offsets }) {
  const t0 = startTime == null ? Math.floor(Date.now() / 1000) : startTime;
  const sched = offsets || DEFAULT_SCHEDULE;
  const variants = [];
  for (const off of sched) variants.push(await signListingVariant({ carrier, priceUnits, sellerAddress, priv, time: t0 + off }));
  return {
    kind: 'verginals-listing-v1',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits, sellerAddress, version: 1, locktime: 0,
    startTime: t0, expiresAt: t0 + sched[sched.length - 1], variants,
  };
}

/**
 * Complete a chosen listing variant into a broadcastable transaction. Re-verifies the seller's
 * half-signature against the FINAL transaction before signing any buyer input, so a corrupted or
 * malicious variant can never spend the buyer's coins.
 * @returns {{ hex, txid, outputs }}
 */
export async function completeListing({ variant, dummy, funds, buyerAddress, priv, feeUnits }) {
  const buyerScript = await V.p2pkhScript(buyerAddress);
  const sellerScript = await V.p2pkhScript(variant.sellerAddress);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const change = fundsTotal - variant.priceUnits - feeUnits;
  if (change < 0) throw new Error('funds do not cover price + fee');

  const vout = [
    { value: dummy.value + variant.carrier.value, script: buyerScript },
    { value: variant.priceUnits, script: sellerScript },
  ];
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const sellerScriptSig = hexToBytes(variant.scriptSig);
  const vin = [
    { txid: dummy.txid, vout: dummy.vout, sequence: 0xffffffff, script: new Uint8Array(0) },
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
export async function buildBid({ carrier, priceUnits, sellerAddress, dummy, funds, buyerAddress, priv, feeUnits, feeOutput, time }) {
  const nTime = time == null ? Math.floor(Date.now() / 1000) : time;
  const buyerScript = await V.p2pkhScript(buyerAddress);
  const sellerScript = await V.p2pkhScript(sellerAddress);
  const fee = feeOutput ? feeOutput.value : 0;
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const change = fundsTotal - priceUnits - feeUnits - fee;
  if (change < 0) throw new Error('funds do not cover price + fee');

  const vout = [
    { value: dummy.value + carrier.value, script: buyerScript },
    { value: priceUnits, script: sellerScript },
  ];
  if (feeOutput) vout.push({ value: feeOutput.value, script: await V.p2pkhScript(feeOutput.address) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    { txid: dummy.txid, vout: dummy.vout, sequence: 0xffffffff, script: new Uint8Array(0) },
    { txid: carrier.txid, vout: carrier.vout, sequence: 0xffffffff, script: new Uint8Array(0) },
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, script: new Uint8Array(0) })),
  ];
  const tx = { version: 1, time: nTime, locktime: 0, vin, vout };
  const scriptSigs = await signBuyerInputs(tx, priv, SELLER_INDEX);

  return {
    kind: 'verginals-bid-v1',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
    priceUnits, sellerAddress, buyerAddress, time: nTime, version: 1, locktime: 0,
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
    kind: 'verginals-listing-v1', carrier: listing.carrier, priceUnits: listing.priceUnits,
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
