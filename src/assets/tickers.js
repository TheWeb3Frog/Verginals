'use strict';
// Verge Assets: ticker allocation (ASSETS-SPEC-v0 §7).
//
// Why a name costs anything at all. Runes made names free and allocated them on a length-unlock
// schedule; in practice bots raced every unlock and the good names went to squatters, who paid
// miners rather than the ecosystem. On Verge that failure mode would be worse, not better: relay
// fees are 0.2 XVG/kB, so there is no accidental cost filter at all and a single operator could take
// every desirable ticker for pocket change. This project has already watched one operator accumulate
// 565 items across 612 wallets, so this is an observed behaviour, not a hypothetical.
//
// So the price exists to make MASS registration ruinous while leaving one good name affordable to a
// real project. At the schedule below, a four-letter ticker costs one project 10,000 XVG, and costs
// a squatter wanting fifty of them half a million.
//
// The fee is split 50/50 between the project treasury and Verge itself. A protocol that depends on a
// chain should contribute to it: Verge's development and public infrastructure are what make this
// possible at all, so a share goes back by design rather than by goodwill, which also makes the
// protocol's success and the chain's health the same thing.

const { COIN } = require('../networks');

/**
 * Price by ticker length, in whole XVG. An explicit table rather than a formula: a lookup cannot be
 * misread by a second implementation, and this schedule is permanent once the first asset is etched.
 */
const PRICE_XVG = {
  1: 100000, 2: 50000, 3: 25000, 4: 10000, 5: 5000, 6: 2500,
  7: 1000, 8: 500, 9: 250, 10: 100, 11: 50,
};
const PRICE_LONG_XVG = 10; // 12 characters and above: nominal, purely anti-spam
const MAX_TICKER_LENGTH = 26;

/** Cost of a ticker in atomic units. Throws on a length the protocol does not allow. */
function priceOf(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!/^[A-Z0-9]{1,26}$/.test(t)) throw new Error('ticker must be 1..26 characters of A-Z0-9');
  const xvg = t.length >= 12 ? PRICE_LONG_XVG : PRICE_XVG[t.length];
  return Math.round(xvg * COIN);
}

/** The two halves owed. Any rounding remainder goes to Verge, never to the project. */
function splitOf(ticker) {
  const total = priceOf(ticker);
  const project = Math.floor(total / 2);
  return { total, project, verge: total - project };
}

/**
 * Is an etching paid for?
 *
 * Both halves must be paid in the same transaction that carries the etching, each to its exact
 * address. Underpaying either side makes the etching invalid, so a ticker cannot be taken by paying
 * only the project or only Verge.
 *
 * @param {Object} tx        the indexer-shaped transaction (outputs carry { address, value })
 * @param {string} ticker
 * @param {Object} addresses { project, verge }
 * @returns {{ ok, owed, paid, reason? }}
 */
function isPaid(tx, ticker, addresses) {
  const owed = splitOf(ticker);
  if (!addresses || !addresses.project || !addresses.verge) {
    return { ok: false, owed, paid: null, reason: 'payout addresses are not configured' };
  }
  const sumTo = (addr) => (tx.outputs || [])
    .filter((o) => o.address && o.address === addr)
    .reduce((s, o) => s + o.value, 0);

  const paid = { project: sumTo(addresses.project), verge: sumTo(addresses.verge) };
  if (paid.project < owed.project) return { ok: false, owed, paid, reason: 'project share underpaid' };
  if (paid.verge < owed.verge) return { ok: false, owed, paid, reason: 'verge share underpaid' };
  return { ok: true, owed, paid };
}

/** What a squatter would have to spend to take `count` tickers of this length. Used in the docs. */
function costOfHoarding(length, count) {
  return priceOf('A'.repeat(length)) * count;
}

module.exports = {
  PRICE_XVG, PRICE_LONG_XVG, MAX_TICKER_LENGTH,
  priceOf, splitOf, isPaid, costOfHoarding,
};
