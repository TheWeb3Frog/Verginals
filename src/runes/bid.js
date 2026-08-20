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
// SEVERAL CARRIERS, ONE SELLER. A bid may spend more than one of the seller's carriers at once, and
// it has to. A holding fragments the moment it is used: sell 20,000 of 50,000 and the rest comes back
// on a new outpoint, so after a week of trading a seller's stock is in pieces. A bid limited to one
// carrier would then refuse a perfectly ordinary sale, which is the lot problem climbing back in
// through the window. Every carrier in one bid must sit on the SAME script, because the change and
// the payment go to one address and mixing two owners would hand one seller's balance to the other.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { SIGHASH_ALL, legacySighash, serializeTx, txid } = require('../vergetx');
const codec = require('./codec');
const { RuneState, applyTx, outpoint } = require('./indexer');

/** Fixed layout. Every index here is load-bearing, and the comments say which rule pins it. */
const RUNESTONE = 0;      // OP_RETURN, never eligible to receive
const CHANGE_OUTPUT = 1;  // the seller's rune change, back on the carriers' OWN address
const TAKE_OUTPUT = 2;    // what the buyer is paying for
const PAY_OUTPUT = 3;     // the seller's money
const FIRST_FUND = (n) => n; // the buyer's coins start after the n carriers

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

/** Normalise one-or-many into the list the rest of the file works with, and refuse a mixed owner. */
function carrierList(carriers) {
  const list = Array.isArray(carriers) ? carriers : [carriers];
  if (list.length === 0) throw new Error('a bid needs at least one carrier');
  const script = list[0].script;
  for (const c of list) {
    if (c.script !== script) throw new Error('every carrier in one bid must sit on the same address');
  }
  const seen = new Set();
  for (const c of list) {
    const key = `${c.txid}:${c.vout}`;
    if (seen.has(key)) throw new Error(`carrier ${key} is named twice`);
    seen.add(key);
  }
  return list;
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
function bidTemplate({ network, carriers, runeRef, amount, priceUnits, buyerAddress, funds, feeUnits, marketFeeUnits, feeAddress, nTime, dustUnits }) {
  const dust = dustUnits == null ? DUST_UNITS : dustUnits;
  const list = carrierList(carriers);
  if (!(amount > 0) || !Number.isInteger(amount)) throw new Error('amount must be a positive whole number');
  if (!(priceUnits > 0) || !Number.isInteger(priceUnits)) throw new Error('price must be a positive whole number');
  if (!codec.parseRef(runeRef)) throw new Error('runeRef must be "<height>:<txIndex>"');

  const carriersValue = list.reduce((s, c) => s + c.value, 0);
  // The carriers' own coin has to survive as a receiving output or the default assignment moves the
  // seller's change onto the buyer's output. Checked here AND in the verifier, because this one is
  // the difference between a trade and a theft.
  if (!(carriersValue >= dust)) throw new Error('the carriers hold less than the dust floor, their change could not be returned');

  const marketFee = marketFeeUnits || 0;
  const sellerReceive = priceUnits - marketFee;
  if (!(sellerReceive > 0)) throw new Error('the market fee cannot swallow the price');
  if (marketFee > 0 && !feeAddress) throw new Error('a market fee needs an address');

  const carrierScript = Buffer.from(list[0].script, 'hex');
  const sellerAddress = bitcoin.address.fromOutputScript(carrierScript, network);
  const buyerScript = p2pkhScript(buyerAddress, network);
  const fundsTotal = funds.reduce((s, u) => s + u.value, 0);
  const change = fundsTotal - dust - priceUnits - (feeUnits || 0);
  if (change < 0) throw new Error('the buyer\'s coins do not cover price, dust and fee');

  const vout = [
    { value: 0, script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, codec.encodeEdicts([{ runeRef, amount, output: TAKE_OUTPUT }])]) },
    { value: carriersValue, script: carrierScript },
    { value: dust, script: buyerScript },
    { value: sellerReceive, script: p2pkhScript(sellerAddress, network) },
  ];
  if (marketFee > 0) vout.push({ value: marketFee, script: p2pkhScript(feeAddress, network) });
  if (change > 0) vout.push({ value: change, script: buyerScript });

  const vin = [
    ...list.map((c) => ({ txid: c.txid, vout: c.vout })),
    ...funds.map((u) => ({ txid: u.txid, vout: u.vout })),
  ];
  return { tx: { version: 1, time: nTime, locktime: 0, vin, vout }, list, dust, marketFee, sellerReceive };
}

