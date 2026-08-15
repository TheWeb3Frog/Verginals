'use strict';
// Verge Runes: ticker allocation (RUNES-SPEC-v0 §7).
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
// Nothing is burned and nothing is paid to anyone (§7.2). The price goes into an output the etcher
// alone can reopen, four years later. Every other fee model eventually has to name a recipient, and
// a recipient is a party with a stake in the protocol, which is exactly what §6 spent its length
// removing. A lock answers "nobody, for four years", so the deterrent survives without creating one.

const crypto = require('crypto');
const { COIN } = require('../networks');
const { pushData } = require('../envelope');

/**
 * Price by ticker length, in whole XVG. An explicit table rather than a formula: a lookup cannot be
 * misread by a second implementation, and this schedule is permanent once the first rune is etched.
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

// --- what a mint may be charged (spec §2.2) -----------------------------------------------------

// Measured on Verge Core v26.5.0, not inferred: sendrawtransaction refuses any transaction whose
// ABSOLUTE fee exceeds 50 XVG with "absurdly-high-fee", and the limit is a flat amount rather than a
// rate, so no amount of extra transaction size buys headroom. Passing allowhighfees=true gets past
// it, and peers relaying the transaction never apply the check at all, so a higher price is possible
// with software written for it. It is not possible with an ordinary wallet, which is what matters.
const ABSURD_FEE_UNITS = 50 * COIN;

// So a mint price has to leave room for the relay fee stacked on top of it, because the node judges
// the total. A mint is around 250 bytes and relay is 0.2 XVG/kB, so the headroom below is more than
// an order of magnitude more than it needs, and an etcher gains nothing by going closer to the wall.
const MAX_MINT_PRICE = 49 * COIN;

// --- the lock (spec §7.2) ------------------------------------------------------------------------

/** 1460 days. The whole deterrent is capital multiplied by time, so this number is the deterrent. */
const LOCK_SECONDS = 126144000;

// An etcher signs their transaction before the chain confirms it, and the lock is measured from the
// block that carries it, so a lock computed at signing time is always a little short by the time it
// lands. A day of slack covers any plausible delay between the two, and shaving one day off 1460 is
// worth nothing to an attacker, so there is no reason to make this tight.
const LOCK_GRACE_SECONDS = 86400;

// nLockTime below this is a block HEIGHT, at or above it is a unix TIMESTAMP. The protocol accepts
// only the timestamp form: a height lock assumes four years of unchanged block spacing, and ten
// percent of drift there is five months of error.
const LOCKTIME_THRESHOLD = 500000000;

const hash160 = (b) => crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(b).digest()).digest();

