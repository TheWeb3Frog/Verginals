'use strict';
// Verge Runes: a resting limit order, which is the thing Bitcoin Runes has no way to express.
//
// A rune LISTING has to sell a whole carrier (see swap.js in this directory, and the theft its test
// demonstrates). The reason is that SIGHASH_SINGLE|ANYONECANPAY lets a maker commit to ONE output,
// so a maker can commit to their payment or to the runestone, never to both. That is the same wall
// the Runes author hit in "variable offers", and it is real.
//
// It dissolves the moment you change WHO WRITES THE TRANSACTION. Here the BUYER builds the whole
// thing and signs SIGHASH_ALL; the seller signs SIGHASH_ALL later, against a transaction they can
// read in full. Both sides end up committed to the runestone and to every output, and neither has to
// be online while the other is: the buyer signs when placing the order, the seller when filling it.
//
// The buyer can do this and the maker cannot because A CARRIER'S BALANCE IS PUBLIC. The indexer tells
// the buyer exactly what that outpoint holds, so the buyer can write a runestone that splits it
// correctly without the seller present. That is also why safety REQUIRES naming the outpoint: an
// "any seller may fill this" bid is not merely weaker, it is free money for a passer by, who supplies
// no runes at all and writes the payment to themselves. There is no anonymous bid here.
//
// What it buys, in one line: a 37,000 bid can partially fill a 1,000,000 ask, so the lot disappears
// from the buy side without a single byte of wire change.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { SIGHASH_ALL, legacySighash, serializeTx, txid } = require('../vergetx');
const codec = require('./codec');
const { RuneState, applyTx, outpoint } = require('./indexer');

/** Fixed layout. Every index here is load-bearing, and the comments say which rule pins it. */
const CARRIER_INPUT = 0;  // the only unsigned input: the seller fills it on acceptance
const RUNESTONE = 0;      // OP_RETURN, never eligible to receive
const CHANGE_OUTPUT = 1;  // the seller's rune change, back on the carrier's OWN address
const TAKE_OUTPUT = 2;    // what the buyer is paying for
const PAY_OUTPUT = 3;     // the seller's money

const DUST_UNITS = 100000; // 0.1 XVG, the same floor the indexer uses to decide what may receive

// Why the seller's change sits at index 1 rather than after the buyer's output: the indexer sends
// everything the edicts did not allocate to the FIRST ELIGIBLE OUTPUT (spec section 3). Putting the
// seller's change there means the default path returns the runes to the seller. Any surprise, a
// message that failed to decode, an edict skipped for naming an ineligible output, lands in the
// seller's favour instead of handing a stranger's balance to the buyer. Ordering this the other way
// round is not a style choice, it is a silent theft.

function p2pkhScript(address, network) {
  const out = bitcoin.address.toOutputScript(address, network);
  if (out[0] !== 0x76) throw new Error('only P2PKH addresses are supported');
  return out;
}

/**
 * The transaction a bid is, before anybody signs it.
 *
 * One edict, not two. The buyer's share is named explicitly; the remainder is left to the default
 * assignment, which is the same code path a protocol-unaware wallet relies on and therefore the most
 * exercised one in the indexer. A second edict for the change would also make the outcome depend on
 * the sort being stable for two entries sharing a rune reference, which is an implementation detail
 * no other implementation is obliged to share.
 */
