'use strict';
// A standing sell order: an INTENT, not an offer.
//
// The problem this exists to remove: a signed offer names an outpoint, and a partial fill spends that
// outpoint. So every fill kills the offer, the seller silently leaves the book, and they only find
// out when they wonder why nothing is selling. Re-signing after each fill is possible (the new
// outpoint is knowable at the instant the seller signs, see acceptRuneBid) but it needs the seller
// present, and it breaks whenever the fill does not confirm.
//
// AN INTENT NAMES NO OUTPOINT, so none of that happens. It says "I will sell up to N of this rune at
// no less than this price, from whatever I hold at this address". Sell 20,000 of 50,000 and the same
// order still stands over the 30,000 that came home, with nothing re-signed and nothing pending.
//
// It is deliberately NOT binding. It cannot be: only the seller's key can move their runes, so an
// intent is a promise to consider, and the bid is what is binding. That is the right way round. The
// buyer commits their coins, and can withdraw them in one block by spending one of them. The failure
// mode of a broken promise is NO FILL, never lost funds, and a forged or abandoned advertisement
// costs a buyer nothing: every bid they place spends the same coins, so they are mutually exclusive
// and only one can ever confirm.
//
// The signature on an order is for attribution, not for settlement: it stops anyone advertising
// somebody else's holdings.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { dsha256 } = require('../vergetx');
const codec = require('./codec');
const { verifyRuneBid } = require('./bid');

const KIND = 'verge-rune-order-v1';

/**
 * The bytes an order signs. A flat, separator-joined string rather than JSON, because two JSON
 * encoders disagree about key order and whitespace and this has to hash the same everywhere.
 */
function orderDigest(o) {
  const parts = [
    KIND, o.runeRef, String(o.sell), String(o.minPrice.units), String(o.minPrice.per),
    o.address, String(o.nonce), String(o.expiresAt), String(o.minFill || 0),
  ];
  for (const p of parts) {
    if (String(p).includes('|')) throw new Error('an order field may not contain the separator');
  }
  return dsha256(Buffer.from(parts.join('|'), 'utf8'));
}

/**
 * Sign a standing order.
 *
 * The price is an integer RATIO, `units` atomic XVG for every `per` runes, never a float. A rune can
 * be worth a small fraction of a coin and a float would round that comparison in somebody's favour;
 * with a ratio the comparison is exact whichever way the numbers fall.
 */
function signOrder({ network, runeRef, sell, minPrice, key, nonce, expiresAt, minFill }) {
  if (!codec.parseRef(runeRef)) throw new Error('runeRef must be "<height>:<txIndex>"');
  if (!Number.isInteger(sell) || sell <= 0) throw new Error('sell must be a positive whole number');
  if (!minPrice || !Number.isInteger(minPrice.units) || !Number.isInteger(minPrice.per)) {
    throw new Error('minPrice must be { units, per } as whole numbers');
  }
  if (minPrice.units <= 0 || minPrice.per <= 0) throw new Error('minPrice must be positive on both sides');
  if (minFill != null && (!Number.isInteger(minFill) || minFill < 0)) throw new Error('minFill must be a whole number');
  if (!Number.isInteger(expiresAt)) throw new Error('expiresAt must be a unix time');

  const pubkey = Buffer.from(key.publicKey);
  const address = bitcoin.payments.p2pkh({ pubkey, network }).address;
  const order = {
    kind: KIND, runeRef, sell,
    minPrice: { units: minPrice.units, per: minPrice.per },
    address, pubkey: pubkey.toString('hex'),
    nonce: String(nonce), expiresAt, minFill: minFill || 0,
  };
  const sig = Buffer.from(ecc.sign(orderDigest(order), Buffer.from(key.privateKey)));
  if (!ecc.verify(orderDigest(order), pubkey, sig)) throw new Error('order signature self-check failed');
  return { ...order, sig: sig.toString('hex') };
}

/** Is this order really from the address it claims, and is it still live? */
function verifyOrder({ network, order, now }) {
  const bad = (reason) => ({ ok: false, reason });
  if (!order || order.kind !== KIND) return bad('not a rune order');
  if (!order.minPrice || !(order.minPrice.per > 0)) return bad('the order has no usable price');
  let pubkey;
  try { pubkey = Buffer.from(order.pubkey, 'hex'); } catch (e) { return bad('the order has no readable key'); }
  let derived;
  try { derived = bitcoin.payments.p2pkh({ pubkey, network }).address; } catch (e) { return bad('the order\'s key is not a key'); }
  // Without this an order could name someone else's address and advertise their coins.
  if (derived !== order.address) return bad('the order\'s key does not match the address it claims');
  let sig;
  try { sig = Buffer.from(order.sig, 'hex'); } catch (e) { return bad('the order has no readable signature'); }
  if (!ecc.verify(orderDigest(order), pubkey, sig)) return bad('the order\'s signature does not verify');
  if (now != null && Number(now) > Number(order.expiresAt)) return bad('the order has expired');
  return { ok: true, address: order.address };
}

