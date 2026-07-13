'use strict';
// Verginals Arena store: matchmaking, duel resolution, and standings, persisted to one JSON file
// (the same atomic-write pattern as the order book and promo controllers, so the game adds no
// native dependency). The pure combat maths live in src/game.js; this module drives a duel from two
// blind loadouts, updates Elo / streaks / House Wars / badges, and keeps a bounded match history.
//
// A "loadout" is what a player submits for a whole duel, chosen without seeing the opponent's:
//   { attacks: ['fire','water','earth'], poisonRound: 0|1|2|null, potionRound: ...|null, shieldRound: ...|null }
// Each special is a single round slot, so a player naturally spends at most one poison/potion/shield
// per match. Two loadouts plus a seed fully determine the outcome.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ELEMENTS, DEFAULT_CONFIG, resolveMatch, combineSeed, serverSeedHash, updateElo,
} = require('./game');

const START_ELO = 1200;
const HISTORY_CAP = 500;         // keep the most recent resolved matches on disk
const HOUSE_WIN_POINTS = 3;      // House Wars: points a win scores for the winner's House
const HOUSE_PLAY_POINTS = 1;     // participation points for the loser's House

// Participation badges reachable in 1v1 (tournament badges are awarded by the tournament code).
const PARTICIPATION_BADGES = [
  { key: 'first_blood', when: (p) => p.matches >= 1 },
  { key: 'duel_master', when: (p) => p.wins >= 10 },
  { key: 'veteran', when: (p) => p.matches >= 50 },
  { key: 'relentless', when: (p) => p.matches >= 100 },
];

/** Turn one player's loadout into the three per-round move objects the engine consumes. */
function loadoutSide(loadout) {
  return [0, 1, 2].map((i) => ({
    element: loadout.attacks[i],
    poison: loadout.poisonRound === i,
    potion: loadout.potionRound === i,
    shield: loadout.shieldRound === i,
  }));
}

/** Validate a submitted loadout for a fighter; throws with a clear message when illegal. */
function validateLoadout(fighter, loadout) {
  if (!loadout || !Array.isArray(loadout.attacks) || loadout.attacks.length !== 3) {
    throw new Error('loadout needs exactly 3 attacks');
  }
  loadout.attacks.forEach((e, i) => {
    if (!ELEMENTS.includes(e)) throw new Error(`attack ${i + 1} must be one of ${ELEMENTS.join('/')}`);
  });
  for (const slot of ['poisonRound', 'potionRound', 'shieldRound']) {
    const v = loadout[slot];
    if (v != null && ![0, 1, 2].includes(v)) throw new Error(`${slot} must be 0, 1, 2 or null`);
  }
  if (loadout.shieldRound != null && !fighter.shield) {
    throw new Error('this Verginal has no rare RUNE, so it cannot use a shield');
  }
}

class GameStore {
  /**
   * @param {object}   opts
   * @param {string}   opts.dataDir     dir holding game.json
   * @param {Function} [opts.now]       () => ms, injectable for tests
   * @param {Function} [opts.serverSeed] () => hex, injectable for tests
   * @param {object}   [opts.config]    trait config override (see game.js DEFAULT_CONFIG)
   * @param {string}   [opts.seasonName]
   */
  constructor(opts = {}) {
    this.file = path.join(opts.dataDir, 'game.json');
    this.now = opts.now || (() => Date.now());
    this.serverSeedFn = opts.serverSeed || (() => crypto.randomBytes(32).toString('hex'));
    this.config = opts.config || DEFAULT_CONFIG;
    this.seasonName = opts.seasonName || 'Season 1';
  }

