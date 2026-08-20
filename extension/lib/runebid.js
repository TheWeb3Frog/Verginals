// Filling a rune bid from the wallet, with no server in the loop.
//
// This is what makes the book a relay rather than a custodian. A bid is a self contained
// transaction missing only the seller's signature, so the wallet can check every claim in it against
// its OWN view of the chain and sign, or refuse, without asking anybody's permission. A hostile or
// absent book costs the seller a trade, never a coin.
//
// The allocation below is a port of the indexer's assignment rules, and a port is a second copy of
// something that has to agree with the first forever. test-runebid.mjs runs both over the same cases
// and compares, which is the only reason this file is allowed to exist.

import * as V from './verge.js';
import { decodeMessage, DUST_UNITS } from './runes.js';

export const RUNESTONE = 0;
export const CHANGE_OUTPUT = 1;
export const TAKE_OUTPUT = 2;
export const PAY_OUTPUT = 3;

const hex = V.bytesToHex;
const unhex = V.hexToBytes;

/** The first data push of a scriptSig, used to read a signature out of one. */
function firstPush(script) {
  let i = 0;
  const op = script[i++];
  let len;
  if (op < 0x4c) len = op;
  else if (op === 0x4c) len = script[i++];
  else { len = script[i] | (script[i + 1] << 8); i += 2; }
  return script.slice(i, i + len);
}

/** The single data push out of an `OP_RETURN <push>` script, or null if it is anything else. */
export function opReturnPayload(script) {
  if (!script || script.length < 2 || script[0] !== 0x6a) return null;
  let i = 1;
  const op = script[i++];
  let len;
  if (op < 0x4c) len = op;
  else if (op === 0x4c) len = script[i++];
  else if (op === 0x4d) { len = script[i] | (script[i + 1] << 8); i += 2; }
  else return null;
  // The declared push length is honoured and anything after it means the output carries no message
  // (spec 4.4). Reading to the end instead would let a trailing byte join the payload.
  if (i + len !== script.length) return null;
  return script.slice(i, i + len);
}

/**
 * Where a transaction's rune balances land. A port of applyTx steps 4 to 6.
 *
 * @param {Uint8Array|null} payload  the runestone's data push, or null
 * @param {Array} outputs            [{ value, script }]
 * @param {Object} pooled            { runeRef: amount } summed over the inputs
 * @returns {Object}                 { outputIndex: { runeRef: amount } }
 */
export function allocate(payload, outputs, pooled, dust = DUST_UNITS) {
  const out = {};
  const credit = (i, ref, amt) => {
    if (amt <= 0) return;
    (out[i] || (out[i] = {}))[ref] = (out[i][ref] || 0) + amt;
  };
  const pool = { ...pooled };

  // Which outputs may receive: never the OP_RETURN, never below dust.
  const eligible = [];
  outputs.forEach((o, i) => { if (!isOpReturn(o.script) && o.value >= dust) eligible.push(i); });

  const msg = payload ? decodeMessage(payload) : null;
  if (msg && msg.type === 'edicts') {
    for (const e of msg.edicts) {
      const available = pool[e.runeRef] || 0;
      if (available <= 0) continue;
      if (!eligible.includes(e.output)) continue;
      const amount = e.amount === 0 ? available : Math.min(e.amount, available);
      credit(e.output, e.runeRef, amount);
      pool[e.runeRef] = available - amount;
    }
  }

  // Whatever is left goes to the first eligible output; with none, it is burned.
  const fallback = eligible.length > 0 ? eligible[0] : null;
  for (const [ref, amt] of Object.entries(pool)) {
    if (amt <= 0 || fallback === null) continue;
    credit(fallback, ref, amt);
  }
  return out;
}

const isOpReturn = (script) => !!script && script.length > 0 && script[0] === 0x6a;

/** Rebuild the transaction a bid describes, with the buyer's signatures in place. */
export function bidTx(bid) {
  return {
    version: bid.version,
    time: bid.time,
    locktime: bid.locktime,
    vin: bid.vin.map((v, i) => ({
      txid: v.txid, vout: v.vout, sequence: 0xffffffff,
      script: bid.scriptSigs[i] ? unhex(bid.scriptSigs[i]) : new Uint8Array(0),
    })),
    vout: bid.vout.map((o) => ({ value: o.value, script: unhex(o.script) })),
  };
}

/**
 * Would signing this bid do what it claims?
 *
 * `onChain` is what the WALLET knows about its own carriers, in the bid's order: value, script and
 * the runes they hold. The wallet is the right source for this: it already proves its own balances
 * against the published merkle root, so nothing here depends on the book being honest.
 */
