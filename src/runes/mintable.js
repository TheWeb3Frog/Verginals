'use strict';
// What can be minted right now, and what it would cost.
//
// A coin with open terms is useless if nobody can find it, and every rule that decides whether a
// mint will be ACCEPTED lives in the indexer (applyMint). This module answers the same questions
// from the same state, so a page never shows a Mint button on something the indexer would refuse.
//
// It reports "why not" rather than hiding a closed mint. Somebody arriving two blocks after the
// window shut deserves to read that, not to find an empty list.

const codec = require('./codec');
const tickers = require('./tickers');

/**
 * Describe one rune's mint, whether or not it is open.
 *
 * `height` is the tip. Every window test in applyMint compares against the height of the block
 * carrying the mint, so the honest answer to "can I mint now" uses the height the next block will
 * have, not the one already mined.
 */
function describe(rune, ref, height) {
  const t = rune.terms;
  if (!t || !(t.amount > 0)) return null;

  const next = Number(height) + 1;
  const minted = Number(rune.minted || 0);
  const mintCount = Number(rune.mintCount || 0);
  const amount = Number(t.amount);

  // Two different ceilings, and a coin can hit either first: the number of mints allowed, and the
  // supply left after the premine. Reporting only one of them would promise mints that cannot exist.
  const byCap = t.cap == null ? Infinity : Math.max(0, Number(t.cap) - mintCount);
  const room = Number(rune.supply) - Number(rune.premine) - minted;
  const bySupply = amount > 0 ? Math.max(0, Math.floor(room / amount)) : 0;
  const remaining = Math.min(byCap, bySupply);

  const reasons = [];
  if (t.openHeight != null && next < t.openHeight) reasons.push(`opens at block ${t.openHeight}`);
  if (t.closeHeight != null && next > t.closeHeight) reasons.push(`closed at block ${t.closeHeight}`);
  if (byCap <= 0) reasons.push('every mint has been taken');
  if (bySupply <= 0) reasons.push('no supply left to mint');

  return {
    runeRef: ref,
    ticker: rune.ticker,
    // From the mask the etching committed to. `rune.display` is a field no etching ever
    // writes, so reading it meant every spaced name in existence rendered unspaced.
    display: tickers.displayTicker(rune.ticker, rune.spacers || 0),
    symbol: rune.symbol || null,
    divisibility: Number(rune.divisibility || 0),
    amount,
    // The price is a FEE, paid to whoever mines the block. Named so on purpose: a reader who thinks
    // it goes to the coin's creator will look for a rug that cannot exist.
    priceUnits: Number(t.price || 0),
    priceGoesTo: 'the miner of the block, as an ordinary transaction fee',
    cap: t.cap == null ? null : Number(t.cap),
    mintCount,
    minted,
    supply: Number(rune.supply),
    premine: Number(rune.premine),
    remaining: remaining === Infinity ? null : remaining,
    openHeight: t.openHeight == null ? null : Number(t.openHeight),
    closeHeight: t.closeHeight == null ? null : Number(t.closeHeight),
    // An allowlisted mint needs a proof this server cannot produce, so a page must not offer a
    // plain Mint button for one. Reported rather than filtered out: the coin still exists and
    // somebody holding an entitlement should see it.
    allowlisted: !!rune.allowlistRoot,
    open: reasons.length === 0,
    closedBecause: reasons,
  };
}

/** Every rune with open terms, the open ones first, then by how much is left. */
function mintable(state, height, { runeRef = null } = {}) {
  const out = [];
  for (const [ref, rune] of state.runes) {
    if (runeRef && ref !== runeRef) continue;
    const d = describe(rune, ref, height);
    if (d) out.push(d);
  }
  out.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    const ar = a.remaining == null ? Infinity : a.remaining;
    const br = b.remaining == null ? Infinity : b.remaining;
    if (ar !== br) return br - ar;
    return codec.compareRefs(a.runeRef, b.runeRef);
  });
  return out;
}

module.exports = { describe, mintable };
