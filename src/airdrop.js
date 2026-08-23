'use strict';
// Who did something on Verge, how often, and what that earns them in a community drop.
//
// ALPHA GO BRRRR was etched with its whole supply premined and no open mint, which leaves exactly
// one way for it to reach anybody: it gets sent. This file decides who it gets sent to.
//
// THE LEDGER IS BUILT FROM THE CHAIN, NOT FROM OUR RECORDS. The server has job files that know who
// ordered what, and using them would have been a morning's work instead of a day's. It would also
// have made the eligibility list a claim only we can check, on a site whose whole argument is that
// you never have to take our word for anything. Every action counted here left a transaction, and
// the ledger is rebuilt from those transactions on every boot, so a second implementation reading
// the same blocks arrives at the same list.
//
// WHAT COUNTS AS AN ACTION. Four, and they are deliberately things you DID rather than things you
// HOLD. A snapshot of holders pays whoever happened to be sitting on the asset that morning and
// pays nothing to the person who was there first and sold; a snapshot of actions cannot be bought
// after the fact at any price.
//
//   inscribe  you revealed an inscription of your own
//   alpha     you minted an Alpha Verginal
//   etch      you etched a coin
//   coin      you minted from somebody else's coin
//
// An etching is itself an inscription reveal, and an Alpha mint is too. They are counted as the
// more specific action only, never as both, so a single transaction can never earn two shares.
//
// ONE ACTION IS ENOUGH TO BE ON THE LIST. REPEATING IT IS WHAT FILLS THE BAR. Two of the four are
// worth doing more than once, up to three times, and the other two are not:
//
//   Minting an Alpha and minting a coin are cheap, repeatable, and exactly the behaviour this drop
//   is meant to reward, so each is worth up to three shares.
//
//   Inscribing is worth one. Etching is worth one because it costs a ticker price: asking somebody
//   to buy three names to fill a bar would be asking them to burn real money for a bigger slice of
//   a free coin, which is a trap rather than an incentive.
//
// WHY A HEIGHT IS RECORDED FOR EACH OCCURRENCE. An airdrop announced and then counted live is an
// airdrop you can farm: read the rules, do the cheapest qualifying thing, take a share off
// everybody who was there before the rules existed. So eligibility is settled at a SNAPSHOT HEIGHT,
// and the ledger keeps a height per occurrence rather than one per action, because "how many
// Alphas had this address minted by block H" is a different question from "when was the first".
// Choosing that height later, or never, is a decision this file does not make; it only makes the
// decision possible.

/** The four actions, in the order a page should show them, with how far each one can be taken. */
const ACTIONS = [
  { key: 'inscribe', max: 1, label: 'Inscribed on Verge', one: 'Inscribe something' },
  { key: 'alpha', max: 3, label: 'Minted an Alpha Verginal', one: 'Mint an Alpha' },
  { key: 'etch', max: 1, label: 'Etched a coin', one: 'Etch a coin' },
  { key: 'coin', max: 3, label: 'Minted a coin', one: 'Mint a coin' },
];

const BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));

/** Every occurrence is worth the same. Nothing is weighted by what it cost or how early it was. */
const SHARE_PER_OCCURRENCE = 1;

/** The most anybody can hold. The bar on the page is a fraction of this and nothing else. */
const MAX_SHARES = ACTIONS.reduce((n, a) => n + a.max * SHARE_PER_OCCURRENCE, 0);

class ActionLedger {
  constructor() {
    // address -> { inscribe: [height, ...], alpha: [...], ... } in scan order, capped per action
    this.actors = new Map();
  }

  /**
   * Record that `address` performed `key` at `height`.
   *
   * Kept in scan order and capped at the action's own maximum, and the cap keeps the FIRST
   * occurrences rather than the latest. That is what makes a snapshot answerable: a height only
   * ever looks backwards, so the occurrences it could possibly count are the earliest ones, and
   * throwing those away to keep newer ones would silently lower the count for every past height.
   *
   * @returns {boolean} whether it was recorded, false once the action is already at its maximum
   */
  record(address, key, height) {
    if (!address || typeof address !== 'string') return false;
    const action = BY_KEY.get(key);
    if (!action) throw new Error(`unknown action ${JSON.stringify(key)}`);
    if (!Number.isInteger(height) || height < 0) throw new Error('height must be a non-negative integer');
    let rec = this.actors.get(address);
    if (!rec) { rec = {}; this.actors.set(address, rec); }
    const at = rec[key] || (rec[key] = []);
    if (at.length >= action.max) return false;
    at.push(height);
    return true;
  }

