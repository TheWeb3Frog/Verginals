'use strict';
// Verginals Arena: the pure combat engine.
//
// No DB, no network, no wallet, and no randomness beyond a caller-supplied seed. resolveMatch() is
// a deterministic function of (fighters, moves, seed, config): identical inputs always produce an
// identical result. That single property is what makes the rest of the design work:
//   - anti-cheat: the server is the sole authority because it recomputes every outcome itself;
//   - replays: a whole fight is reconstructable from (moves, seed) alone, so it fits in a link;
//   - provable fairness: the seed is committed then revealed, and anyone can rerun this function
//     to check the result was not tampered with.
// The combat rules are ported from the original battleEngine (elemental rock-paper-scissors plus
// poison/potion); the trait modifiers and the seeded randomness are new. See spec/GAME-SPEC-v0.md.

const crypto = require('crypto');

const ELEMENTS = ['fire', 'water', 'earth'];
// The elemental cycle from the original game: fire burns earth, earth buries water, water douses
// fire. BEATS[x] is the element that x defeats.
const BEATS = { fire: 'earth', earth: 'water', water: 'fire' };

// Faces that grant the round-3 comeback edge. Kept as data so it is easy to retune.
const COMEBACK_FACES = new Set(['crying']);

// Default tuning. Every trait modifier can be switched off for a "pure skill" launch without
// touching this file: the server assembles config from game_config rows and passes it in. With all
// traits false the outcome depends only on player choices and the seeded coin flip.
const DEFAULT_CONFIG = {
  rounds: 3,
  poisonCharges: 1, // poison plays allowed per fighter per match
  potionCharges: 1, // potion (antidote) plays allowed per fighter per match
  shieldCharges: 1, // shield plays allowed per fighter per match
  eloK: 32,
  rarityNudgeMax: 0.1, // largest bias the rarity gap can add to a coin flip (0 = off)
  traits: {
    houseAffinity: true, // your House wins same-element ties when that element was played
    faceComeback: true,  // a comeback face gets a round-3 tie edge after losing round 1
    rarityNudge: true,   // the final coin flip leans toward the higher rarity score
    shield: false,       // the shield power-up is OFF for now (poison + potion only); code kept, flip to true to re-enable
  },
};

// --- seeds & randomness ---------------------------------------------------------------------

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Commitment a server publishes before a duel so it cannot later change its seed. */
function serverSeedHash(serverSeed) {
  return sha256hex(serverSeed);
}

/** 1v1 seed: server seed (committed) + client seed + match id, none of which one party controls. */
function combineSeed(serverSeed, clientSeed, matchId) {
  return sha256hex(`${serverSeed}|${clientSeed}|${matchId}`);
}

/** Tournament seed: derived from a Verge block hash announced before the block existed. */
function beaconSeed(blockHash, tournamentId, matchId) {
  return sha256hex(`${blockHash}|${tournamentId}|${matchId}`);
}

/**
 * Deterministic stream of floats in [0, 1) from a hex seed. Each draw hashes seed||counter, so the
 * sequence is reproducible from the seed alone and independent of how many draws came before.
 */
function rngFromSeed(seed) {
  let i = 0;
  return function next() {
    const h = crypto.createHash('sha256').update(`${seed}:${i++}`).digest();
    // 48 bits of entropy is plenty and avoids float precision issues.
    const v = h.readUIntBE(0, 6);
    return v / 0x1000000000000;
  };
}

// --- fighters -------------------------------------------------------------------------------

/**
 * Normalise a collection item's on-chain traits into the fields combat cares about. Kept explicit
 * so the engine never has to understand the raw trait schema. rarityScore comes from the rarity
 * engine (src/rarity.js) and is supplied by the caller.
 *
 * @param {{attributes:Array<{trait_type:string,value:string}>}} item
 * @param {{rarityScore?:number}} [opts]
 */
