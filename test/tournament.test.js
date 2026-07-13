// Verginals Arena tournaments: registration, bracket, block-hash beacon resolution, badges,
// forfeits, and loadout redaction (anti-cheat). Hermetic. Run: node test/tournament.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GameStore } = require('../src/gamestore');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-t-'));
  let t = 1_000_000;
  return new GameStore({ dataDir: dir, now: () => (t += 1000), serverSeed: () => 'a'.repeat(64) }).load();
}

const fighter = (address, over = {}) => ({ address, house: null, rarityScore: 0, comeback: false, shield: false, verginal: null, ...over });
// A loadout that beats WEAK every round: fire>earth, earth>water, water>fire.
const STRONG = { attacks: ['fire', 'earth', 'water'], poisonRound: null, potionRound: null, shieldRound: null };
const WEAK = { attacks: ['earth', 'water', 'fire'], poisonRound: null, potionRound: null, shieldRound: null };
const BEACON = 'b'.repeat(64);

function fill(s, id, n) {
  for (let i = 0; i < n; i++) s.joinTournament(id, fighter('D' + i, { house: ['fire', 'water', 'earth'][i % 3] }));
}

// Everyone submits STRONG except we make a designated winner beat everyone: to keep it fully
// deterministic, every player submits STRONG, so every match is a mirror decided by the beacon.
// That still exercises the whole pipeline; we assert a single champion emerges with valid badges.
function submitAll(s, id, loadout = STRONG) {
  const t = s.getTournament(id);
  const round = t.rounds[t.currentRound - 1];
  for (const m of round.matches) {
    if (m.status !== 'resolved') {
      s.submitTournamentLoadout(id, m.p1, loadout);
      s.submitTournamentLoadout(id, m.p2, loadout);
    }
  }
}

test('createTournament rejects a non-standard size', () => {
  const s = freshStore();
  assert.throws(() => s.createTournament({ name: 'x', size: 7 }), /size must be one of/);
});

test('cannot start until full, and no double-join', () => {
  const s = freshStore();
  const t = s.createTournament({ name: 'Cup', size: 8 });
  s.joinTournament(t.id, fighter('D0'));
  assert.throws(() => s.joinTournament(t.id, fighter('D0')), /already joined/);
  assert.throws(() => s.startTournament(t.id, BEACON), /need 8 players/);
});

test('an 8-player bracket runs to a single champion with correct badges', () => {
  const s = freshStore();
  const t0 = s.createTournament({ name: 'Cup', size: 8 });
  fill(s, t0.id, 8);
  s.startTournament(t0.id, BEACON);

  // 3 rounds: 8 -> 4 -> 2 -> champion.
  submitAll(s, t0.id); s.resolveTournamentRound(t0.id, BEACON);      // round of 8
  submitAll(s, t0.id); s.resolveTournamentRound(t0.id, 'c'.repeat(64)); // round of 4
  submitAll(s, t0.id); const t = s.resolveTournamentRound(t0.id, 'd'.repeat(64)); // final

  assert.strictEqual(t.status, 'ended');
  assert.ok(t.championAddress);
  const champ = s.player(t.championAddress);
  assert.ok(champ.badges.includes('champion'));
  assert.ok(champ.badges.includes('finalist'));
  assert.ok(champ.badges.includes('tournament_debut'));

  // Exactly one runner_up, and everyone has top_8 (they all entered the round of 8).
  const players = t.participants.map((p) => s.player(p.address));
  assert.strictEqual(players.filter((p) => p.badges.includes('runner_up')).length, 1);
  assert.ok(players.every((p) => p.badges.includes('top_8')));
  assert.strictEqual(players.filter((p) => p.badges.includes('champion')).length, 1);
});

test('resolution is deterministic for a given set of beacons', () => {
  function run() {
    const s = freshStore();
    const t0 = s.createTournament({ name: 'Cup', size: 8 });
    fill(s, t0.id, 8);
    s.startTournament(t0.id, BEACON);
    submitAll(s, t0.id); s.resolveTournamentRound(t0.id, BEACON);
    submitAll(s, t0.id); s.resolveTournamentRound(t0.id, BEACON);
    submitAll(s, t0.id); return s.resolveTournamentRound(t0.id, BEACON).championAddress;
  }
  assert.strictEqual(run(), run());
});

test('a no-show forfeits to the player who submitted', () => {
  const s = freshStore();
  const t0 = s.createTournament({ name: 'Cup', size: 8 });
  fill(s, t0.id, 8);
  s.startTournament(t0.id, BEACON);
  const t = s.getTournament(t0.id);
  const m = t.rounds[0].matches[0];
  s.submitTournamentLoadout(t0.id, m.p1, STRONG); // only p1 submits
  // submit for the rest so the round can resolve
  t.rounds[0].matches.slice(1).forEach((mm) => { s.submitTournamentLoadout(t0.id, mm.p1, STRONG); s.submitTournamentLoadout(t0.id, mm.p2, STRONG); });
  const res = s.resolveTournamentRound(t0.id, BEACON);
  const rm = res.rounds[0].matches[0];
  assert.strictEqual(rm.winner, m.p1); // p1 advanced by forfeit
});

test('opponent loadouts are hidden until the round resolves', () => {
  const s = freshStore();
  const t0 = s.createTournament({ name: 'Cup', size: 8 });
  fill(s, t0.id, 8);
  s.startTournament(t0.id, BEACON);
  const m = s.getTournament(t0.id).rounds[0].matches[0];
  s.submitTournamentLoadout(t0.id, m.p1, STRONG);
  const view = s.getTournament(t0.id).rounds[0].matches[0];
  assert.strictEqual(view.p1Submitted, true);
  assert.strictEqual(view.l1, undefined); // not revealed while pending
  assert.strictEqual(view.l2, undefined);
});

test('you cannot submit twice, and non-participants cannot submit', () => {
  const s = freshStore();
  const t0 = s.createTournament({ name: 'Cup', size: 8 });
  fill(s, t0.id, 8);
  s.startTournament(t0.id, BEACON);
  const m = s.getTournament(t0.id).rounds[0].matches[0];
  s.submitTournamentLoadout(t0.id, m.p1, STRONG);
  assert.throws(() => s.submitTournamentLoadout(t0.id, m.p1, STRONG), /already submitted/);
  assert.throws(() => s.submitTournamentLoadout(t0.id, 'Znobody', STRONG), /no pending match/);
});

test('setTrophy records the champion inscription id', () => {
  const s = freshStore();
  const t0 = s.createTournament({ name: 'Cup', size: 8 });
  fill(s, t0.id, 8);
  s.startTournament(t0.id, BEACON);
  for (let i = 0; i < 3; i++) { submitAll(s, t0.id); s.resolveTournamentRound(t0.id, BEACON); }
  const t = s.setTrophy(t0.id, 'champion', 'abc123i0');
  assert.strictEqual(t.trophies.champion, 'abc123i0');
});

test('tournament state survives a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-t-'));
  const opts = { dataDir: dir, now: () => 42, serverSeed: () => 'a'.repeat(64) };
  const s1 = new (require('../src/gamestore').GameStore)(opts).load();
  const t0 = s1.createTournament({ name: 'Cup', size: 8 });
  fill(s1, t0.id, 8);
  s1.startTournament(t0.id, BEACON);
  const s2 = new (require('../src/gamestore').GameStore)(opts).load();
  const t = s2.getTournament(t0.id);
  assert.strictEqual(t.status, 'running');
  assert.strictEqual(t.participants.length, 8);
});

console.log(`\n${passed} passed`);