  /**
   * What this address had done by `asOf`, per action: how many times, and when it first happened.
   *
   * `asOf` null means "everything so far", which is the honest answer while no snapshot height has
   * been chosen. It is not the same as eligibility being settled, and callers say which they mean.
   */
  at(address, asOf = null) {
    const rec = this.actors.get(address) || {};
    const done = {};
    for (const a of ACTIONS) {
      const heights = (rec[a.key] || []).filter((h) => asOf == null || h <= asOf);
      done[a.key] = {
        count: Math.min(heights.length, a.max),
        max: a.max,
        first: heights.length ? heights[0] : null,
      };
    }
    return done;
  }

  /** Every address that qualifies at `asOf`, with its shares. Sorted, so two runs agree. */
  roll(asOf = null) {
    const rows = [];
    for (const address of [...this.actors.keys()].sort()) {
      const done = this.at(address, asOf);
      const shares = sharesOf(done);
      if (shares > 0) rows.push({ address, done, shares });
    }
    return rows;
  }

  toJSON() {
    return [...this.actors.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  static fromJSON(obj) {
    const l = new ActionLedger();
    // Copied one array deep. A shallow copy would hand the restored ledger the very arrays the live
    // one keeps pushing onto, so a snapshot taken for a reorg would grow itself and restore to a
    // state that never existed.
    for (const [address, rec] of obj || []) {
      const out = {};
      for (const key of Object.keys(rec || {})) out[key] = (rec[key] || []).slice();
      l.actors.set(address, out);
    }
    return l;
  }
}

/** How many shares a set of completed actions is worth. */
function sharesOf(done) {
  let n = 0;
  for (const a of ACTIONS) {
    const d = done && done[a.key];
    if (d && d.count > 0) n += Math.min(d.count, a.max) * SHARE_PER_OCCURRENCE;
  }
  return n;
}

/** Is this address on the list at all? One occurrence of one action is enough, and always has been. */
const isEligible = (done) => sharesOf(done) > 0;

/**
 * How full this address's bar is, 0 to 1.
 *
 * A share of the MAXIMUM ANYBODY CAN HOLD, not a share of the supply and not a share of the roll.
 * Those two move every time somebody else qualifies, and a figure that quietly shrinks while you
 * are reading it is how an airdrop page turns into an argument. This one only ever goes up, and it
 * goes up when you do something.
 */
const fillOf = (done) => sharesOf(done) / MAX_SHARES;

/**
 * Split a supply across a roll, largest remainder first.
 *
 * Integer arithmetic throughout, in ATOMIC UNITS, and the parts are guaranteed to sum to exactly
 * `supply`. Both halves of that matter. A float share of a 100,000,000,000-unit supply loses units
 * to rounding and the last wallet in the list is the one that finds out; and a plan that hands out
 * one unit more than exists is a plan whose final transaction cannot be built.
 *
 * @param {Array} roll   [{ address, shares }]
 * @param {number} supply  atomic units to distribute
 * @returns {Array} [{ address, shares, amount }] in roll order
 */
function allocate(roll, supply) {
  if (!Number.isInteger(supply) || supply < 0) throw new Error('supply must be a non-negative integer');
  const total = roll.reduce((s, r) => s + r.shares, 0);
  if (total === 0) return roll.map((r) => Object.assign({}, r, { amount: 0 }));

  const parts = roll.map((r) => {
    const exact = supply * r.shares;
    return Object.assign({}, r, { amount: Math.floor(exact / total), rem: exact % total });
  });
  // Whatever the floors left behind goes to the largest remainders, ties broken by address so the
  // split is a function of the roll and nothing else.
  let left = supply - parts.reduce((s, p) => s + p.amount, 0);
  const order = [...parts].sort((a, b) => b.rem - a.rem || (a.address < b.address ? -1 : 1));
  for (let i = 0; i < order.length && left > 0; i++, left--) order[i].amount += 1;
  return parts.map((p) => ({ address: p.address, shares: p.shares, amount: p.amount }));
}

module.exports = {
  ACTIONS, SHARE_PER_OCCURRENCE, MAX_SHARES, ActionLedger, sharesOf, isEligible, fillOf, allocate,
};
