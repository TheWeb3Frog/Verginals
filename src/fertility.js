'use strict';
// Alpha fertility. See spec/ADVENTURE-MODE-v0.md §1.1.
//
//   "An Alpha can breed only if its carrier UTXO has not moved for two days."
//
// This is the one rule in Adventure Mode that is not server state. Verge's R1 consensus rule stamps
// every transaction with an nTime bounded below by the nTime of every coin it spends, so a carrier's
// timestamp can only ever move forward along its chain of custody. A player can therefore verify
// their own fertility — and ours — from blocks alone, with no trust in our indexer and no height
// proof to reconstruct. That is why fertility is a timestamp comparison and nothing more.
//
// Breeding SPENDS the carrier, moving it to a fresh output (§1.1). The reset is therefore not a
// cooldown we impose and have to store: it is a consequence of the transaction. There is no
// cooldown table anywhere in this codebase, and there should never be one.
//
// Pure by design, like src/game.js and src/genetics.js: the caller fetches the carrier's creating
// transaction (`getrawtransaction <txid> true` -> `.time`) and passes the number in. Nothing here
// opens a socket, so the rule is testable without a node.

const DAY = 86400;

// Two days, per §1.1. Long enough that shuffling Alphas between wallets costs something, short
// enough that the spec can call it "flavour rather than friction — the animal settles in".
const REST_SECONDS = 2 * DAY;

// A carrier still in the mempool has an nTime, but a reorg can replace it. Requiring one
// confirmation costs a player ~30 seconds on a chain with 30-second blocks and removes the whole
// class of "my Alpha became fertile and then didn't".
const MIN_CONFIRMATIONS = 1;

/**
 * Is this Alpha ready to breed, and if not, when?
 *
 * @param {object} carrier
 * @param {number} carrier.time          nTime of the transaction that created the carrier output
 * @param {number} [carrier.confirmations] confirmations of that transaction
 * @param {number} now                   unix seconds
 * @param {object} [opts]
 * @param {number} [opts.restSeconds]    override the two-day rest
 * @param {number} [opts.minConfirmations]
 * @returns {{fertile:boolean, restedFor:number, remaining:number, readyAt:number, reason:string|null}}
 */
function fertility(carrier, now, opts = {}) {
  const rest = opts.restSeconds === undefined ? REST_SECONDS : opts.restSeconds;
  const minConf = opts.minConfirmations === undefined ? MIN_CONFIRMATIONS : opts.minConfirmations;

  if (!carrier || !Number.isFinite(carrier.time)) {
    throw new Error('fertility: carrier.time (the creating tx nTime) is required');
  }
  if (!Number.isFinite(now)) throw new Error('fertility: now must be a unix timestamp in seconds');

  const readyAt = carrier.time + rest;
  // Clamped at zero: a carrier whose nTime is ahead of our clock is not evidence of anything, and
  // R1 permits a small forward skew. Treating it as negative age would let a node with a slow clock
  // report a creature as more rested than it is.
  const restedFor = Math.max(0, now - carrier.time);
  const remaining = Math.max(0, readyAt - now);

  const conf = carrier.confirmations;
  if (minConf > 0 && Number.isFinite(conf) && conf < minConf) {
    return { fertile: false, restedFor, remaining, readyAt, reason: 'unconfirmed' };
  }
  if (remaining > 0) return { fertile: false, restedFor, remaining, readyAt, reason: 'resting' };
  return { fertile: true, restedFor, remaining: 0, readyAt, reason: null };
}

/**
 * The state a carrier enters the moment a breeding transaction confirms. Exposed so the UI can
 * show the reset without waiting for a chain round trip, and so nothing has to guess how the rule
 * composes with itself.
 */
function afterBreeding(spendTime, opts = {}) {
  const rest = opts.restSeconds === undefined ? REST_SECONDS : opts.restSeconds;
  return { time: spendTime, readyAt: spendTime + rest };
}

/**
 * One line for the pairing screen. The spec is explicit that a new player must be told plainly
 * rather than have the wait papered over with an exemption (§1.1), so this never softens it.
 */
function describe(state) {
  if (state.fertile) return 'Ready to breed';
  if (state.reason === 'unconfirmed') return 'Waiting for the carrier to confirm';
  const h = Math.ceil(state.remaining / 3600);
  if (h > 24) return `Resting — ready in ${Math.ceil(h / 24)} days`;
  if (h > 1) return `Resting — ready in ${h} hours`;
  return 'Resting — ready within the hour';
}

/**
 * Gate a pairing. Both parents must be rested; the report says which one is not, because "your
 * Alpha is resting" is useless when two are on screen.
 */
function canPair(mother, father, now, opts = {}) {
  const m = fertility(mother.carrier, now, opts);
  const f = fertility(father.carrier, now, opts);
  const blocked = [];
  if (!m.fertile) blocked.push({ side: 'mother', id: mother.id, state: m });
  if (!f.fertile) blocked.push({ side: 'father', id: father.id, state: f });
  return {
    ok: blocked.length === 0,
    mother: m,
    father: f,
    blocked,
    // The pair is ready when the slower of the two is.
    readyAt: Math.max(m.readyAt, f.readyAt),
  };
}

module.exports = {
  DAY,
  REST_SECONDS,
  MIN_CONFIRMATIONS,
  fertility,
  afterBreeding,
  describe,
  canPair,
};
