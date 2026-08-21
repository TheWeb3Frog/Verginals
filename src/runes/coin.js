'use strict';
// Everything true about one coin, assembled from the state the indexer decides with.
//
// The page this feeds is where somebody lands from a link, so every number on it has to be one this
// server can stand behind. Two of them need care and both are called out below: the holder count is
// a count of COINS and not of people, and the mint progress is measured against what can be minted
// rather than against the whole supply.

const codec = require('./codec');
const tickers = require('./tickers');
const { describe } = require('./mintable');

/**
 * Who holds it, honestly.
 *
 * The indexer stores balances by OUTPOINT, and never learns which address an outpoint pays: it does
 * not need to, and storing it would be a second source of truth to keep in step. So this counts
 * coins, not people. One person holding twenty carriers counts as twenty, and saying "holders" here
 * would be a number somebody would quote and would be wrong.
 */
function distribution(state, ref) {
  const amounts = [];
  let total = 0;
  for (const [, held] of state.balances) {
    const a = held.get(ref);
    if (!a || a <= 0) continue;
    amounts.push(a);
    total += a;
  }
  amounts.sort((x, y) => y - x);
  const top = amounts.slice(0, 10);
  return {
    carriers: amounts.length,
    circulating: total,
    largest: amounts[0] || 0,
    // What share the ten biggest coins hold. A coin where that is 99 percent is a different coin
    // from one where it is 9, and the number is cheap to compute and hard to argue with.
    topTenShare: total > 0 ? top.reduce((s, x) => s + x, 0) / total : 0,
    top,
  };
}

/** One coin, or null when nothing of that name has ever been etched. */
function coin(state, ref, height) {
  const rune = state.runes.get(ref);
  if (!rune) return null;

  const parsed = codec.parseRef(ref) || {};
  const div = Number(rune.divisibility || 0);
  const scale = 10 ** div;
  const minted = Number(rune.minted || 0);
  const premine = Number(rune.premine || 0);
  const supply = Number(rune.supply || 0);
  const openSupply = Math.max(0, supply - premine);

  return {
    runeRef: ref,
    ticker: rune.ticker,
    // From the mask the etching committed to. `rune.display` is a field no etching ever
    // writes, so reading it meant every spaced name in existence rendered unspaced.
    display: tickers.displayTicker(rune.ticker, rune.spacers || 0),
    symbol: rune.symbol || null,
    divisibility: div,
    etchedAtHeight: parsed.height,
    etchedAtIndex: parsed.txIndex,

    supply,
    premine,
    minted,
    // Against the OPEN supply, never the whole one. A creator who kept half their coin would
    // otherwise see it reported as a quarter gone when the half they opened is in fact half gone.
    mintedShare: openSupply > 0 ? minted / openSupply : 0,
    openSupply,
    inWholeCoins: {
      supply: supply / scale,
      premine: premine / scale,
      minted: minted / scale,
      circulating: (premine + minted) / scale,
    },

    mint: describe(rune, ref, height),
    distribution: distribution(state, ref),

    // The part no other token protocol has. The name was not bought, it was deposited, and this says
    // how much and when it comes back. A reader who thinks the creator pocketed it should be able to
    // check that nobody did.
    nameDeposit: rune.lock ? {
      lockedUnits: Number(rune.lock.value || 0),
      opensAt: Number(rune.lock.locktime),
      paidToAnybody: false,
      burned: false,
    } : null,

    allowlisted: !!rune.allowlistRoot,
    height,
  };
}

module.exports = { coin, distribution };
