'use strict';
// The public list of locked ticker prices.
//
// Every etching publishes `l = { t, k }`: the release date and the public key that opens the lock.
// That makes the whole set of locks public information, which is what makes discovery possible
// without an address index and without anybody disclosing anything. A wallet derives its own lock
// keys from its seed, asks for this list, and compares locally. The server hands the same list to
// everyone and never learns which entries belong to whom.
//
// Nothing secret can appear here by construction: a public key, a timestamp, an outpoint and an
// amount, all of which anybody could read off the chain themselves with a node and some patience.

const tickers = require('./tickers');
const { parseRef } = require('./codec');

/**
 * Every lock the indexer knows about, newest first.
 *
 * @param {RuneState} state
 * @param {object} opts  { now } for the countdown, injectable so tests do not depend on the clock
 */
function listLocks(state, { now = Math.floor(Date.now() / 1000) } = {}) {
  const out = [];
  for (const [ref, rune] of state.runes) {
    if (!rune.lock) continue;
    const { height, txIndex } = parseRef(ref) || {};
    const left = Number(rune.lock.locktime) - now;
    out.push({
      ref,
      height, txIndex,
      ticker: rune.ticker,
      display: tickers.displayTicker(rune.ticker, rune.spacers || 0),
      pubkey: rune.lock.pubkey,
      locktime: rune.lock.locktime,
      opensAt: new Date(rune.lock.locktime * 1000).toISOString(),
      secondsLeft: Math.max(0, left),
      open: left <= 0,
      value: rune.lock.value,
      vouts: rune.lock.vouts,
      scriptPubKey: rune.lock.scriptPubKey,
    });
  }
  // Newest etch first: the list a person scrolls is the list of what they did most recently.
  out.sort((a, b) => (b.height - a.height) || (b.txIndex - a.txIndex));
  return out;
}

/** The subset matching a set of public keys. The wallet does this itself; this is for tools. */
function locksFor(state, pubkeys, opts) {
  const want = new Set((pubkeys || []).map((k) => String(k).toLowerCase()));
  return listLocks(state, opts).filter((l) => want.has(String(l.pubkey).toLowerCase()));
}

/** Totals, for a header line. */
function summarise(locks) {
  return {
    count: locks.length,
    locked: locks.reduce((s, l) => s + (l.open ? 0 : l.value), 0),
    open: locks.filter((l) => l.open).length,
    openValue: locks.filter((l) => l.open).reduce((s, l) => s + l.value, 0),
  };
}

module.exports = { listLocks, locksFor, summarise };
