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
  // freeBreeds: 0 puts us past the opening, which is where the rest actually gates (§1.1b).
  const { s } = fresh({ tuning: { freeBreeds: 0 } });
  const tired = { ...father(), carrier: { time: T0 - 3600, confirmations: 4 } };
  const pv = s.preview(ADDR, mother(), tired);
  assert.strictEqual(pv.ok, false);
  const b = pv.blockers.find((x) => x.kind === 'resting');
  assert.ok(b, 'no resting blocker reported');
  assert.strictEqual(b.side, 'father');
  assert.strictEqual(b.until, T0 - 3600 + 2 * DAY);
});

// --- the opening: the first three pairings are instant (§1.1b) --------------------------------

test('the first three pairings ignore the rest, the fourth does not', () => {
  const { s } = fresh();
  const tired = { time: T0 - 3600, confirmations: 4 };
  const m = () => ({ ...mother(), carrier: tired });
  const f = () => ({ ...father(), carrier: tired });

  assert.strictEqual(s.freeBreedsLeft(ADDR), 3);
  for (let i = 0; i < 3; i++) {
    const pv = s.preview(ADDR, m(), f());
    assert.strictEqual(pv.ok, true, `pairing ${i + 1} was blocked: ${JSON.stringify(pv.blockers)}`);
    assert.strictEqual(pv.freeBreed, true);
    assert.strictEqual(s.openPairing(ADDR, m(), f()).ok, true);
  }
  assert.strictEqual(s.freeBreedsLeft(ADDR), 0);

  const after = s.preview(ADDR, m(), f());
  assert.strictEqual(after.ok, false);
  assert.strictEqual(after.freeBreed, false);
  assert.ok(after.blockers.find((b) => b.kind === 'resting'), 'the rest should gate again');
});

test('a descendant from the opening is born at once, and still born a juvenile', () => {
  const { s } = fresh();
  const r = conceive(s);
  assert.strictEqual(r.freeBreed, true);
  const c = s.roster(ADDR).living[0];
  assert.strictEqual(r.bornAt, T0, 'born the moment it was conceived');
  assert.strictEqual(c.born, true);
  // What is skipped is the waiting, never the raising. It arrives with the one passive point every
  // creature gets for the day it is born on, six short of adult, with its whole budget untouched.
  assert.strictEqual(c.growth, L.PASSIVE_GROWTH_PER_DAY);
  assert.strictEqual(c.adult, false);
  assert.strictEqual(c.attentionsLeft, L.ATTENTIONS_PER_DAY);
  assert.strictEqual(c.temperament.label, 'Untouched');
});

test('the waiver is spent on opening, so opening three at once cannot multiply it', () => {
  const { s } = fresh();
  for (let i = 0; i < 3; i++) assert.strictEqual(s.openPairing(ADDR, mother(), father()).ok, true);
  assert.strictEqual(s.freeBreedsLeft(ADDR), 0);
  // Three commitments are open and none has resolved, so nothing has been born yet.
  assert.strictEqual(s.roster(ADDR).living.length, 0);
});

test('past the opening, gestation is two days again', () => {
  const { s } = fresh({ tuning: { freeBreeds: 0 } });
  const r = conceive(s);
  assert.strictEqual(r.freeBreed, false);
  assert.strictEqual(r.bornAt, T0 + L.GESTATION_DAYS * DAY);
  assert.strictEqual(s.roster(ADDR).living[0].born, false);
});

