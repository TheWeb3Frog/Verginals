'use strict';
// Verge Runes: the rules that make a rune listing safe (RUNES-SPEC-v0 §9).
//
// The inscription marketplace construction cannot be reused for a divisible rune unchanged, and the
// reason is worth stating plainly because it costs a seller real money:
//
//   SIGHASH_SINGLE | SIGHASH_ANYONECANPAY commits the maker to ONE output, their own payment.
//   Every other output, INCLUDING the OP_RETURN that carries the edicts, is written by the taker.
//   For an inscription that is safe: it is indivisible and travels with its satoshi. For a divisible
//   rune it is not: the amount that leaves is decided by an edict the maker never signed.
//
// Demonstrated, not assumed: a maker listing 300 of 1000 can be made to hand over all 1000 by a taker
// who simply omits the OP_RETURN, because the default assignment then sweeps the pooled balance to the
// first eligible output, which is the buyer's. See test/runes-swap.test.js.
//
// So: A LISTING SELLS THE ENTIRE BALANCE OF ONE CARRIER. Selling part of a holding means splitting
// first, in a transaction the maker signs in full, then listing the resulting carrier. That removes
// the attack instead of mitigating it, because when everything is for sale a missing edict costs the
// maker nothing.

const codec = require('./codec');

/** Marketplace layout indices (MARKETPLACE-SPEC-v0). The maker signs only PRICE_INDEX. */
const PADDING_INDEX = 0; // buyer: padding-out
const CARRIER_INDEX = 1; // buyer: the new carrier the rune should land on
const PRICE_INDEX = 2;   // maker: the price, and the only output the maker's signature covers

/**
 * Terms for listing a carrier: everything it holds, since everything is being sold.
 *
 * @param {Object} carrierRunes { [runeRef]: amount } as read from the chain
 * @returns {{ sells: Array<{runeRef, amount}> }}
 */
function listingTerms(carrierRunes) {
  const entries = Object.entries(carrierRunes || {});
  if (entries.length === 0) throw new Error('this outpoint carries no rune, list it as an inscription instead');
  return {
    sells: entries
      .map(([runeRef, amount]) => ({ runeRef, amount: Number(amount) }))
      .sort((a, b) => codec.compareRefs(a.runeRef, b.runeRef)),
  };
}

/**
 * Would this listing be safe to sign?
 *
 * @param {Object} p
 * @param {Object} p.declared  what the listing claims the carrier holds
 * @param {Object} p.onChain   what the carrier actually holds
 * @param {number} [p.partialAmount] set if a UI is trying to list less than the whole balance
 * @returns {{ ok, reason? }}
 */
function validateListing({ declared, onChain, partialAmount = null }) {
  if (partialAmount !== null) {
    return { ok: false, reason: 'a listing must sell the whole carrier: split first, then list the result' };
  }
  // Sorted with an explicit comparator on the reference alone. A bare .sort() on [key, value] pairs
  // compares them as the strings "ref,amount", so the ORDER of the two lists could depend on the
  // amounts rather than only on which runes are present, which is not what the comparison below
  // wants to be reading.
  const byRef = (x, y) => codec.compareRefs(x[0], y[0]);
  const d = Object.entries(declared || {}).map(([k, v]) => [String(k), Number(v)]).sort(byRef);
  const c = Object.entries(onChain || {}).map(([k, v]) => [String(k), Number(v)]).sort(byRef);
  if (c.length === 0) return { ok: false, reason: 'the carrier holds no rune on chain' };
  if (d.length !== c.length) return { ok: false, reason: 'the listing does not declare every rune on the carrier' };
  for (let i = 0; i < d.length; i++) {
    if (d[i][0] !== c[i][0]) return { ok: false, reason: `declared rune ${d[i][0]} is not on the carrier` };
    if (d[i][1] !== c[i][1]) {
      return { ok: false, reason: `declared ${d[i][1]} of rune ${d[i][0]}, chain says ${c[i][1]}` };
    }
  }
  return { ok: true };
}

/**
 * The edicts a taker should include, so the balance lands on the intended carrier rather than on the
 * padding output. Omitting these is not a theft risk once §9.1 is respected, only untidy.
 */
function takerEdicts(declared) {
  return Object.entries(declared || {})
    .map(([runeRef]) => ({ runeRef, amount: 0, output: CARRIER_INDEX }))
    .sort((a, b) => codec.compareRefs(a.runeRef, b.runeRef));
}

/**
 * Check a completed swap really delivers what was listed, from indexed state. A taker builds most of
 * this transaction, so the maker's software should verify the result rather than trust the shape.
 */
function verifySettlement({ state, txid, declared, buyerOutputs = [CARRIER_INDEX, PADDING_INDEX] }) {
  for (const [ref, amount] of Object.entries(declared || {})) {
    const delivered = buyerOutputs.reduce((s, i) => s + state.balanceOf(`${txid}:${i}`, ref), 0);
    if (delivered !== Number(amount)) {
      return { ok: false, reason: `rune ${ref}: listed ${amount}, buyer received ${delivered}` };
    }
  }
  return { ok: true };
}

module.exports = {
  PADDING_INDEX, CARRIER_INDEX, PRICE_INDEX,
  listingTerms, validateListing, takerEdicts, verifySettlement,
};