function bidTemplate({ network, carrier, runeRef, amount, priceUnits, buyerAddress, funds, feeUnits, marketFeeUnits, feeAddress, nTime, dustUnits }) {
  const dust = dustUnits == null ? DUST_UNITS : dustUnits;
  if (!(amount > 0) || !Number.isInteger(amount)) throw new Error('amount must be a positive whole number');
  if (!(priceUnits > 0) || !Number.isInteger(priceUnits)) throw new Error('price must be a positive whole number');
  if (!codec.parseRef(runeRef)) throw new Error('runeRef must be "<height>:<txIndex>"');
  // The carrier's own coin has to survive as a receiving output or the default assignment moves the
  // seller's change onto the buyer's output. Checked here AND in the verifier, because this one is
  // the difference between a trade and a theft.
  if (!(carrier.value >= dust)) throw new Error('the carrier holds less than the dust floor, its change could not be returned');

  const marketFee = marketFeeUnits || 0;
  const sellerReceive = priceUnits - marketFee;
  if (!(sellerReceive > 0)) throw new Error('the market fee cannot swallow the price');
  if (marketFee > 0 && !feeAddress) throw new Error('a market fee needs an address');

  const carrierScript = Buffer.from(carrier.script, 'hex');
  const buyerScript = p2pkhScript(buyerAddress, network);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const change = fundsTotal - dust - priceUnits - (feeUnits || 0);
  if (change < 0) throw new Error('the buyer\'s coins do not cover price, dust and fee');

  const vout = [
    { value: 0, script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, codec.encodeEdicts([{ runeRef, amount, output: TAKE_OUTPUT }])]) },
    { value: carrier.value, script: carrierScript },
    { value: dust, script: buyerScript },
    { value: sellerReceive, script: p2pkhScript(carrierAddress(carrier, network), network) },
  ];
  if (marketFee > 0) vout.push({ value: marketFee, script: p2pkhScript(feeAddress, network) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    { txid: carrier.txid, vout: carrier.vout },
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout })),
  ];
  return { tx: { version: 1, time: nTime, locktime: 0, vin, vout }, dust, marketFee, sellerReceive };
}

/** The seller is paid at the address their carrier already sits on, so they register nothing. */
function carrierAddress(carrier, network) {
  return bitcoin.address.fromOutputScript(Buffer.from(carrier.script, 'hex'), network);
}

/**
 * Place a limit order against one carrier.
 *
 * The buyer signs every input EXCEPT the carrier, with SIGHASH_ALL, so nothing about this
 * transaction can be changed by anyone. The seller's only move is yes or no.
 *
 * On nTime: the buyer stamps it once and there is no schedule of variants, unlike a listing. R1 is
 * satisfied because the carrier and the buyer's coins all existed before the order was placed, and
 * R2 is satisfied because time only moves forward. A resting bid therefore stays fillable for as
 * long as its coins are unspent, with one signature per candidate rather than eleven.
 */
function buildRuneBid({ network, carrier, runeRef, amount, priceUnits, buyerAddress, buyerKey, funds, feeUnits, marketFeeUnits, feeAddress, time, dustUnits }) {
  const nTime = time == null ? Math.floor(Date.now() / 1000) : Number(time);
  const { tx, marketFee } = bidTemplate({
    network, carrier, runeRef, amount, priceUnits, buyerAddress, funds,
    feeUnits, marketFeeUnits, feeAddress, nTime, dustUnits,
  });

  const buyerPub = Buffer.from(buyerKey.publicKey);
  const buyerP2pkh = bitcoin.payments.p2pkh({ pubkey: buyerPub, network }).output;
  const priv = Buffer.from(buyerKey.privateKey);
  const scriptSigs = {};
  for (let i = 0; i < tx.vin.length; i++) {
    if (i === CARRIER_INPUT) continue;
    const sighash = legacySighash(tx, i, buyerP2pkh, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, buyerPub, sig)) throw new Error(`bid signature self-check failed at input ${i}`);
    scriptSigs[i] = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), buyerPub]).toString('hex');
  }

  return {
    kind: 'verge-rune-bid-v1',
    carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value, script: carrier.script },
    runeRef,
    amount,
    priceUnits,
    feeUnits: marketFee,
    feeAddress: marketFee > 0 ? feeAddress : null,
    buyerAddress,
    time: nTime,
    version: 1,
    locktime: 0,
    vin: tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    vout: tx.vout.map((o) => ({ value: o.value, script: o.script.toString('hex') })),
    scriptSigs,
  };
}

/** Rebuild the transaction a bid describes, with the buyer's signatures in place. */
function bidTx(bid) {
  return {
    version: bid.version,
    time: bid.time,
    locktime: bid.locktime,
    vin: bid.vin.map((v, i) => ({
      txid: v.txid, vout: v.vout,
      script: bid.scriptSigs[i] ? Buffer.from(bid.scriptSigs[i], 'hex') : undefined,
    })),
    vout: bid.vout.map((o) => ({ value: o.value, script: Buffer.from(o.script, 'hex') })),
  };
}

/**
 * Would signing this bid do what it claims?
 *
 * `onChain` is what the SELLER'S OWN NODE says about the carrier: its value, its scriptPubKey and the
 * runes it holds. Nothing in the bid is taken on trust, because a bid arrives from a stranger.
 *
 * The last check is the one that matters and it is not a re-derivation of the protocol rules: it runs
 * the REAL INDEXER over the proposed transaction and reads the result. A rule change that would move
 * these coins somewhere else changes this answer too, instead of leaving a second copy of the rules
 * here to drift out of step with the first.
 */
