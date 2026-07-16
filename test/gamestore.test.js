// Verginals Arena store: matchmaking, duel resolution, Elo/streak/House/badges, persistence.
// Hermetic: temp data dir, injected clock and server seed. Run: node test/gamestore.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { GameStore, validateLoadout, START_ELO } = require('../src/gamestore');
const { combineSeed, serverSeedHash } = require('../src/game');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

function freshStore(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  let t = 1_000_000;
  return new GameStore({
    dataDir: dir,
    now: () => (t += 1000),
    serverSeed: () => 'a'.repeat(64),
    ...over,
  }).load();
}

// A fighter with no traits by default.
const fighter = (address, over = {}) => ({ address, house: null, rarityScore: 0, comeback: false, shield: false, verginal: null, ...over });

// Loadouts where p1 (first arg's attacks) beats p2 every round: fire>earth, earth>water, water>fire.
const WIN = { attacks: ['fire', 'earth', 'water'], poisonRound: null, potionRound: null, shieldRound: null };
const LOSE = { attacks: ['earth', 'water', 'fire'], poisonRound: null, potionRound: null, shieldRound: null };

// --- matchmaking ---
test('first loadout waits, second resolves', () => {
  const s = freshStore();
  const q1 = s.enqueueOrMatch(fighter('DA'), WIN, 'seedA');
  assert.strictEqual(q1.status, 'waiting');
  assert.ok(q1.serverSeedHash && q1.matchId);
  const q2 = s.enqueueOrMatch(fighter('DB'), LOSE, 'seedB');
  assert.strictEqual(q2.status, 'resolved');
  assert.strictEqual(q2.match.winner, 'DA');
  assert.deepStrictEqual(q2.match.score, [3, 0]);
});

test('a player already waiting does not self-play', () => {
  const s = freshStore();
  const q1 = s.enqueueOrMatch(fighter('DA'), WIN, 'x');
  const q2 = s.enqueueOrMatch(fighter('DA'), LOSE, 'y'); // same address queues again
  assert.strictEqual(q2.status, 'waiting');
  assert.strictEqual(q2.matchId, q1.matchId);
});

// --- provable fairness ---
test('resolved match reveals the server seed and the derivation checks out', () => {
  const s = freshStore();
  const q1 = s.enqueueOrMatch(fighter('DA'), WIN, '');
  const { match } = s.enqueueOrMatch(fighter('DB'), LOSE, 'cs');
  assert.strictEqual(match.serverSeed, 'a'.repeat(64));
  assert.strictEqual(serverSeedHash(match.serverSeed), q1.serverSeedHash);
  assert.strictEqual(match.seed, combineSeed(match.serverSeed, match.clientSeed, match.id));
});

// --- standings ---
test('a 1v1 win moves Elo, wins/losses, streak, and House points', () => {
  const s = freshStore();
  s.enqueueOrMatch(fighter('DA', { house: 'fire' }), WIN, '');
  s.enqueueOrMatch(fighter('DB', { house: 'water' }), LOSE, '');
  const a = s.player('DA');
  const b = s.player('DB');
  assert.strictEqual(a.elo, START_ELO + 16);
  assert.strictEqual(b.elo, START_ELO - 16);
  assert.strictEqual(a.wins, 1);
  assert.strictEqual(b.losses, 1);
  assert.strictEqual(a.streak, 1);
  assert.strictEqual(a.bestStreak, 1);
  assert.strictEqual(b.streak, 0);
  const houses = Object.fromEntries(s.houseStandings().map((h) => [h.house, h]));
  assert.strictEqual(houses.fire.points, 3); // winner's House
  assert.strictEqual(houses.water.points, 1); // loser's House (participation)
});

test('first_blood is awarded on the first duel', () => {
  const s = freshStore();
  s.enqueueOrMatch(fighter('DA'), WIN, '');
  const { match } = s.enqueueOrMatch(fighter('DB'), LOSE, '');
  assert.ok(s.player('DA').badges.includes('first_blood'));
  assert.ok(s.player('DB').badges.includes('first_blood'));
  assert.ok(match.newBadges['DA'].includes('first_blood'));
});