function deriveFighter(item, opts = {}) {
  const traits = {};
  (item.attributes || []).forEach((a) => {
    if (a && a.trait_type) traits[String(a.trait_type).toLowerCase()] = String(a.value).toLowerCase();
  });
  const house = ELEMENTS.includes(traits.house) ? traits.house : null;
  return {
    house,
    rarityScore: Number(opts.rarityScore) || 0,
    comeback: COMEBACK_FACES.has(traits.face),
    // The shield power-up is available to every fighter (see DEFAULT_CONFIG.traits.shield); it is no
    // longer a rarity perk, so no per-fighter capability is derived here.
  };
}

// --- move validation --------------------------------------------------------------------------

function mergeConfig(config) {
  const c = config || {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    traits: { ...DEFAULT_CONFIG.traits, ...(c.traits || {}) },
  };
}

/** Throw if a fighter's moves are illegal (bad element, or more charges than allowed). */
function validateFighterMoves(rounds, key, fighter, cfg) {
  let poison = 0;
  let potion = 0;
  let shield = 0;
  rounds.forEach((r, idx) => {
    const m = r[key];
    if (!m || !ELEMENTS.includes(m.element)) {
      throw new Error(`round ${idx + 1}: ${key} must play one of ${ELEMENTS.join('/')}`);
    }
    if (m.poison) poison++;
    if (m.potion) potion++;
    if (m.shield) shield++;
  });
  if (poison > cfg.poisonCharges) throw new Error(`${key} used ${poison} poison, max ${cfg.poisonCharges}`);
  if (potion > cfg.potionCharges) throw new Error(`${key} used ${potion} potion, max ${cfg.potionCharges}`);
  const shieldMax = cfg.traits.shield ? cfg.shieldCharges : 0;
  if (shield > shieldMax) throw new Error(`${key} used ${shield} shield, max ${shieldMax}`);
}

// --- round resolution -------------------------------------------------------------------------

/**
 * Resolve one round. Returns { winner: 'p1'|'p2', reason }. ctx carries the fighters, the seeded
 * rng, the merged config, the round index, and the round-1 result (for the comeback face).
 */
function resolveRound(a, b, ctx) {
  const { p1, p2, cfg, rng, round, rounds, round1Winner } = ctx;

  // Poison first: it wins the round outright unless the opponent spent a potion (antidote) this
  // round. Both poisoning cancels out and the round falls through to the element compare.
  const aPoison = a.poison && !b.potion;
  const bPoison = b.poison && !a.potion;
  if (aPoison && !bPoison) return { winner: 'p1', reason: 'poison' };
  if (bPoison && !aPoison) return { winner: 'p2', reason: 'poison' };

  // Element compare.
  let base = null; // 'p1' | 'p2' | 'tie'
  if (a.element === b.element) base = 'tie';
  else if (BEATS[a.element] === b.element) base = 'p1';
  else base = 'p2';

  // A shield turns an outright loss into a tie ("cannot lose this round"); the tiebreak may still
  // favour the shielded fighter.
  if (base === 'p2' && a.shield) base = 'tie';
  else if (base === 'p1' && b.shield) base = 'tie';

  if (base !== 'tie') return { winner: base, reason: 'element' };

  // Tie: resolve by House affinity, then the round-3 comeback face, then a rarity-weighted coin flip.
  const element = a.element === b.element ? a.element : null; // null when the tie came from a shield

  if (cfg.traits.houseAffinity && element) {
    const aAff = p1.house === element;
    const bAff = p2.house === element;
    if (aAff && !bAff) return { winner: 'p1', reason: 'house' };
    if (bAff && !aAff) return { winner: 'p2', reason: 'house' };
  }

  if (cfg.traits.faceComeback && round === rounds - 1 && round1Winner) {
    if (round1Winner === 'p2' && p1.comeback) return { winner: 'p1', reason: 'comeback' };
    if (round1Winner === 'p1' && p2.comeback) return { winner: 'p2', reason: 'comeback' };
  }

  return { winner: coinFlip(p1, p2, cfg, rng), reason: 'flip' };
}