/** How much of the order is still on offer, by the seller's own accounting. */
function remaining(order, alreadySold) {
  const sold = Number(alreadySold || 0);
  return Math.max(0, Number(order.sell) - sold);
}

/**
 * Which carriers to name for a wanted amount, fewest first.
 *
 * Largest first is not greed, it is transaction size: every extra carrier is another input and
 * another signature, and the point of naming several is to cover a FRAGMENTED holding, not to
 * assemble one out of dust.
 */
function quote({ order, carriers, amount, alreadySold, maxCarriers }) {
  const left = remaining(order, alreadySold);
  if (!(amount > 0)) return { ok: false, reason: 'ask for a positive amount' };
  if (amount > left) return { ok: false, reason: `only ${left} of this order is still on offer` };
  if (order.minFill && amount < order.minFill) return { ok: false, reason: `this seller does not fill below ${order.minFill}` };

  const mine = (carriers || [])
    .filter((c) => c.script === scriptFor(order))
    .map((c) => ({ c, held: Number((c.runes || {})[order.runeRef] || 0) }))
    .filter((x) => x.held > 0)
    .sort((a, b) => b.held - a.held);

  const cap = maxCarriers == null ? 8 : maxCarriers;
  const pick = [];
  let got = 0;
  for (const x of mine) {
    if (got >= amount) break;
    if (pick.length >= cap) break;
    pick.push(x.c); got += x.held;
  }
  if (got < amount) {
    return { ok: false, reason: `this address holds ${got} of ${order.runeRef} across the carriers it can spend in one go, short of ${amount}` };
  }
  return { ok: true, carriers: pick, pooled: got, priceUnits: priceFor(order, amount) };
}

/** The scriptPubKey an order's address hashes to, computed from the key it published. */
function scriptFor(order) {
  return bitcoin.payments.p2pkh({ pubkey: Buffer.from(order.pubkey, 'hex') }).output.toString('hex');
}

/**
 * The smallest whole number of units that satisfies the order's floor for `amount` runes.
 * Rounded UP, so the buyer never lands a unit under the floor through integer division.
 */
function priceFor(order, amount) {
  const units = BigInt(order.minPrice.units) * BigInt(amount);
  const per = BigInt(order.minPrice.per);
  const up = (units + per - 1n) / per;
  return Number(up);
}

/**
 * THE GATE. Everything a seller's software must be sure of before it signs anything.
 *
 * `onChain` is what the seller's own node says about each carrier the bid names, in the bid's order.
 * It has to be READ FRESH: a bid naming a carrier that has already been spent is refused here only
 * because the lookup comes back different, and stale data is the one way this check can be wrong.
 *
 * Note where the price floor is applied: to what the seller RECEIVES, not to the price the bid
 * advertises. A bid can state a handsome price and route nine tenths of it to a "market fee" address
 * of the buyer's choosing, and a floor checked against the advertised number would wave that through.
 */
function fillsOrder({ network, order, bid, onChain, now, alreadySold, dustUnits }) {
  const bad = (reason) => ({ ok: false, reason });

  const ord = verifyOrder({ network, order, now });
  if (!ord.ok) return ord;

  if (bid.runeRef !== order.runeRef) return bad(`the bid is for ${bid.runeRef}, this order sells ${order.runeRef}`);

  // The bid has to be aimed at THIS seller. Without this an order would vouch for a bid against
  // somebody else's carriers, which the seller cannot sign anyway but would report as fillable.
  const script = scriptFor(order);
  const chain = Array.isArray(onChain) ? onChain : [onChain];
  for (const c of chain) {
    if (c.script !== script) return bad('the bid names a carrier this order does not speak for');
  }

  const left = remaining(order, alreadySold);
  if (bid.amount > left) return bad(`the bid takes ${bid.amount}, only ${left} is still on offer`);
  if (order.minFill && bid.amount < order.minFill) return bad(`the bid takes ${bid.amount}, below this order's floor of ${order.minFill}`);

  // The money check, the simulation, the change coming home: all of it lives in verifyRuneBid, and
  // this gate does not repeat any of it.
  const v = verifyRuneBid({ network, bid, onChain: chain, dustUnits });
  if (!v.ok) return v;

  // Exact integer comparison, BigInt because the cross-multiplication of a price in atomic units by
  // a rune count leaves the range a double can hold exactly long before either side looks large.
  const got = BigInt(v.receives) * BigInt(order.minPrice.per);
  const floor = BigInt(order.minPrice.units) * BigInt(bid.amount);
  if (got < floor) {
    return bad(`the seller would receive ${v.receives} for ${bid.amount}, under this order's floor of ${priceFor(order, bid.amount)}`);
  }

  return { ok: true, receives: v.receives, gives: v.gives, keeps: v.keeps, soldAfter: Number(alreadySold || 0) + bid.amount };
}

module.exports = { KIND, signOrder, verifyOrder, orderDigest, remaining, quote, priceFor, scriptFor, fillsOrder };