test('duel_master after ten wins', () => {
  const s = freshStore();
  for (let i = 0; i < 10; i++) {
    s.enqueueOrMatch(fighter('DA'), WIN, '');           // DA waits
    s.enqueueOrMatch(fighter('D' + i), LOSE, '');        // fresh opponent loses
  }
  assert.strictEqual(s.player('DA').wins, 10);
  assert.ok(s.player('DA').badges.includes('duel_master'));
});

// --- bot mode ---
test('bot matches count for the human but never move Elo or House Wars', () => {
  const s = freshStore();
  const m = s.playBot(fighter('DA', { house: 'fire' }), WIN, fighter('BOT'), LOSE, '');
  assert.strictEqual(m.winner, 'DA');
  const a = s.player('DA');
  assert.strictEqual(a.elo, START_ELO);   // unchanged by a bot win
  assert.strictEqual(a.matches, 1);
  assert.strictEqual(a.wins, 1);
  assert.strictEqual(s.houseStandings().length, 0); // no House points from bot play
  assert.strictEqual(s.player('BOT').matches, 0);    // the bot is not tracked
});

// --- battle history ---
test('historyFor returns the player recent matches, newest first, from their point of view', () => {
  const s = freshStore();
  s.playBot(fighter('DA', { house: 'fire', verginal: 194 }), WIN, fighter('BOT', { verginal: null }), LOSE, '');
  s.playBot(fighter('DA', { house: 'fire', verginal: 194 }), LOSE, fighter('BOT', { verginal: null }), WIN, '');
  const h = s.historyFor('DA');
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].result, 'loss');           // newest first
  assert.strictEqual(h[1].result, 'win');
  assert.strictEqual(h[0].myVerginal, 194);
  assert.strictEqual(h[0].oppVerginal, null);         // bot has no Verginal
  assert.strictEqual(h[0].oppAddress, 'BOT');
  assert.ok(h[0].seed && Array.isArray(h[0].moves));  // enough to rebuild a replay
  assert.strictEqual(s.historyFor('SOMEONE_ELSE').length, 0);
});

// --- leaderboard ---
test('leaderboard is ordered by Elo', () => {
  const s = freshStore();
  // DA beats DB, so DA > default > DB.
  s.enqueueOrMatch(fighter('DA'), WIN, '');
  s.enqueueOrMatch(fighter('DB'), LOSE, '');
  const lb = s.leaderboard();
  assert.strictEqual(lb[0].address, 'DA');
  assert.strictEqual(lb[lb.length - 1].address, 'DB');
});

// --- validation ---
test('validateLoadout rejects bad attacks and out-of-range slots', () => {
  assert.throws(() => validateLoadout(fighter('DA'), { attacks: ['fire', 'water'] }), /3 attacks/);
  assert.throws(() => validateLoadout(fighter('DA'), { attacks: ['fire', 'wind', 'earth'] }), /must be one of/);
  assert.throws(() => validateLoadout(fighter('DA'), { attacks: ['fire', 'water', 'earth'], poisonRound: 5 }), /poisonRound/);
  assert.throws(() => validateLoadout(fighter('DA'), { attacks: ['fire', 'water', 'earth'], shieldRound: 5 }), /shieldRound/);
  // the shield is a standard power-up: any fighter may use one, no rare RUNE required
  validateLoadout(fighter('DA'), { attacks: ['fire', 'water', 'earth'], shieldRound: 1 });
});

// --- persistence ---
test('state survives a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const opts = { dataDir: dir, now: () => 1234, serverSeed: () => 'a'.repeat(64) };
  const s1 = new GameStore(opts).load();
  s1.enqueueOrMatch(fighter('DA'), WIN, '');
  s1.enqueueOrMatch(fighter('DB'), LOSE, '');
  const s2 = new GameStore(opts).load();
  assert.strictEqual(s2.player('DA').wins, 1);
  assert.strictEqual(s2.leaderboard()[0].address, 'DA');
});

console.log(`\n${passed} passed`);