/** A coin flip that leans toward the higher rarity score, bounded by cfg.rarityNudgeMax. */
function coinFlip(p1, p2, cfg, rng) {
  let pP1 = 0.5;
  if (cfg.traits.rarityNudge && cfg.rarityNudgeMax > 0) {
    const total = p1.rarityScore + p2.rarityScore;
    if (total > 0) {
      const delta = (cfg.rarityNudgeMax * (p1.rarityScore - p2.rarityScore)) / total;
      pP1 = Math.min(0.5 + cfg.rarityNudgeMax, Math.max(0.5 - cfg.rarityNudgeMax, 0.5 + delta));
    }
  }
  return rng() < pP1 ? 'p1' : 'p2';
}

// --- match resolution -------------------------------------------------------------------------

/**
 * Resolve a full best-of-N match. Pure and deterministic.
 *
 * @param {object}  p        { p1, p2 } fighters from deriveFighter, each with an address.
 * @param {object}  p.p1     { address, house, rarityScore, comeback, shield }
 * @param {object}  p.p2     same shape
 * @param {Array}   p.moves  rounds: [{ p1:{element,poison?,potion?,shield?}, p2:{...} }, ...]
 * @param {string}  p.seed   hex seed (from combineSeed or beaconSeed)
 * @param {object} [p.config] partial config overriding DEFAULT_CONFIG
 * @returns {{winner:string, loser:string, draw:boolean, score:[number,number], rounds:Array, seed:string}}
 */
function resolveMatch({ p1, p2, moves, seed, config }) {
  const cfg = mergeConfig(config);
  if (!Array.isArray(moves) || moves.length !== cfg.rounds) {
    throw new Error(`expected ${cfg.rounds} rounds, got ${Array.isArray(moves) ? moves.length : 'none'}`);
  }
  if (!p1 || !p2 || !p1.address || !p2.address) throw new Error('both fighters need an address');
  validateFighterMoves(moves, 'p1', p1, cfg);
  validateFighterMoves(moves, 'p2', p2, cfg);

  const rng = rngFromSeed(seed);
  const rounds = [];
  let wins1 = 0;
  let wins2 = 0;
  let round1Winner = null;

  for (let round = 0; round < cfg.rounds; round++) {
    const r = resolveRound(moves[round].p1, moves[round].p2, {
      p1, p2, cfg, rng, round, rounds: cfg.rounds, round1Winner,
    });
    if (round === 0) round1Winner = r.winner;
    if (r.winner === 'p1') wins1++;
    else wins2++;
    rounds.push({ round: round + 1, winner: r.winner, reason: r.reason });
  }

  // Best of N. A perfect split (only possible on even round counts) goes to an overall coin flip.
  let winnerKey;
  if (wins1 > wins2) winnerKey = 'p1';
  else if (wins2 > wins1) winnerKey = 'p2';
  else winnerKey = coinFlip(p1, p2, cfg, rng);

  const winner = winnerKey === 'p1' ? p1.address : p2.address;
  const loser = winnerKey === 'p1' ? p2.address : p1.address;
  return { winner, loser, draw: false, score: [wins1, wins2], rounds, seed };
}

// --- ELO ------------------------------------------------------------------------------------

/**
 * Standard Elo update. Returns [newA, newB]. aWon true if A won, false if B won.
 */
function updateElo(ra, rb, aWon, k = DEFAULT_CONFIG.eloK) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const eb = 1 - ea;
  const sa = aWon ? 1 : 0;
  const sb = aWon ? 0 : 1;
  return [Math.round(ra + k * (sa - ea)), Math.round(rb + k * (sb - eb))];
}

// --- schema (documented here, wired to better-sqlite3 in a later milestone) -------------------

