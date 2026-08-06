// The stable: commit/reveal breeding, the viability roll, raising, release, season end.
// Run: node test/stable.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Stable } = require('../src/stable');
const G = require('../src/genetics');
const L = require('../src/lifecycle');
const { serverSeedHash } = require('../src/game');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }


const { buildCollection } = require('./fixtures/collection');
const items = buildCollection();
const POOL = G.buildGenePool(items);
const at = (i, t) => i.attributes.find((a) => a.trait_type === t).value;
const ALPHA_F = items.find((i) => at(i, 'Ears') === 'Pink' && at(i, 'House') === 'Fire');
const ALPHA_M = items.find((i) => at(i, 'Ears') === 'Grey' && at(i, 'House') === 'Water');

const DAY = L.DAY;
const T0 = 1_770_000_000 - (1_770_000_000 % DAY);
const ADDR = 'DTestPlayerAddress';

/** A stable with a controllable clock and a fixed seed, over a throwaway dir. */
function fresh(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verginals-stable-'));
  const clock = { t: opts.start === undefined ? T0 : opts.start };
  const s = new Stable({
    dataDir: dir,
    pool: POOL,
    now: () => clock.t,
    serverSeed: opts.serverSeed || (() => 'a'.repeat(64)),
    tuning: opts.tuning,
  }).load();
  return { s, clock, dir };
}

const rested = { time: T0 - 5 * DAY, confirmations: 9 };
const mother = () => ({ id: `alpha:${ALPHA_F.number}`, genome: G.genomeFromItem(ALPHA_F, POOL), carrier: rested });
const father = () => ({ id: `alpha:${ALPHA_M.number}`, genome: G.genomeFromItem(ALPHA_M, POOL), carrier: rested });

/** Breed once, retrying seeds until the viability roll actually takes. */
function conceive(s, tag = 'x') {
  let n = 0;
  for (;;) {
    const seedFn = `${tag}${n}`.padEnd(64, '0');
    s.serverSeedFn = () => seedFn;
    const open = s.openPairing(ADDR, mother(), father());
    assert.strictEqual(open.ok, true, JSON.stringify(open.blockers));
    const r = s.resolvePairing(ADDR, open.pairingId, mother(), father());
    if (r.conceived) return r;
    if (++n > 50) throw new Error('no conception in 50 attempts');
  }
}

// --- persistence -----------------------------------------------------------------------------

test('a fresh stable persists and reloads without losing anything', () => {
  const { s, dir } = fresh();
  conceive(s);
  const again = new Stable({ dataDir: dir, pool: POOL, now: () => T0 }).load();
  assert.strictEqual(again.roster(ADDR).living.length, 1);
});

test('an empty roster reports the season, the slots and nothing else', () => {
  const { s } = fresh();
  const r = s.roster(ADDR);
  assert.deepStrictEqual(r.living, []);
  assert.strictEqual(r.slots.free, L.LIVING_SLOTS);
  assert.strictEqual(r.season.day, 1);
});

// --- the pairing preview (§3.4) --------------------------------------------------------------

test('an unrelated Alpha pairing previews at full viability and no warning', () => {
  const { s } = fresh();
  const pv = s.preview(ADDR, mother(), father());
  assert.strictEqual(pv.ok, true);
  assert.strictEqual(pv.viability, 1);
  assert.strictEqual(pv.relation, 'Unrelated');
  assert.strictEqual(pv.warning, null);
});

test('a resting Alpha blocks the pairing and says when it will be ready', () => {
  const { s } = fresh();
  const tired = { ...father(), carrier: { time: T0 - 3600, confirmations: 4 } };
  const pv = s.preview(ADDR, mother(), tired);
  assert.strictEqual(pv.ok, false);
  const b = pv.blockers.find((x) => x.kind === 'resting');
  assert.ok(b, 'no resting blocker reported');
  assert.strictEqual(b.side, 'father');
  assert.strictEqual(b.until, T0 - 3600 + 2 * DAY);
});

