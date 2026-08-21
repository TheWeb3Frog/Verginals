'use strict';
// The coin directory: every rune that exists, with what it is and what it costs.
//
// A market needs this before it needs an order book. On the day a protocol opens the book is empty
// and stays empty for a while, so a page built only on orders shows nothing while several coins are
// sitting there minting. The directory is what makes the market useful from the first block.
//
// Everything here is DERIVED from indexer state and book state. Nothing is stored, so there is no
// second copy of a supply figure to drift from the first.

const tickers = require('./tickers');
const { describe } = require('./mintable');

/**
 * Prices are published PER WHOLE COIN, and that is a deliberate choice about where the divisibility
 * multiplication happens.
 *
 * An order's minPrice is XVG atomic units per ATOMIC rune unit, because that is what the fill
 * arithmetic needs. Nobody thinks in those units. Every page that has tried to render them has had
 * to remember to multiply by 10^divisibility, and the one that forgot showed a two-decimal coin's
 * price understated a hundredfold, right next to a balance overstated a hundredfold by the same
 * missing factor. So it is done once, here, by the code that already holds the divisibility, and a
 * page renders the number it is given.
 */
function perWholeCoin(minPrice, divisibility) {
  const each = Number(minPrice.units) / Number(minPrice.per);
  return each * Math.pow(10, Number(divisibility) || 0);
}

/**
 * How many outpoints carry each rune, counted in ONE pass rather than once per rune.
 *
 * This walks every balance in the state, so it costs O(outpoints) per call and is deliberately not
 * cached. At today's size that is microseconds, and a cache here would be a staleness bug waiting
 * for a reorg to reuse a height. If this ever shows up in a profile, memoise it on the indexer side
 * where the invalidation is a fact rather than a guess.
 */
function carrierCounts(state) {
  const counts = new Map();
  for (const held of state.balances.values()) {
    for (const [ref, amt] of held) {
      if (!(amt > 0)) continue;
      counts.set(ref, (counts.get(ref) || 0) + 1);
    }
  }
  return counts;
}

/**
 * One row of the directory.
 *
 * `orders` is whatever the book has for this rune, already filtered to the live ones. Passing them
 * in rather than reaching for the book keeps this a pure function of two states, which is what lets
 * a test drive it without a book on disk.
 */
function row(state, ref, rune, { height, orders = [], carriers = 0 } = {}) {
  const div = Number(rune.divisibility || 0);
  const scale = Math.pow(10, div);
  const supply = Number(rune.supply || 0);
  const premine = Number(rune.premine || 0);
  const minted = Number(rune.minted || 0);
  const circulating = premine + minted;
  const openSupply = supply - premine;

  let bestAsk = null;
  let forSale = 0;
  for (const o of orders) {
    forSale += Number(o.remaining || 0);
    const p = perWholeCoin(o.order.minPrice, div);
    if (bestAsk === null || p < bestAsk) bestAsk = p;
  }

  return {
    runeRef: ref,
    ticker: rune.ticker,
    // Rendered from the mask the etching actually committed to. It was previously read off a
    // `display` field that no etching writes, so every spaced name in existence rendered unspaced.
    display: tickers.displayTicker(rune.ticker, rune.spacers || 0),
    symbol: rune.symbol || null,
    divisibility: div,
    etchedAtHeight: Number(String(ref).split(':')[0]),

    supply,
    premine,
    minted,
    circulating,
    openSupply,
    // The share of what ANYBODY CAN HAVE, never of the whole supply. A creator who kept half and
    // saw the rest minted is finished, not halfway.
    mintedShare: openSupply > 0 ? minted / openSupply : null,
    whole: {
      supply: supply / scale,
      premine: premine / scale,
      minted: minted / scale,
      circulating: circulating / scale,
    },

    carriers,
    mint: describe(rune, ref, height),
    market: {
      asks: orders.length,
      forSale,
      forSaleWhole: forSale / scale,
      // XVG atomic units for one whole coin, or null when nobody is asking.
      bestAsk,
      bestAskWhole: bestAsk === null ? null : bestAsk,
    },
  };
}

/**
 * Every rune, newest first.
 *
 * Newest first rather than by size on purpose: a directory sorted by supply is a leaderboard for
 * whoever typed the biggest number, which is free to do and means nothing.
 */
function directory(state, { height, ordersByRune = new Map() } = {}) {
  const counts = carrierCounts(state);
  const out = [];
  for (const [ref, rune] of state.runes) {
    out.push(row(state, ref, rune, {
      height,
      orders: ordersByRune.get(ref) || [],
      carriers: counts.get(ref) || 0,
    }));
  }
  out.sort((a, b) => b.etchedAtHeight - a.etchedAtHeight
    || String(a.runeRef).localeCompare(String(b.runeRef)));
  return out;
}

module.exports = { directory, row, perWholeCoin, carrierCounts };
