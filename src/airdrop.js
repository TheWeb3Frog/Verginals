'use strict';
// Who did something on Verge, and what that earns them in a community drop.
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
// WHY A HEIGHT IS RECORDED FOR EACH. An airdrop announced and then counted live is an airdrop you
// can farm: read the rules, do the cheapest qualifying thing, take a share off everybody who was
// there before the rules existed. So eligibility is settled at a SNAPSHOT HEIGHT and the ledger
// keeps, per address per action, the first height it happened at. Choosing that height later, or
// never, is a decision this file does not make -- it only makes the decision possible.

/** The four actions, in the order a page should show them. The bit values are part of the format. */
const ACTIONS = [
  { key: 'inscribe', bit: 1, label: 'Inscribed on Verge' },
  { key: 'alpha', bit: 2, label: 'Minted an Alpha Verginal' },
  { key: 'etch', bit: 4, label: 'Etched a coin' },
  { key: 'coin', bit: 8, label: 'Minted a coin' },
];

const BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));

/** Every share is worth the same. Four actions, four shares, and no action is worth more. */
const SHARE_PER_ACTION = 1;

class ActionLedger {
  constructor() {
    // address -> { inscribe: height, alpha: height, ... }  first height only
    this.actors = new Map();
  }

  /**
   * Record that `address` performed `key` at `height`.
   *
   * Later repeats are dropped rather than overwritten: the ledger answers "when did this first
   * happen", and a snapshot height must give the same answer whether it is applied today or after
   * the same address has acted a hundred more times.
   */
  record(address, key, height) {
    if (!address || typeof address !== 'string') return false;
    if (!BY_KEY.has(key)) throw new Error(`unknown action ${JSON.stringify(key)}`);
    if (!Number.isInteger(height) || height < 0) throw new Error('height must be a non-negative integer');
    let rec = this.actors.get(address);
    if (!rec) { rec = {}; this.actors.set(address, rec); }
    if (rec[key] != null) return false;
    rec[key] = height;
    return true;
  }

  /**
   * What this address did at or before `asOf`.
   *
   * `asOf` null means "everything so far", which is the honest answer while no snapshot height has
   * been chosen. It is not the same as eligibility being settled, and callers say which they mean.
   */
  at(address, asOf = null) {
    const rec = this.actors.get(address) || {};
    const done = {};
    for (const a of ACTIONS) {
      const h = rec[a.key];
      done[a.key] = h != null && (asOf == null || h <= asOf) ? h : null;
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
    for (const [address, rec] of obj || []) l.actors.set(address, Object.assign({}, rec));
    return l;
  }
}

/** How many shares a set of completed actions is worth. */
function sharesOf(done) {
  let n = 0;
  for (const a of ACTIONS) if (done && done[a.key] != null) n += SHARE_PER_ACTION;
  return n;
}

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

module.exports = { ACTIONS, SHARE_PER_ACTION, ActionLedger, sharesOf, allocate };