/** Minimal CScriptNum, the encoding OP_CHECKLOCKTIMEVERIFY expects its argument in. */
function encodeScriptNum(n) {
  if (n === 0) return Buffer.alloc(0);
  const bytes = [];
  let abs = Math.abs(n);
  while (abs > 0) { bytes.push(abs & 0xff); abs = Math.floor(abs / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(n < 0 ? 0x80 : 0x00);
  else if (n < 0) bytes[bytes.length - 1] |= 0x80;
  return Buffer.from(bytes);
}

/** `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG` */
function lockRedeemScript(locktime, pubkey) {
  const key = Buffer.isBuffer(pubkey) ? pubkey : Buffer.from(String(pubkey), 'hex');
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) {
    throw new Error('the lock key must be a 33-byte compressed pubkey');
  }
  if (!Number.isInteger(locktime) || locktime < LOCKTIME_THRESHOLD) {
    throw new Error('locktime must be a unix timestamp, never a block height');
  }
  return Buffer.concat([
    pushData(encodeScriptNum(locktime)),
    Buffer.from([0xb1, 0x75]),   // OP_CHECKLOCKTIMEVERIFY, OP_DROP
    pushData(key),
    Buffer.from([0xac]),         // OP_CHECKSIG
  ]);
}

/** `OP_HASH160 <20-byte hash> OP_EQUAL`, the output the redeem script is paid into. */
function p2shScriptPubKey(redeem) {
  return Buffer.concat([Buffer.from([0xa9, 0x14]), hash160(redeem), Buffer.from([0x87])]);
}

/**
 * Rebuild the scriptPubKey an etching's `l = { t, k }` commits to. Returns null when the field is
 * not a usable lock, and callers must treat null as "this etching is not paid for".
 */
function lockScriptFor(lock) {
  if (!lock) return null;
  const t = Number(lock.t);
  const k = Buffer.isBuffer(lock.k) ? lock.k
    : (typeof lock.k === 'string' ? Buffer.from(lock.k, 'hex') : null);
  if (!k) return null;
  try {
    const redeem = lockRedeemScript(t, k);
    return { redeem, scriptPubKey: p2shScriptPubKey(redeem), locktime: t, pubkey: k };
  } catch { return null; }
}

/**
 * Is an etching paid for?
 *
 * The whole check is local to the one transaction, and that is deliberate: an indexer rebuilding
 * history from blocks decides this with nothing but the block in front of it, and a wallet that has
 * lost everything but its seed can still find the money later. There is no address to configure, no
 * payout to route, and nothing to keep in sync.
 *
 * @param {Object} tx     indexer-shaped transaction; needs `outputs` and the block `time`
 * @param {string} ticker
 * @param {Object} lock   the etching's `l` field, { t, k }
 * @returns {{ ok, owed, locked, reason? }}
 */
function isLocked(tx, ticker, lock) {
  const owed = priceOf(ticker);
  const script = lockScriptFor(lock);
  if (!script) return { ok: false, owed, locked: 0, reason: 'no readable price lock in the etching' };

  // The lock has to actually last. Without this an etcher could name a timestamp already past and
  // reopen the money in the next block, which is a ticker for the price of a transaction fee.
  const time = Number(tx.time || 0);
  if (!time) return { ok: false, owed, locked: 0, reason: 'no block time to measure the lock against' };
  if (script.locktime < time + LOCK_SECONDS - LOCK_GRACE_SECONDS) {
    return { ok: false, owed, locked: 0, reason: 'the lock is shorter than the protocol requires' };
  }

  // Several outputs to the same script are summed. They pay into one address either way, so there is
  // nothing to gain by splitting and no reason to refuse it.
  const locked = (tx.outputs || [])
    .filter((o) => o.scriptPubKey && Buffer.isBuffer(o.scriptPubKey)
      && o.scriptPubKey.equals(script.scriptPubKey))
    .reduce((s, o) => s + o.value, 0);

  if (locked < owed) return { ok: false, owed, locked, reason: 'the ticker price is not locked in this transaction' };
  return { ok: true, owed, locked };
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
 * DOGGO(bullet)TOTHEMOON are one rune, not three.
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
function normalizeSpacers(ticker, mask) {
  const t = String(ticker || '');
  if (!Number.isInteger(mask) || mask <= 0) return 0;
  // A separator sits BETWEEN two characters, so the only meaningful positions are 0..len-2.
  // Anything past the end is masked off rather than rejected.
  //
  // Ignoring beats rejecting here, and Bitcoin's Runes made the same call ("trailing spacers are
  // ignored"). Both are deterministic, since the rule is written down either way, but rejecting
  // means a wallet that sets one bit too many destroys an etching, and the etcher loses the ticker
  // price over a field that only decides where a bullet is drawn.
  //
  // Note that ADJACENT bits are legal and ordinary: bit i and bit i+1 put separators in two
  // neighbouring gaps, which renders A(bullet)B(bullet)C. There is no such thing as two separators
  // in one gap, so there is nothing to forbid.
  const legal = (1 << Math.max(0, t.length - 1)) - 1;
  return mask & legal;
}

/** Render a ticker for display. Never use the result as a key: the bare ticker is the identity. */
function displayTicker(ticker, mask = 0) {
  const t = String(ticker || '').toUpperCase();
  const m = normalizeSpacers(t, mask);
  if (!m) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    out += t[i];
    if (i < t.length - 1 && (m >> i) & 1) out += SPACER_CHAR;
  }
  return out;
}

/** The identity of a displayed name: strip every separator and fold case. */
function bareTicker(display) {
  return String(display || '').split(SPACER_CHAR).join('').toUpperCase();
}

/**
 * The inverse of displayTicker: read a bitfield back out of a name somebody typed with separators
 * in it. This is what lets an interface take `DOG(bullet)GO(bullet)TO(bullet)THE(bullet)MOON` from a
 * text box and hand the etching a bare name plus a mask, without the person ever meeting the word
 * "bitfield".
 *
 * Leading separators, trailing ones and runs of several in a row are dropped rather than rejected,
 * for the reason §7.1 gives: a name is paid for and permanent, and no arrangement of bullets should
 * be able to destroy one.
 */
function spacersFromDisplay(display) {
  const s = String(display || '').toUpperCase();
  let mask = 0;
  let seen = 0;                       // characters of the bare name so far
  for (const ch of s) {
    if (ch === SPACER_CHAR) {
      // A separator sits between two characters, so one before any character, or a second in the
      // same gap, has nowhere to go.
      if (seen > 0) mask |= 1 << (seen - 1);
      continue;
    }
    seen += 1;
  }
  return normalizeSpacers('A'.repeat(seen), mask);
}

/** What a squatter would have to spend to take `count` tickers of this length. Used in the docs. */
function costOfHoarding(length, count) {
  return priceOf('A'.repeat(length)) * count;
}

module.exports = {
  PRICE_XVG, PRICE_LONG_XVG, MAX_TICKER_LENGTH, SPACER_CHAR,
  LOCK_SECONDS, LOCK_GRACE_SECONDS, LOCKTIME_THRESHOLD,
  ABSURD_FEE_UNITS, MAX_MINT_PRICE,
  priceOf, costOfHoarding,
  encodeScriptNum, lockRedeemScript, p2shScriptPubKey, lockScriptFor, isLocked,
  normalizeSpacers, displayTicker, bareTicker, spacersFromDisplay,
};
