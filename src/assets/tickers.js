'use strict';
// Verge Assets: ticker allocation (ASSETS-SPEC-v0 §7).
//
// Why a name costs anything at all. Runes made names free and allocated them on a length-unlock
// schedule; in practice bots raced every unlock and the good names went to squatters, who paid
// miners rather than the ecosystem. On Verge that failure mode would be worse, not better: relay
// fees are 0.2 XVG/kB, so there is no accidental cost filter at all and a single operator could take
// every desirable ticker for pocket change. Nor is wallet-rotation at scale hypothetical here: it is
// observable on this chain on any drop worth farming.
//
// So the price exists to make MASS registration ruinous while leaving one good name affordable to a
// real project. At the schedule below, a four-letter ticker costs one project 10,000 XVG, and costs a
// squatter wanting fifty of them half a million.
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

// --- display spacers ---------------------------------------------------------------------------

// The separator a spacer renders as. Fixed, never chosen by the etcher: if two etchers could pick
// different separators, TICKER with a bullet and TICKER with a middle dot would look like the same
// name to a human and different names to an indexer, which is a homograph attack with extra steps.
const SPACER_CHAR = '\u2022'; // BULLET

/**
 * Spacers are DISPLAY ONLY, and that is the whole design.
 *
 * `x` is a bitfield in the etching: bit i set means "render a separator after character i". The
 * ticker itself stays A-Z0-9, so DOGGOTOTHEMOON, DOG(bullet)GO(bullet)TO(bullet)THE(bullet)MOON and
 * DOGGO(bullet)TOTHEMOON are one asset, not three.
 *
 * That collision is the point rather than a limitation. If spacing made a new name, every desirable
 * ticker could be squatted a dozen times over by re-spacing it, and the length-based price (§7)
 * would stop meaning anything. Uniqueness and price are both computed on the bare ticker, so a
 * separator is free and buys no namespace.
 *
 * Cheap here in a way it is not on Bitcoin: Runes had to pack this into an 80-byte budget. The
 * etching is CBOR inside an inscription, so the field costs a few bytes and nothing had to be
 * sacrificed for it.
 */
function spacersAreValid(ticker, mask) {
  const t = String(ticker || '');
  if (!Number.isInteger(mask) || mask < 0) return false;
  if (mask === 0) return true;
  // A separator sits BETWEEN two characters, so the only legal positions are 0..len-2. This rules
  // out a leading separator, a trailing one, and anything past the end of the name.
  const legal = (1 << Math.max(0, t.length - 1)) - 1;
  if ((mask & ~legal) !== 0) return false;
  // No two in a row: a doubled separator renders as an empty segment and reads as a typo.
  return (mask & (mask >> 1)) === 0;
}

/** Render a ticker for display. Never use the result as a key: the bare ticker is the identity. */
function displayTicker(ticker, mask = 0) {
  const t = String(ticker || '').toUpperCase();
  if (!mask || !spacersAreValid(t, mask)) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    out += t[i];
    if (i < t.length - 1 && (mask >> i) & 1) out += SPACER_CHAR;
  }
  return out;
}

/** The identity of a displayed name: strip every separator and fold case. */
function bareTicker(display) {
  return String(display || '').split(SPACER_CHAR).join('').toUpperCase();
}

/** What a squatter would have to spend to take `count` tickers of this length. Used in the docs. */
function costOfHoarding(length, count) {
  return priceOf('A'.repeat(length)) * count;
}

module.exports = {
  PRICE_XVG, PRICE_LONG_XVG, MAX_TICKER_LENGTH, SPACER_CHAR,
  priceOf, splitOf, isPaid, costOfHoarding,
  spacersAreValid, displayTicker, bareTicker,
};
