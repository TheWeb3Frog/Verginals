'use strict';
// Turn-by-turn bot duels. See spec/ADVENTURE-MODE-v0.md §4.4.
//
//   "Fought interactively against an AI, and its job is not consolation: it is where you learn
//    your own creature. The two modes feed each other: the bot teaches you the tool, the tournament
//    asks you to use it blind."
//
// Two properties had to survive, and everything here is shaped by them.
//
// THE BOT CANNOT REACT. Its three moves are derived from the committed seed before the player picks
// anything, so there is no round in which the server learns your choice and then picks its own. The
// seed's hash is published when the duel opens and the seed itself when it ends; anyone can rerun
// botLoadoutFrom() and check the bot played what it was always going to play.
//
// THE RULES ARE NOT REIMPLEMENTED. A turn-by-turn duel is a different PRESENTATION of the same
// function, not a second game with its own edge cases. Every round shown to the player comes out of
// game.js resolveMatch(), called on the moves chosen so far with the remaining rounds padded out and
// then truncated away.
//
// That padding is sound rather than lucky: resolveRound() draws from the rng only when a round ties
// all the way down to the coin flip, so the stream position after round N depends on rounds 1..N and
// never on what comes after. Rounds already shown therefore cannot change when later moves arrive,
// which is exactly what a turn-by-turn fight has to guarantee, and what test/duel.test.js pins.

const crypto = require('crypto');
const { ELEMENTS, DEFAULT_CONFIG, resolveMatch, serverSeedHash, rngFromSeed } = require('./game');

/** A filler round used only to satisfy resolveMatch's fixed length; always valid, never shown. */
const PAD = { element: ELEMENTS[0] };

/**
 * The bot's whole match, from the seed alone. Derived once and never revisited, which is what makes
 * "the bot cannot react" checkable rather than promised.
 *
 * Its power-ups are placed the way a player places them: one poison and one potion, each in a single
 * round, sometimes not at all. A bot that always spends everything is a bot you stop reading.
 */
function botLoadoutFrom(seed, rounds = DEFAULT_CONFIG.rounds) {
  const rng = rngFromSeed(`bot:${seed}`);
  const moves = [];
  for (let i = 0; i < rounds; i++) moves.push({ element: ELEMENTS[Math.floor(rng() * ELEMENTS.length)] });
  // -1 means "not spent this match", so roughly one match in four withholds each power-up.
  const poisonRound = Math.floor(rng() * (rounds + 1)) - 1;
  const potionRound = Math.floor(rng() * (rounds + 1)) - 1;
  if (poisonRound >= 0 && poisonRound < rounds) moves[poisonRound].poison = true;
  if (potionRound >= 0 && potionRound < rounds) moves[potionRound].potion = true;
  return moves;
}

/**
 * Open a duel. Nothing is decided: the seed exists but only its hash is handed out.
 *
 * @param {object} p1 the player's fighter (deriveFighter shape, with an address)
 * @param {object} p2 the bot's fighter
 */
function openBotDuel(p1, p2, opts = {}) {
  const seed = opts.seed || crypto.randomBytes(32).toString('hex');
  const rounds = (opts.config && opts.config.rounds) || DEFAULT_CONFIG.rounds;
  return {
    seed,
    serverSeedHash: serverSeedHash(seed),
    p1,
    p2,
    config: opts.config,
    rounds,
    botMoves: botLoadoutFrom(seed, rounds),
    playerMoves: [],
    results: [],
    done: false,
  };
}

/** What the client may see mid-duel. The seed and the bot's unplayed moves stay server-side. */
function publicView(d) {
  return {
    serverSeedHash: d.serverSeedHash,
    round: d.playerMoves.length,
    rounds: d.rounds,
    results: d.results,
    done: d.done,
    // Revealed only once there is nothing left to influence.
    seed: d.done ? d.seed : undefined,
    botMoves: d.done ? d.botMoves : undefined,
  };
}

/**
 * Play one round. Returns the round's outcome, and the final match once the last one lands.
 *
 * The player's move is free; the bot's was fixed when the duel opened. Both go through the same
 * resolver as a committed tournament match, so a turn-by-turn win means the same thing as any other.
 */
function playRound(d, move) {
  if (d.done) return { error: 'this duel is over' };
  const i = d.playerMoves.length;
  if (!move || !ELEMENTS.includes(move.element)) {
    return { error: `round ${i + 1} needs an element: ${ELEMENTS.join('/')}` };
  }
  // Charges are per match, so a second poison is refused here rather than by the resolver, where the
  // message would name a round the player is no longer looking at.
  for (const kind of ['poison', 'potion']) {
    if (move[kind] && d.playerMoves.some((m) => m[kind])) {
      return { error: `you have already used your ${kind} this match` };
    }
  }

  d.playerMoves.push({ element: move.element, poison: !!move.poison, potion: !!move.potion });
  const full = resolvePrefix(d);
  d.results = full.rounds.slice(0, d.playerMoves.length);

  if (d.playerMoves.length < d.rounds) {
    return { ...publicView(d), round: d.playerMoves.length, result: d.results[d.results.length - 1] };
  }
  // The last call used no padding, so this IS the canonical match, the same object a committed
  // duel would produce, replayable from (moves, seed) by anyone.
  d.done = true;
  d.match = full;
  return { ...publicView(d), result: d.results[d.results.length - 1], match: full };
}

/**
 * Resolve the moves chosen so far. Rounds not yet played are padded on both sides and discarded by
 * the caller; see the header for why that cannot disturb the rounds already shown.
 */
function resolvePrefix(d) {
  const moves = [];
  for (let i = 0; i < d.rounds; i++) {
    moves.push({
      p1: d.playerMoves[i] || PAD,
      p2: i < d.playerMoves.length ? d.botMoves[i] : PAD,
    });
  }
  return resolveMatch({ p1: d.p1, p2: d.p2, moves, seed: d.seed, config: d.config });
}

module.exports = { openBotDuel, playRound, publicView, botLoadoutFrom, resolvePrefix, PAD };