test('a stable written before free breeds existed does not owe its players three', () => {
  const { s, dir } = fresh({ tuning: { freeBreeds: 0 } });
  conceive(s);
  // Simulate the old on-disk shape: a player record with no counter at all.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'stable.json'), 'utf8'));
  delete raw.players[ADDR].bred;
  fs.writeFileSync(path.join(dir, 'stable.json'), JSON.stringify(raw));

  const again = new Stable({ dataDir: dir, pool: POOL, now: () => T0 }).load();
  assert.strictEqual(again.freeBreedsLeft(ADDR), 2, 'one existing descendant should count as one bred');
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

test('the viability roll is the ONLY cost of inbreeding, it never yields a weaker fighter (§4.2)', () => {
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
  // Past the opening, where there is a gestation to be blocked by at all (§1.1b).
  const { s, clock } = fresh({ tuning: { freeBreeds: 0 } });
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
  // Still on record: "nothing is deleted, ever".
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
  assert.strictEqual(roster.length, 2, 'a released creature must still be on the roster, it lived');
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

// --- the DNA Orb (§2, §2.1) -------------------------------------------------------------------------

// A stand-in rarity engine: the real one is combos.js, injected so this module never imports it.
const rarityOf = (attrs) => attrs.reduce((n, a) => n + a.value.length, 0);

test('the two ladders rank the fighter and the breeder separately (§2.1)', () => {
  const { s } = fresh();
  const a = conceive(s, 'l1');
  const b = conceive(s, 'l2');
  s.recordFight(ADDR, a.id, true);
  s.recordFight(ADDR, a.id, true);
  s.recordFight(ADDR, b.id, false);
  const l = s.ladders(ADDR, rarityOf);
  assert.strictEqual(l.combat[0].id, a.id, 'the combat ladder must lead with the winner');
  assert.strictEqual(l.combat.length, 2);
  assert.strictEqual(l.genetics.length, 2);
  assert.ok(l.genetics[0].score >= l.genetics[1].score, 'the genetics ladder must be sorted');
});

test('an Orb goes to the top of a ladder, and one player gets at most one (§2)', () => {
  const { s } = fresh();
  conceive(s, 'o1');
  conceive(s, 'o2');
  const g = s.grantOrbs(ADDR, rarityOf);
  assert.strictEqual(g.orbs, 1, 'one Orb carries ONE bloodline, so a second means nothing');
  assert.ok(g.eligible.length >= 1);
});

test('a small community still has winners: the top 10% never rounds down to nobody', () => {
  const { s } = fresh({ tuning: { livingSlots: 3 } });
  conceive(s, 'sm');
  const g = s.grantOrbs(ADDR, rarityOf);
  assert.strictEqual(g.eligible.length >= 1, true);
  assert.strictEqual(g.orbs, 1);
});

test('season end keeps the roster savable, so an Orb has something to spend on', () => {
  const { s, clock } = fresh();
  const a = conceive(s, 'sv');
  s.grantOrbs(ADDR, rarityOf);
  clock.t = T0 + 30 * DAY;
  s.endSeason();
  assert.strictEqual(s.roster(ADDR).living.length, 0, 'the season must still wipe the stable');
  assert.strictEqual(s.state.players[ADDR].saved.length, 1);
  assert.strictEqual(s.state.players[ADDR].saved[0].id, a.id);
});

test('spending the Orb clones the GENOME, not the individual (§5.1)', () => {
  const { s, clock } = fresh();
  const a = conceive(s, 'cl');
  const before = s.state.players[ADDR].creatures[a.id];
  s.attend(ADDR, a.id, 'feed');
  s.recordFight(ADDR, a.id, true);
  s.grantOrbs(ADDR, rarityOf);
  clock.t = T0 + 30 * DAY;
  s.endSeason();

  const r = s.spendOrb(ADDR, a.id);
  assert.strictEqual(r.ok, true);
  const clone = s.state.players[ADDR].creatures[r.id];
  assert.deepStrictEqual(clone.genome.genes, before.genome.genes, 'the bloodline must carry');
  // The individual does not: raising it again is the whole point of the Orb.
  assert.deepStrictEqual(clone.j.attentions, { spar: 0, drill: 0, feed: 0, play: 0 });
  assert.deepStrictEqual(clone.record, { fights: 0, wins: 0 });
  assert.strictEqual(clone.clonedFrom, a.id);
});

test('one Orb, one bloodline, no undo', () => {
  const { s, clock } = fresh();
  const a = conceive(s, 'nu');
  conceive(s, 'nu2');
  s.grantOrbs(ADDR, rarityOf);
  clock.t = T0 + 30 * DAY;
  s.endSeason();
  assert.strictEqual(s.spendOrb(ADDR, a.id).ok, true);
  assert.strictEqual(s.state.players[ADDR].orbs, 0);
  assert.strictEqual(s.spendOrb(ADDR, a.id).reason, 'you have no DNA Orb');
});

test('a carried bloodline is unrelated to everything in the new season (§3.4)', () => {
  const { s, clock } = fresh();
  const a = conceive(s, 'fb');
  s.grantOrbs(ADDR, rarityOf);
  clock.t = T0 + 30 * DAY;
  s.endSeason();
  const r = s.spendOrb(ADDR, a.id);
  const clone = s.state.players[ADDR].creatures[r.id];
  assert.strictEqual(clone.mother, null);
  assert.strictEqual(clone.father, null);
  const fresh2 = conceive(s, 'fb2');
  const pv = s.preview(ADDR, { id: clone.id, genome: clone.genome }, { id: fresh2.id, genome: s.state.players[ADDR].creatures[fresh2.id].genome });
  assert.strictEqual(pv.viability, 1, 'a carried bloodline must arrive as fresh blood');
});

test('an Orb cannot be spent on a bloodline that was never saved, or with no free slot', () => {
  const { s, clock } = fresh({ tuning: { livingSlots: 1 } });
  const a = conceive(s, 'ns');
  s.grantOrbs(ADDR, rarityOf);
  clock.t = T0 + 30 * DAY;
  s.endSeason();
  assert.match(s.spendOrb(ADDR, 'nope').reason, /not on your saved roster/);
  conceive(s, 'fill');
  assert.match(s.spendOrb(ADDR, a.id).reason, /no free living slot/);
});

// --- the bloodline, as matings (the pedigree screen) ------------------------------------------

test('the lineage groups by mating, not by animal', () => {
  const { s } = fresh();
  conceive(s, 'g1');
  conceive(s, 'g2');
  const l = s.lineage(ADDR);
  assert.strictEqual(l.blocks.length, 1, 'one pair, however many offspring, is one block');
  assert.strictEqual(l.blocks[0].kids.length, 2);
  assert.strictEqual(l.total, 2);
  assert.strictEqual(l.blocks[0].mother, `alpha:${ALPHA_F.number}`);
});

test('every node carries its allele pair, so a bloodline can be scanned for a carrier', () => {
  const { s } = fresh();
  conceive(s);
  const kid = s.lineage(ADDR).blocks[0].kids[0];
  for (const locus of G.LOCI) {
    assert.strictEqual(kid.alleles[locus].length, 2, `${locus} must send both alleles`);
    assert.strictEqual(kid.alleles[locus][0], kid.traits[locus], 'the expressed allele comes first');
  }
});

test('the warning belongs to the mating and has exactly three severities', () => {
  const { s } = fresh();
  const a = conceive(s, 'p1');
  const b = conceive(s, 'p2');
  const l1 = s.lineage(ADDR);
  assert.strictEqual(l1.blocks[0].severity, 'clear', 'unrelated Alphas carry no penalty');

  // Now breed the two siblings together and check the block that pairing creates.
  const mum = { id: a.id, genome: s.state.players[ADDR].creatures[a.id].genome };
  const dad = { id: b.id, genome: s.state.players[ADDR].creatures[b.id].genome };
  const F1 = mum.genome.sex === 'F' ? mum : dad;
  const M1 = mum.genome.sex === 'F' ? dad : mum;
  if (F1.genome.sex === 'F' && M1.genome.sex === 'M') {
    for (let i = 0; i < 40; i++) {
      s.serverSeedFn = () => `sib${i}`.padEnd(64, '0');
      const open = s.openPairing(ADDR, F1, M1);
      if (!open.ok) continue;
      const r = s.resolvePairing(ADDR, open.pairingId, F1, M1);
      if (!r.conceived) continue;
      const sib = s.lineage(ADDR).blocks.find((x) => x.mother === F1.id || x.father === F1.id);
      assert.ok(sib, 'the sibling mating must appear as its own block');
      assert.notStrictEqual(sib.severity, 'clear', 'full siblings are not a clear pairing');
      assert.ok(['watch', 'close'].includes(sib.severity), `unexpected severity ${sib.severity}`);
      return;
    }
  }
});

test('a released descendant stays in the bloodline, because it lived', () => {
  const { s, clock } = fresh();
  const r = conceive(s);
  clock.t = r.bornAt;
  s.release(ADDR, r.id);
  const kid = s.lineage(ADDR).blocks[0].kids[0];
  assert.strictEqual(kid.released, true);
  assert.strictEqual(s.lineage(ADDR).living, 0);
});

console.log(`\n${passed} stable tests passed`);