// The Verge-side game database. Adapted from the original Runekoz schema with the custodial tables
// (season wallet, claims, designs) removed; keys are Verge addresses, not Bitcoin wallets.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS seasons (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at    INTEGER,
  status     TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS players (
  season_id   INTEGER NOT NULL,
  address     TEXT NOT NULL,
  elo         INTEGER NOT NULL DEFAULT 1200,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  matches     INTEGER NOT NULL DEFAULT 0,
  house       TEXT,
  best_streak INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (season_id, address)
);
CREATE TABLE IF NOT EXISTS matches_1v1 (
  id               TEXT PRIMARY KEY,
  season_id        INTEGER NOT NULL,
  p1_address       TEXT NOT NULL,
  p2_address       TEXT NOT NULL,
  p1_verginal      INTEGER,
  p2_verginal      INTEGER,
  moves_json       TEXT,
  server_seed_hash TEXT,
  server_seed      TEXT,
  client_seed      TEXT,
  winner_address   TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_1v1_status ON matches_1v1(status);
CREATE TABLE IF NOT EXISTS streaks_1v1 (
  address    TEXT PRIMARY KEY,
  current    INTEGER NOT NULL DEFAULT 0,
  best       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tournaments (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'registering',
  size                 INTEGER NOT NULL,
  seed_block_height    INTEGER,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  ended_at             INTEGER,
  champion_address     TEXT,
  trophy_inscription_id TEXT
);
CREATE TABLE IF NOT EXISTS tournament_participants (
  tournament_id    TEXT NOT NULL,
  address          TEXT NOT NULL,
  verginal         INTEGER,
  house            TEXT,
  seed             INTEGER,
  eliminated_round INTEGER,
  PRIMARY KEY (tournament_id, address)
);
CREATE TABLE IF NOT EXISTS tournament_matches (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL,
  round          INTEGER NOT NULL,
  p1_address     TEXT,
  p2_address     TEXT,
  moves_json     TEXT,
  seed           TEXT,
  winner_address TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_tmatch_tournament ON tournament_matches(tournament_id);
CREATE TABLE IF NOT EXISTS house_scores (
  season_id INTEGER NOT NULL,
  house     TEXT NOT NULL,
  points    INTEGER NOT NULL DEFAULT 0,
  wins      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, house)
);
CREATE TABLE IF NOT EXISTS badges (
  badge_key   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT,
  category    TEXT
);
CREATE TABLE IF NOT EXISTS player_badges (
  address       TEXT NOT NULL,
  badge_key     TEXT NOT NULL REFERENCES badges(badge_key),
  earned_at     INTEGER NOT NULL,
  tournament_id TEXT,
  PRIMARY KEY (address, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_pbadges_address ON player_badges(address);
CREATE TABLE IF NOT EXISTS game_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replays (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// The badge catalogue ported from the original game (custodial payout wording removed).
const BADGE_DEFS = [
  { badge_key: 'first_blood', name: 'First Blood', description: 'Play your first 1v1 duel', icon: '⚔️', category: 'participation' },
  { badge_key: 'duel_master', name: 'Duel Master', description: 'Win 10 duels in 1v1 mode', icon: '🏅', category: 'participation' },
  { badge_key: 'veteran', name: 'Veteran', description: 'Play 50 matches total', icon: '🎖️', category: 'participation' },
  { badge_key: 'relentless', name: 'Relentless', description: 'Play 100 matches total', icon: '💪', category: 'participation' },
  { badge_key: 'tournament_debut', name: 'Tournament Debut', description: 'Enter your first tournament', icon: '🎟️', category: 'tournament' },
  { badge_key: 'top_32', name: 'Top 32', description: 'Win your first round in a tournament', icon: '🌟', category: 'tournament' },
  { badge_key: 'top_16', name: 'Top 16', description: 'Advance to the Top 16', icon: '✨', category: 'tournament' },
  { badge_key: 'top_8', name: 'Quarter-Finalist', description: 'Reach the Quarter-Finals', icon: '💎', category: 'tournament' },
  { badge_key: 'top_4', name: 'Semi-Finalist', description: 'Reach the Semi-Finals', icon: '👑', category: 'tournament' },
  { badge_key: 'finalist', name: 'Finalist', description: 'Reach the Grand Final', icon: '🏆', category: 'tournament' },
  { badge_key: 'champion', name: 'CHAMPION', description: 'Win the Grand Final', icon: '🥇', category: 'tournament' },
  { badge_key: 'runner_up', name: 'Runner-Up', description: 'Finish second in the Grand Final', icon: '🥈', category: 'tournament' },
];

module.exports = {
  ELEMENTS,
  BEATS,
  DEFAULT_CONFIG,
  serverSeedHash,
  combineSeed,
  beaconSeed,
  rngFromSeed,
  deriveFighter,
  resolveMatch,
  updateElo,
  SCHEMA,
  BADGE_DEFS,
};