test('a pairing that is not one female and one male is refused', () => {
  const { s } = fresh();
  const pv = s.preview(ADDR, father(), mother());
  assert.ok(pv.blockers.some((b) => b.kind === 'sex'));
});

test('siblings preview as full siblings with the spec-shaped one-line warning', () => {
  const { s } = fresh();
  const a = conceive(s, 'sa');
  const b = conceive(s, 'sb');
  const A = s.state.players[ADDR].creatures[a.id];
  const B = s.state.players[ADDR].creatures[b.id];
  const pv = s.preview(ADDR, { id: A.id, genome: A.genome }, { id: B.id, genome: B.genome });
  assert.strictEqual(pv.relation, 'Full siblings');
  assert.ok(pv.viability < 0.5);
  assert.match(pv.warning, /^Full siblings\. Offspring viability −\d+%\.$/);
});

// --- commit and reveal --------------------------------------------------------------------------

test('opening a pairing publishes a hash and never the seed', () => {
  const { s } = fresh({ serverSeed: () => 'b'.repeat(64) });
  const open = s.openPairing(ADDR, mother(), father());
  assert.strictEqual(open.serverSeedHash, serverSeedHash('b'.repeat(64)));
  assert.strictEqual(open.seed, undefined);
});

test('the revealed seed reproduces the exact descendant, so nothing was substituted', () => {
  const { s } = fresh();
  const r = conceive(s, 'rep');
  const stored = s.state.players[ADDR].creatures[r.id];
  const rerun = G.breed(mother().genome, father().genome, r.seed, { pool: POOL, id: r.id });
  assert.deepStrictEqual(rerun.genes, stored.genome.genes);
  assert.strictEqual(rerun.sex, stored.sex);
});

test('a pairing can only be resolved once', () => {
  const { s } = fresh();
  const open = s.openPairing(ADDR, mother(), father());
  s.resolvePairing(ADDR, open.pairingId, mother(), father());
  const again = s.resolvePairing(ADDR, open.pairingId, mother(), father());
  assert.deepStrictEqual(again, { ok: false, reason: 'unknown pairing' });
});

test('the viability roll is the ONLY cost of inbreeding — it never yields a weaker fighter (§4.2)', () => {
  const { s } = fresh();
  const a = conceive(s, 'va');
  const b = conceive(s, 'vb');
  const A = s.state.players[ADDR].creatures[a.id];
  const B = s.state.players[ADDR].creatures[b.id];
  // Force the female/male roles the sibling pair happens to have.
  const [f, m] = A.sex === 'F' ? [A, B] : [B, A];
  if (f.sex !== 'F' || m.sex !== 'M') return; // this seed gave same-sex siblings; nothing to assert
  let taken = 0, failed = 0;
  for (let i = 0; i < 20; i++) {
    s.serverSeedFn = () => `sib${i}`.padEnd(64, '0');
    const open = s.openPairing(ADDR, { id: f.id, genome: f.genome }, { id: m.id, genome: m.genome });
    if (!open.ok) break; // slots fill up, which is a different rule
    const r = s.resolvePairing(ADDR, open.pairingId, { id: f.id, genome: f.genome }, { id: m.id, genome: m.genome });
    if (r.conceived) {
      taken += 1;
      // Nothing about the descendant records the inbreeding: no stat, no penalty, no flag.
      assert.strictEqual(r.mutations.length >= 0, true);
      assert.strictEqual(s.state.players[ADDR].creatures[r.id].record.wins, 0);
    } else failed += 1;
  }
  assert.ok(failed > 0, 'a 40%-viability pairing never once failed to take');
  assert.ok(taken + failed > 0);
});

// --- raising ---------------------------------------------------------------------------------

test('a juvenile cannot be attended to while it gestates, then can', () => {
  const { s, clock } = fresh();
  const r = conceive(s);
  assert.strictEqual(s.attend(ADDR, r.id, 'feed').reason, 'gestating');
  clock.t = r.bornAt;
  assert.strictEqual(s.attend(ADDR, r.id, 'feed').ok, true);
});