function verifyRuneBid({ network, bid, onChain, dustUnits }) {
  const dust = dustUnits == null ? DUST_UNITS : dustUnits;
  const bad = (reason) => ({ ok: false, reason });

  if (!bid || bid.kind !== 'verge-rune-bid-v1') return bad('not a rune bid');
  if (!Array.isArray(bid.vin) || !Array.isArray(bid.vout)) return bad('malformed bid');
  if (bid.vout.length < 4) return bad('a bid needs at least the runestone, the change, the take and the payment');
  if (!Number.isInteger(bid.amount) || bid.amount <= 0) return bad('the amount is not a positive whole number');
  if (!Number.isInteger(bid.priceUnits) || bid.priceUnits <= 0) return bad('the price is not a positive whole number');

  // 1) It must be aimed at the carrier the seller thinks it is aimed at.
  if (bid.vin[CARRIER_INPUT].txid !== onChain.txid || bid.vin[CARRIER_INPUT].vout !== onChain.vout) {
    return bad('the bid does not spend this carrier');
  }
  if (bid.scriptSigs[CARRIER_INPUT]) return bad('the carrier input is already signed, it must be left blank');
  if (bid.carrier.value !== onChain.value) return bad(`the bid says the carrier holds ${bid.carrier.value}, the chain says ${onChain.value}`);
  if (bid.carrier.script !== onChain.script) return bad('the bid names a different script for the carrier than the chain does');

  // 2) The change has to come home, and it has to be able to receive.
  if (bid.vout[CHANGE_OUTPUT].script !== onChain.script) {
    return bad('the rune change does not return to the carrier\'s own address');
  }
  if (bid.vout[CHANGE_OUTPUT].value < dust) return bad('the rune change output is below the dust floor and could not receive');
  if (bid.vout[TAKE_OUTPUT].value < dust) return bad('the buyer\'s output is below the dust floor');

  // 3) The money. The seller reads their own payment off the transaction rather than off the label.
  let payAddress;
  try { payAddress = bitcoin.address.fromOutputScript(Buffer.from(bid.vout[PAY_OUTPUT].script, 'hex'), network); }
  catch (e) { return bad('the payment output is not a standard address'); }
  let carrierAddr;
  try { carrierAddr = bitcoin.address.fromOutputScript(Buffer.from(onChain.script, 'hex'), network); }
  catch (e) { return bad('the carrier is not on a standard address'); }
  if (payAddress !== carrierAddr) return bad('the payment does not go to the carrier\'s own address');
  const expectedPay = bid.priceUnits - (bid.feeUnits || 0);
  if (bid.vout[PAY_OUTPUT].value !== expectedPay) {
    return bad(`the payment output is ${bid.vout[PAY_OUTPUT].value}, the stated price less fee is ${expectedPay}`);
  }

  // 4) Every buyer signature, against the transaction as it stands. A signature that does not verify
  //    here would fail at broadcast, after the seller had already given up their carrier.
  const tx = bidTx(bid);
  for (let i = 0; i < bid.vin.length; i++) {
    if (i === CARRIER_INPUT) continue;
    const ss = bid.scriptSigs[i];
    if (!ss) return bad(`input ${i} is unsigned`);
    let parts;
    try { parts = bitcoin.script.decompile(Buffer.from(ss, 'hex')); } catch (e) { return bad(`input ${i} has an unreadable scriptSig`); }
    if (!parts || parts.length !== 2 || !Buffer.isBuffer(parts[0]) || !Buffer.isBuffer(parts[1])) return bad(`input ${i} is not a P2PKH spend`);
    const pubkey = parts[1];
    let sig;
    try { sig = bitcoin.script.signature.decode(parts[0]); } catch (e) { return bad(`input ${i} has an undecodable signature`); }
    // Belt and braces, honestly labelled: the sighash below is computed with SIGHASH_ALL hardcoded,
    // so a signature made under any other hash type already fails to verify. This check exists so the
    // refusal says WHY, and so that a later refactor which reads the hash type out of the scriptSig
    // (the natural looking change) cannot quietly start accepting a buyer who committed to one output.
    if (sig.hashType !== SIGHASH_ALL) return bad(`input ${i} is not signed SIGHASH_ALL, so the buyer has not committed to the whole transaction`);
    const p2pkh = bitcoin.payments.p2pkh({ pubkey, network });
    const sighash = legacySighash(tx, i, p2pkh.output, SIGHASH_ALL);
    if (!ecc.verify(sighash, pubkey, sig.signature)) return bad(`input ${i}'s signature does not verify`);
  }

  // 5) Run it through the indexer and read the outcome. This is the whole check, and the rest above
  //    is only there to give a useful reason before it fails.
  const held = Number((onChain.runes || {})[bid.runeRef] || 0);
  if (held < bid.amount) return bad(`the carrier holds ${held} of ${bid.runeRef}, the bid asks for ${bid.amount}`);

  const sim = new RuneState();
  for (const [ref, amt] of Object.entries(onChain.runes || {})) sim.credit(outpoint(onChain.txid, onChain.vout), ref, Number(amt));
  const simTxid = txid(tx);
  applyTx(sim, {
    txid: simTxid,
    height: (onChain.height || 0) + 1,
    txIndex: 0,
    inputs: bid.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    outputs: bid.vout.map((o, i) => ({
      value: o.value,
      scriptPubKey: Buffer.from(o.script, 'hex'),
      isOpReturn: i === RUNESTONE,
      opReturnData: i === RUNESTONE ? opReturnPayload(o.script) : undefined,
    })),
  }, { dustUnits: dust });

  const gotBuyer = sim.balanceOf(outpoint(simTxid, TAKE_OUTPUT), bid.runeRef);
  const gotSeller = sim.balanceOf(outpoint(simTxid, CHANGE_OUTPUT), bid.runeRef);
  if (gotBuyer !== bid.amount) return bad(`simulated: the buyer would receive ${gotBuyer}, not ${bid.amount}`);
  if (gotSeller !== held - bid.amount) return bad(`simulated: the change would be ${gotSeller}, not ${held - bid.amount}`);

  // Every other rune on the carrier has to come home too. A carrier can hold several runes at once,
  // and a bid that quietly walked off with the ones it did not name would be the same theft wearing
  // a different hat.
  for (const [ref, amt] of Object.entries(onChain.runes || {})) {
    if (ref === bid.runeRef) continue;
    const back = sim.balanceOf(outpoint(simTxid, CHANGE_OUTPUT), ref);
    if (back !== Number(amt)) return bad(`simulated: ${back} of ${ref} would come back, not ${amt}`);
  }

  return { ok: true, receives: expectedPay, gives: bid.amount, keeps: held - bid.amount };
}