export async function verifyRuneBid({ bid, onChain, dustUnits = DUST_UNITS }) {
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

  const script = chain[0].script;
  for (let k = 0; k < n; k++) {
    if (bid.vin[k].txid !== chain[k].txid || bid.vin[k].vout !== chain[k].vout) return bad(`input ${k} does not spend the carrier it was looked up against`);
    if (bid.carriers[k].txid !== bid.vin[k].txid || bid.carriers[k].vout !== bid.vin[k].vout) return bad(`the bid labels carrier ${k} as a different outpoint than input ${k} spends`);
    if (bid.scriptSigs[k]) return bad(`carrier input ${k} is already signed, it must be left blank`);
    if (bid.carriers[k].value !== chain[k].value) return bad(`the bid says carrier ${k} holds ${bid.carriers[k].value}, your node says ${chain[k].value}`);
    if (bid.carriers[k].script !== chain[k].script) return bad(`the bid names a different script for carrier ${k} than your node does`);
    if (chain[k].script !== script) return bad('the bid mixes carriers from different addresses');
  }

  if (bid.vout[CHANGE_OUTPUT].script !== script) return bad('the rune change does not return to your own address');
  const carriersValue = chain.reduce((s, c) => s + c.value, 0);
  if (bid.vout[CHANGE_OUTPUT].value !== carriersValue) return bad('the change output does not return your carriers\' own coin');
  if (bid.vout[CHANGE_OUTPUT].value < dustUnits) return bad('the rune change output is below the dust floor and could not receive');
  if (bid.vout[TAKE_OUTPUT].value < dustUnits) return bad('the buyer\'s output is below the dust floor');
  if (bid.vout[PAY_OUTPUT].script !== script) return bad('the payment does not go to your own address');
  const expectedPay = bid.priceUnits - (bid.feeUnits || 0);
  if (bid.vout[PAY_OUTPUT].value !== expectedPay) return bad(`the payment output is ${bid.vout[PAY_OUTPUT].value}, the stated price less fee is ${expectedPay}`);

  const tx = bidTx(bid);
  for (let i = n; i < bid.vin.length; i++) {
    const ss = bid.scriptSigs[i];
    if (!ss) return bad(`input ${i} is unsigned`);
    const raw = unhex(ss);
    const pub = V.pubkeyFromScriptSig(raw);
    if (!pub) return bad(`input ${i} is not a P2PKH spend`);
    const sig = firstPush(raw);
    if (sig[sig.length - 1] !== V.SIGHASH_ALL) return bad(`input ${i} is not signed SIGHASH_ALL, so the buyer has not committed to the whole transaction`);
    const code = await V.p2pkhScript(await V.addressFromPubkey(pub));
    const sighash = await V.legacySighash(tx, i, code, V.SIGHASH_ALL);
    if (!V.verifySig(sighash, pub, sig)) return bad(`input ${i}'s signature does not verify`);
  }

  const pooled = {};
  for (const c of chain) {
    for (const [ref, amt] of Object.entries(c.runes || {})) pooled[ref] = (pooled[ref] || 0) + Number(amt);
  }
  const held = pooled[bid.runeRef] || 0;
  if (held < bid.amount) return bad(`your carriers hold ${held} of ${bid.runeRef}, the bid asks for ${bid.amount}`);

  const landed = allocate(opReturnPayload(unhex(bid.vout[RUNESTONE].script)), tx.vout, pooled, dustUnits);
  const gotBuyer = ((landed[TAKE_OUTPUT] || {})[bid.runeRef]) || 0;
  const gotSeller = ((landed[CHANGE_OUTPUT] || {})[bid.runeRef]) || 0;
  if (gotBuyer !== bid.amount) return bad(`the buyer would receive ${gotBuyer}, not ${bid.amount}`);
  if (gotSeller !== held - bid.amount) return bad(`your change would be ${gotSeller}, not ${held - bid.amount}`);
  for (const [ref, amt] of Object.entries(pooled)) {
    if (ref === bid.runeRef) continue;
    const back = ((landed[CHANGE_OUTPUT] || {})[ref]) || 0;
    if (back !== amt) return bad(`${back} of ${ref} would come back, not ${amt}`);
  }

  return { ok: true, receives: expectedPay, gives: bid.amount, keeps: held - bid.amount };
}