  load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.state = null;
    }
    if (!this.state) {
      this.state = {
        season: { id: 1, name: this.seasonName, startedAt: this.now() },
        players: {},        // address -> player record
        houses: {},         // house -> { points, wins }
        waiting: null,      // a single open 1v1 loadout awaiting an opponent
        matches: [],        // recent resolved matches (bounded)
        seq: 0,
      };
      this._save();
    }
    return this;
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  _id(prefix) {
    this.state.seq += 1;
    return `${prefix}_${this.state.seq}_${this.now().toString(36)}`;
  }

  _player(address, house) {
    let p = this.state.players[address];
    if (!p) {
      p = { address, elo: START_ELO, wins: 0, losses: 0, matches: 0, house: house || null, streak: 0, bestStreak: 0, badges: [] };
      this.state.players[address] = p;
    }
    if (house && p.house !== house) p.house = house; // reflect the Verginal they are currently fighting with
    return p;
  }

  /** Public view of a player (no secrets to hide here, but keeps a stable shape). */
  player(address) {
    const p = this.state.players[address];
    return p ? { ...p, badges: [...p.badges] } : { address, elo: START_ELO, wins: 0, losses: 0, matches: 0, house: null, streak: 0, bestStreak: 0, badges: [] };
  }

  _awardBadges(p) {
    const earned = [];
    for (const b of PARTICIPATION_BADGES) {
      if (!p.badges.includes(b.key) && b.when(p)) { p.badges.push(b.key); earned.push(b.key); }
    }
    return earned;
  }

  _bumpHouse(house, points, won) {
    if (!house) return;
    const h = this.state.houses[house] || { points: 0, wins: 0 };
    h.points += points;
    if (won) h.wins += 1;
    this.state.houses[house] = h;
  }

  /**
   * Submit a 1v1 loadout. If someone else is already waiting, the two fight immediately and the
   * resolved match is returned; otherwise this loadout becomes the waiting match. A player who is
   * already waiting just gets their pending match back (no self-play).
   *
   * @param {object} fighter  { address, house, rarityScore, comeback, shield, verginal }
   * @param {object} loadout  see module header
   * @param {string} [clientSeed] entropy from the joining player's wallet/client
   */
  enqueueOrMatch(fighter, loadout, clientSeed) {
    validateLoadout(fighter, loadout);

    const waiting = this.state.waiting;
    if (waiting && waiting.fighter.address === fighter.address) {
      return { status: 'waiting', matchId: waiting.matchId, serverSeedHash: waiting.serverSeedHash };
    }

    if (!waiting) {
      const serverSeed = this.serverSeedFn();
      const matchId = this._id('m');
      this.state.waiting = {
        matchId, fighter, loadout, serverSeed,
        serverSeedHash: serverSeedHash(serverSeed), createdAt: this.now(),
      };
      this._save();
      return { status: 'waiting', matchId, serverSeedHash: this.state.waiting.serverSeedHash };
    }

    // Pair the joiner (fighter) with the waiting player and resolve.
    this.state.waiting = null;
    const match = this._resolve({
      matchId: waiting.matchId,
      p1: waiting.fighter, l1: waiting.loadout,
      p2: fighter, l2: loadout,
      serverSeed: waiting.serverSeed,
      serverSeedHash: waiting.serverSeedHash,
      clientSeed: clientSeed || '',
      mode: '1v1',
    });
    return { status: 'resolved', match };
  }

  /** Play immediately against a supplied bot fighter/loadout (demo mode, no opponent needed). */
  playBot(fighter, loadout, botFighter, botLoadout, clientSeed) {
    validateLoadout(fighter, loadout);
    validateLoadout(botFighter, botLoadout);
    const serverSeed = this.serverSeedFn();
    return this._resolve({
      matchId: this._id('b'),
      p1: fighter, l1: loadout,
      p2: botFighter, l2: botLoadout,
      serverSeed, serverSeedHash: serverSeedHash(serverSeed),
      clientSeed: clientSeed || '',
      mode: 'bot',
    });
  }

  _resolve({ matchId, p1, l1, p2, l2, serverSeed, serverSeedHash: ssh, clientSeed, mode }) {
    const seed = combineSeed(serverSeed, clientSeed, matchId);
    const sideA = loadoutSide(l1);
    const sideB = loadoutSide(l2);
    const moves = [0, 1, 2].map((i) => ({ p1: sideA[i], p2: sideB[i] }));
    const result = resolveMatch({ p1, p2, moves, seed, config: this.config });

    const winnerIsP1 = result.winner === p1.address;
    const record = {
      id: matchId, mode, at: this.now(),
      p1: p1.address, p2: p2.address,
      p1Verginal: p1.verginal ?? null, p2Verginal: p2.verginal ?? null,
      winner: result.winner, loser: result.loser, score: result.score, rounds: result.rounds,
      moves, // both loadouts, per round: enough to replay the fight from (moves, seed) alone
      seed, serverSeed, serverSeedHash: ssh, clientSeed,
    };

    // Standings: bot matches count for the human's fun/badges but do not move Elo or House Wars,
    // so a bot cannot farm rating. Only real PvP updates the ladder.
    if (mode === '1v1') {
      const a = this._player(p1.address, p1.house);
      const b = this._player(p2.address, p2.house);
      const [newA, newB] = updateElo(a.elo, b.elo, winnerIsP1, this.config.eloK);
      a.elo = newA; b.elo = newB;
      const [winner, loser] = winnerIsP1 ? [a, b] : [b, a];
      winner.wins += 1; loser.losses += 1;
      winner.matches += 1; loser.matches += 1;
      winner.streak += 1; winner.bestStreak = Math.max(winner.bestStreak, winner.streak);
      loser.streak = 0;
      this._bumpHouse(winner.house, HOUSE_WIN_POINTS, true);
      this._bumpHouse(loser.house, HOUSE_PLAY_POINTS, false);
      record.newBadges = { [winner.address]: this._awardBadges(winner), [loser.address]: this._awardBadges(loser) };
    } else {
      const a = this._player(p1.address, p1.house);
      a.matches += 1;
      if (winnerIsP1) { a.wins += 1; a.streak += 1; a.bestStreak = Math.max(a.bestStreak, a.streak); }
      else { a.losses += 1; a.streak = 0; }
      record.newBadges = { [a.address]: this._awardBadges(a) };
    }

    this.state.matches.unshift(record);
    if (this.state.matches.length > HISTORY_CAP) this.state.matches.length = HISTORY_CAP;
    this._save();
    return record;
  }

  /** Elo ladder, highest first. */
  leaderboard(limit = 50) {
    return Object.values(this.state.players)
      .slice()
      .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
      .slice(0, limit)
      .map((p) => ({ address: p.address, elo: p.elo, wins: p.wins, losses: p.losses, house: p.house, bestStreak: p.bestStreak }));
  }

  /** House Wars standings for the season. */
  houseStandings() {
    return Object.entries(this.state.houses)
      .map(([house, h]) => ({ house, points: h.points, wins: h.wins }))
      .sort((a, b) => b.points - a.points);
  }

  getMatch(id) {
    return this.state.matches.find((m) => m.id === id) || null;
  }

  /** Is this address the one currently waiting for an opponent? Returns the safe public view. */
  waitingFor(address) {
    const w = this.state.waiting;
    if (!w || w.fighter.address !== address) return null;
    return { matchId: w.matchId, serverSeedHash: w.serverSeedHash, createdAt: w.createdAt };
  }
}

module.exports = { GameStore, loadoutSide, validateLoadout, START_ELO };