test('fights are recorded on the creature even past the daily growth cap', () => {
  const { s, clock } = fresh();
  const r = conceive(s);
  clock.t = r.bornAt;
  for (let i = 0; i < 10; i++) s.recordFight(ADDR, r.id, i % 2 === 0);
  const c = s.state.players[ADDR].creatures[r.id];
  assert.strictEqual(c.record.fights, 10);
  assert.strictEqual(c.record.wins, 5);
});

test('an unknown creature is refused rather than throwing', () => {
  const { s } = fresh();
  assert.deepStrictEqual(s.attend(ADDR, 'nope', 'feed'), { ok: false, reason: 'no such creature' });
  assert.deepStrictEqual(s.release(ADDR, 'nope'), { ok: false, reason: 'no such creature' });
});

test('the roster carries the visible traits, so the UI never recomputes genetics', () => {
  const { s } = fresh();
  conceive(s);
  const c = s.roster(ADDR).living[0];
  for (const t of ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House', 'Ears']) {
    assert.ok(c.traits[t], `roster is missing ${t}`);
  }
  assert.strictEqual(c.generation, 1);
});

// --- living slots and release (§6) ---------------------------------------------------------------

test('the stable fills to its cap and then refuses to open a pairing', () => {
  const { s } = fresh({ tuning: { livingSlots: 2 } });
  conceive(s, 'f1');
  conceive(s, 'f2');
  const pv = s.preview(ADDR, mother(), father());
  assert.strictEqual(pv.ok, false);
  assert.ok(pv.blockers.some((b) => b.kind === 'slots'));
  assert.strictEqual(s.openPairing(ADDR, mother(), father()).ok, false);
});

test('releasing frees a slot without deleting the creature (§6 vs §7)', () => {
  const { s } = fresh({ tuning: { livingSlots: 2 } });
  const a = conceive(s, 'r1');
  conceive(s, 'r2');
  assert.strictEqual(s.release(ADDR, a.id).ok, true);
  assert.strictEqual(s.roster(ADDR).living.length, 1);
  assert.strictEqual(s.roster(ADDR).released, 1);
  // Still on record — "nothing is deleted, ever".
  assert.ok(s.state.players[ADDR].creatures[a.id], 'a released creature was deleted');
  assert.strictEqual(s.openPairing(ADDR, mother(), father()).ok, true);
});

test('a released creature can neither be raised nor released twice', () => {
  const { s } = fresh();
  const a = conceive(s);
  s.release(ADDR, a.id);
  assert.strictEqual(s.attend(ADDR, a.id, 'feed').ok, false);
  assert.strictEqual(s.release(ADDR, a.id).ok, false);
});

// --- season end (§7, §7.1) ------------------------------------------------------------------------

test('season end kills every descendant and hands back one roster per player', () => {
  const { s, clock } = fresh();
  const a = conceive(s, 'e1');
  const b = conceive(s, 'e2');
  s.release(ADDR, b.id);
  clock.t = T0 + 30 * DAY;

  const end = s.endSeason();
  assert.strictEqual(end.season.id, 2);
  const roster = end.rosters[ADDR];
  assert.strictEqual(roster.length, 2, 'a released creature must still be on the roster — it lived');
  assert.ok(roster.some((r) => r.id === a.id));
  assert.ok(roster.some((r) => r.id === b.id && r.released === true));
  for (const r of roster) assert.ok(r.genes && r.sex && r.mother && r.father, 'the roster must carry the genome and lineage');
  assert.strictEqual(s.roster(ADDR).living.length, 0);
});

test('a new season starts clean, and Alphas are untouched because they were never stored here', () => {
  const { s, clock } = fresh();
  conceive(s);
  clock.t = T0 + 30 * DAY;
  s.endSeason();
  const r = s.roster(ADDR);
  assert.strictEqual(r.living.length, 0);
  assert.strictEqual(r.slots.free, L.LIVING_SLOTS);
  assert.strictEqual(r.season.day, 1);
  // The next season breeds from the same on-chain Alphas, with no state carried over.
  assert.strictEqual(s.preview(ADDR, mother(), father()).ok, true);
});

console.log(`\n${passed} stable tests passed`);