/** The data push out of an `OP_RETURN <push>` script, or undefined. */
function opReturnPayload(scriptHex) {
  const parts = bitcoin.script.decompile(Buffer.from(scriptHex, 'hex'));
  if (!parts || parts.length !== 2 || parts[0] !== bitcoin.opcodes.OP_RETURN || !Buffer.isBuffer(parts[1])) return undefined;
  return parts[1];
}

/**
 * Fill a bid: sign the carrier input and hand back something broadcastable.
 *
 * Verify first. This function deliberately does NOT verify for you, because it cannot: it does not
 * know what the chain says about the carrier, and a check that has to invent its own facts is worse
 * than no check at all.
 */
function acceptRuneBid({ network, bid, sellerKey }) {
  const tx = bidTx(bid);
  const sellerPub = Buffer.from(sellerKey.publicKey);
  const carrierScript = bitcoin.payments.p2pkh({ pubkey: sellerPub, network }).output;
  if (carrierScript.toString('hex') !== bid.carrier.script) {
    throw new Error('this key does not own the carrier the bid is aimed at');
  }
  const sighash = legacySighash(tx, CARRIER_INPUT, carrierScript, SIGHASH_ALL);
  const sig = Buffer.from(ecc.sign(sighash, Buffer.from(sellerKey.privateKey)));
  if (!ecc.verify(sighash, sellerPub, sig)) throw new Error('accept signature self-check failed');
  tx.vin[CARRIER_INPUT].script = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), sellerPub]);
  return { hex: serializeTx(tx).toString('hex'), txid: txid(tx) };
}

module.exports = {
  CARRIER_INPUT, RUNESTONE, CHANGE_OUTPUT, TAKE_OUTPUT, PAY_OUTPUT, DUST_UNITS,
  bidTemplate, buildRuneBid, verifyRuneBid, acceptRuneBid, bidTx,
};