/**
 * Place a limit order against one seller's carriers.
 *
 * The buyer signs every input EXCEPT the carriers, with SIGHASH_ALL, so nothing about this
 * transaction can be changed by anyone. The seller's only move is yes or no.
 *
 * On nTime: the buyer stamps it once and there is no schedule of variants, unlike a listing. R1 is
 * satisfied because the carriers and the buyer's coins all existed before the order was placed, and
 * R2 is satisfied because time only moves forward. A resting bid therefore stays fillable for as
 * long as its coins are unspent, with one signature per candidate rather than eleven.
 */
function buildRuneBid({ network, carriers, carrier, runeRef, amount, priceUnits, buyerAddress, buyerKey, funds, feeUnits, marketFeeUnits, feeAddress, time, dustUnits }) {
  const nTime = time == null ? Math.floor(Date.now() / 1000) : Number(time);
  const { tx, list, marketFee } = bidTemplate({
    network, carriers: carriers || carrier, runeRef, amount, priceUnits, buyerAddress, funds,
    feeUnits, marketFeeUnits, feeAddress, nTime, dustUnits,
  });

  const buyerPub = Buffer.from(buyerKey.publicKey);
  const buyerP2pkh = bitcoin.payments.p2pkh({ pubkey: buyerPub, network }).output;
  const priv = Buffer.from(buyerKey.privateKey);
  const scriptSigs = {};
  for (let i = list.length; i < tx.vin.length; i++) {
    const sighash = legacySighash(tx, i, buyerP2pkh, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, buyerPub, sig)) throw new Error(`bid signature self-check failed at input ${i}`);
    scriptSigs[i] = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), buyerPub]).toString('hex');
  }

  return {
    kind: 'verge-rune-bid-v1',
    carriers: list.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, script: c.script })),
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
 * `onChain` is a list of what the SELLER'S OWN NODE says about each carrier the bid names: its value,
 * its scriptPubKey and the runes it holds, in the same order. Nothing in the bid is taken on trust,
 * because a bid arrives from a stranger.
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
  if (!Array.isArray(bid.vin) || !Array.isArray(bid.vout) || !Array.isArray(bid.carriers)) return bad('malformed bid');
  if (bid.vout.length < 4) return bad('a bid needs at least the runestone, the change, the take and the payment');
  if (!Number.isInteger(bid.amount) || bid.amount <= 0) return bad('the amount is not a positive whole number');
  if (!Number.isInteger(bid.priceUnits) || bid.priceUnits <= 0) return bad('the price is not a positive whole number');

  const chain = Array.isArray(onChain) ? onChain : [onChain];
  const n = bid.carriers.length;
  if (n === 0) return bad('the bid names no carrier');
  if (chain.length !== n) return bad(`the bid names ${n} carriers, ${chain.length} were looked up`);

  // 1) It must be aimed at the carriers the seller thinks it is aimed at, and at nothing else.
  const script = chain[0].script;
  for (let k = 0; k < n; k++) {
    if (bid.vin[k].txid !== chain[k].txid || bid.vin[k].vout !== chain[k].vout) {
      return bad(`input ${k} does not spend the carrier it was looked up against`);
    }
    if (bid.scriptSigs[k]) return bad(`carrier input ${k} is already signed, it must be left blank`);
    if (bid.carriers[k].value !== chain[k].value) return bad(`the bid says carrier ${k} holds ${bid.carriers[k].value}, the chain says ${chain[k].value}`);
    if (bid.carriers[k].script !== chain[k].script) return bad(`the bid names a different script for carrier ${k} than the chain does`);
    if (chain[k].script !== script) return bad('the bid mixes carriers from different addresses');
  }

  // 2) The change has to come home, and it has to be able to receive.
  if (bid.vout[CHANGE_OUTPUT].script !== script) {
    return bad('the rune change does not return to the carriers\' own address');
  }
  const carriersValue = chain.reduce((s, c) => s + c.value, 0);
  if (bid.vout[CHANGE_OUTPUT].value !== carriersValue) return bad('the change output does not return the carriers\' own coin');
  if (bid.vout[CHANGE_OUTPUT].value < dust) return bad('the rune change output is below the dust floor and could not receive');
  if (bid.vout[TAKE_OUTPUT].value < dust) return bad('the buyer\'s output is below the dust floor');

  // 3) The money. The seller reads their own payment off the transaction rather than off the label.
  let payAddress, carrierAddr;
  try { payAddress = bitcoin.address.fromOutputScript(Buffer.from(bid.vout[PAY_OUTPUT].script, 'hex'), network); }
  catch (e) { return bad('the payment output is not a standard address'); }
  try { carrierAddr = bitcoin.address.fromOutputScript(Buffer.from(script, 'hex'), network); }
  catch (e) { return bad('the carriers are not on a standard address'); }
  if (payAddress !== carrierAddr) return bad('the payment does not go to the carriers\' own address');
  const expectedPay = bid.priceUnits - (bid.feeUnits || 0);
  if (bid.vout[PAY_OUTPUT].value !== expectedPay) {
    return bad(`the payment output is ${bid.vout[PAY_OUTPUT].value}, the stated price less fee is ${expectedPay}`);
  }

  // 4) Every buyer signature, against the transaction as it stands. A signature that does not verify
  //    here would fail at broadcast, after the seller had already given up their carriers.
  const tx = bidTx(bid);
  for (let i = n; i < bid.vin.length; i++) {
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
  const pooled = {};
  for (const c of chain) {
    for (const [ref, amt] of Object.entries(c.runes || {})) pooled[ref] = (pooled[ref] || 0) + Number(amt);
  }
  const held = pooled[bid.runeRef] || 0;
  if (held < bid.amount) return bad(`the carriers hold ${held} of ${bid.runeRef}, the bid asks for ${bid.amount}`);

  const sim = new RuneState();
  for (const c of chain) {
    for (const [ref, amt] of Object.entries(c.runes || {})) sim.credit(outpoint(c.txid, c.vout), ref, Number(amt));
  }
  const simTxid = txid(tx);
  applyTx(sim, {
    txid: simTxid,
    height: (chain[0].height || 0) + 1,
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

  // Every other rune on the carriers has to come home too. A carrier can hold several runes at once,
  // and a bid that quietly walked off with the ones it did not name would be the same theft wearing
  // a different hat.
  for (const [ref, amt] of Object.entries(pooled)) {
    if (ref === bid.runeRef) continue;
    const back = sim.balanceOf(outpoint(simTxid, CHANGE_OUTPUT), ref);
    if (back !== amt) return bad(`simulated: ${back} of ${ref} would come back, not ${amt}`);
  }

  // Deliberately NO change outpoint here. A legacy transaction's id covers its scriptSigs, so the id
  // changes the moment the seller signs, and anything computed from the unsigned form would name an
  // outpoint that never exists. simTxid above is only a label the simulation uses consistently for
  // both the credit and the read, which is why the verdict is still sound. The real outpoint comes
  // out of acceptRuneBid, at the instant the seller signs and before they broadcast, which is exactly
  // when a standing order needs it.
  return { ok: true, receives: expectedPay, gives: bid.amount, keeps: held - bid.amount };
}

/** The data push out of an `OP_RETURN <push>` script, or undefined. */
function opReturnPayload(scriptHex) {
  const parts = bitcoin.script.decompile(Buffer.from(scriptHex, 'hex'));
  if (!parts || parts.length !== 2 || parts[0] !== bitcoin.opcodes.OP_RETURN || !Buffer.isBuffer(parts[1])) return undefined;
  return parts[1];
}

/**
 * Fill a bid: sign every carrier input and hand back something broadcastable.
 *
 * Verify first. This function deliberately does NOT verify for you, because it cannot: it does not
 * know what the chain says about the carriers, and a check that has to invent its own facts is worse
 * than no check at all.
 */
function acceptRuneBid({ network, bid, sellerKey }) {
  const tx = bidTx(bid);
  const sellerPub = Buffer.from(sellerKey.publicKey);
  const carrierScript = bitcoin.payments.p2pkh({ pubkey: sellerPub, network }).output;
  const priv = Buffer.from(sellerKey.privateKey);
  for (let k = 0; k < bid.carriers.length; k++) {
    if (carrierScript.toString('hex') !== bid.carriers[k].script) {
      throw new Error('this key does not own the carriers the bid is aimed at');
    }
    const sighash = legacySighash(tx, k, carrierScript, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, sellerPub, sig)) throw new Error(`accept signature self-check failed at input ${k}`);
    tx.vin[k].script = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), sellerPub]);
  }
  const id = txid(tx);
  return { hex: serializeTx(tx).toString('hex'), txid: id, changeOutpoint: outpoint(id, CHANGE_OUTPUT) };
}

module.exports = {
  RUNESTONE, CHANGE_OUTPUT, TAKE_OUTPUT, PAY_OUTPUT, DUST_UNITS, FIRST_FUND,
  bidTemplate, buildRuneBid, verifyRuneBid, acceptRuneBid, bidTx, carrierList,
};