/** Does this bid satisfy a standing order? The floor is checked against what YOU receive. */
export async function fillsOrder({ order, bid, onChain, now, alreadySold = 0, dustUnits = DUST_UNITS }) {
  const bad = (reason) => ({ ok: false, reason });
  const ov = await verifyOrder(order, now);
  if (!ov.ok) return ov;
  if (bid.runeRef !== order.runeRef) return bad(`the bid is for ${bid.runeRef}, this order sells ${order.runeRef}`);

  const chain = Array.isArray(onChain) ? onChain : [onChain];
  const script = hex(await V.p2pkhScript(order.address));
  for (const c of chain) {
    if (c.script !== script) return bad('the bid names a carrier this order does not speak for');
  }
  const left = Math.max(0, Number(order.sell) - Number(alreadySold));
  if (bid.amount > left) return bad(`the bid takes ${bid.amount}, only ${left} is still on offer`);
  if (order.minFill && bid.amount < order.minFill) return bad(`the bid takes ${bid.amount}, below this order's floor of ${order.minFill}`);

  const v = await verifyRuneBid({ bid, onChain: chain, dustUnits });
  if (!v.ok) return v;

  const got = BigInt(v.receives) * BigInt(order.minPrice.per);
  const floor = BigInt(order.minPrice.units) * BigInt(bid.amount);
  if (got < floor) return bad(`you would receive ${v.receives} for ${bid.amount}, under this order's floor`);
  return { ok: true, receives: v.receives, gives: v.gives, keeps: v.keeps, soldAfter: Number(alreadySold) + bid.amount };
}

/** Is this order really signed by the address it claims, and is it still live? */
export async function verifyOrder(order, now) {
  const bad = (reason) => ({ ok: false, reason });
  if (!order || order.kind !== 'verge-rune-order-v1') return bad('not a rune order');
  if (!order.minPrice || !(order.minPrice.per > 0)) return bad('the order has no usable price');
  let pub;
  try { pub = unhex(order.pubkey); } catch (_) { return bad('the order has no readable key'); }
  if ((await V.addressFromPubkey(pub)) !== order.address) return bad('the order\'s key does not match the address it claims');
  const parts = [
    'verge-rune-order-v1', order.runeRef, String(order.sell), String(order.minPrice.units),
    String(order.minPrice.per), order.address, String(order.nonce), String(order.expiresAt),
    String(order.minFill || 0),
  ];
  const digest = await V.dsha256(new TextEncoder().encode(parts.join('|')));
  // An order is signed as a bare 64 byte compact signature, not as a scriptSig, so it carries no DER
  // wrapper and no hash type byte. verifySig speaks the scriptSig dialect, so re-dress it rather than
  // opening a second verification path that could drift from the one every transaction uses.
  if (!V.verifySig(digest, pub, asScriptSigSignature(unhex(order.sig)))) return bad('the order\'s signature does not verify');
  if (now != null && Number(now) > Number(order.expiresAt)) return bad('the order has expired');
  return { ok: true };
}

/**
 * Fill a bid: sign every carrier input and hand back something broadcastable.
 *
 * Verify FIRST. This deliberately does not verify for you, because it does not know what your node
 * says about your carriers, and a check that invents its own facts is worse than no check.
 */
export async function acceptRuneBid({ bid, priv }) {
  const tx = bidTx(bid);
  const pub = V.publicKeyFromPrivate(priv);
  const code = await V.p2pkhScript(await V.addressFromPubkey(pub));
  const codeHex = hex(code);
  for (let k = 0; k < bid.carriers.length; k++) {
    if (codeHex !== bid.carriers[k].script) throw new Error('this account does not own the carriers the bid is aimed at');
    const sighash = await V.legacySighash(tx, k, code, V.SIGHASH_ALL);
    const sig = await V.signHashWith(sighash, priv, V.SIGHASH_ALL);
    tx.vin[k].script = V.concatBytes(pushData(sig), pushData(pub));
  }
  const id = await V.txid(tx);
  return { hex: hex(V.serializeTx(tx)), txid: id, changeOutpoint: `${id}:${CHANGE_OUTPUT}` };
}

function pushData(bytes) {
  if (bytes.length < 0x4c) return V.concatBytes(new Uint8Array([bytes.length]), bytes);
  return V.concatBytes(new Uint8Array([0x4c, bytes.length]), bytes);
}

/** A compact (r||s) signature dressed as DER with a trailing hash type byte, which verifySig wants. */
function asScriptSigSignature(compact) {
  if (!compact || compact.length !== 64) return new Uint8Array(0);
  const big = (b) => BigInt('0x' + hex(b));
  return V.concatBytes(V.derEncodeSig(big(compact.slice(0, 32)), big(compact.slice(32))), new Uint8Array([V.SIGHASH_ALL]));
}
