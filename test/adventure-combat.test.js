// Adventure Mode combat: initiative, the triangle, the Flip, determinism.
// Run: node test/adventure-combat.test.js
const assert = require('assert');
const P = require('../src/adventure/pool');
const C = require('../src/adventure/combat');
const V = require('../src/adventure/vivarium');
const H = require('../src/adventure/hunt');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const R = (locus, name) => P.rankOf(locus, name);
function cat(over = {}, id = 'a') {
  const g = {
    Background: [0, 0], Body: [0, 0], Collar: [0, 0],
    Face: [R('Face', 'Perplexed Small'), R('Face', 'Perplexed Small')],
    Rune: [0, 0], House: [R('House', 'Fire'), R('House', 'Fire')],
  };
  for (const [k, v] of Object.entries(over)) g[k] = v;
  return C.createFighter({ id, name: id, genome: g, catnip: 1 });
}
const hom = (locus, name) => [R(locus, name), R(locus, name)];

console.log('initiative');

test('the Tuned collar acts first, and the rarest collar no longer wins by default', () => {
  // White is the rarest collar (195) and used to take initiative from every other cat for free.
  const white = cat({ Collar: hom('Collar', 'White') }, 'white');
  const red = cat({ Collar: hom('Collar', 'Red') }, 'red');
  assert.strictEqual(C.initiative(white, red, 's').why, 'coin', 'rarity alone decides nothing now');

  // Give Red a matching rune and it takes the turn, whatever the ranks say.
  const tunedRed = cat({ Collar: hom('Collar', 'Red'), Rune: hom('Rune', 'Fire Red') }, 'tuned');
  const i = C.initiative(tunedRed, white, 's');
  assert.strictEqual(i.why, 'tuned collar');
  assert.strictEqual(i.side, 0);
});

test('a Tuned collar pays for it: Mute carries +2 Armor instead', () => {
  const tuned = cat({ Collar: hom('Collar', 'Red'), Rune: hom('Rune', 'Fire Red') });
  const mute = cat({ Collar: hom('Collar', 'Black'), Rune: hom('Rune', 'Fire Red') });
  assert.strictEqual(mute.baseArmor - tuned.baseArmor, C.MUTE_ARMOR);
  assert.ok(C.runeCost({ f: [tuned, mute], arena: { fx: {} }, arenaOwner: 0 }, 0)
          < C.runeCost({ f: [mute, tuned], arena: { fx: {} }, arenaOwner: 0 }, 0));
});

test('the lighter cat breaks a tie, so Cow is slow and Tiger is fast', () => {
  const tiger = cat({ Body: hom('Body', 'Tiger') }, 'tiger');
  const heavy = cat({ Body: hom('Body', 'Tortie') }, 'tortie');
  assert.strictEqual(C.initiative(tiger, heavy, 's').why, 'lighter');
  assert.strictEqual(C.initiative(tiger, heavy, 's').side, 0);
});

test('Placid loses initiative to everything, and Wide awake beats a Tuned collar', () => {
  const cow = cat({ Body: hom('Body', 'Cow') }, 'cow');
  const plain = cat({}, 'plain');
  assert.strictEqual(C.initiative(cow, plain, 's').side, 1, 'Cow never acts first');

  const awake = cat({ Face: hom('Face', 'Shiny Eyes Happy') }, 'awake');
  const tuned = cat({ Collar: hom('Collar', 'Red'), Rune: hom('Rune', 'Fire Red') }, 'tuned');
  assert.strictEqual(C.initiative(awake, tuned, 's').why, 'wide awake');
});

test('whoever acts first imposes the arena', () => {
  const spectrum = cat({ Background: hom('Background', 'Spectrum'), Body: hom('Body', 'Tiger') }, 'spec');
  const other = cat({ Background: hom('Background', 'Zombie'), Body: hom('Body', 'Cow') }, 'other');
  const st = C.startFight({ a: spectrum, b: other, seed: 'x' });
  assert.strictEqual(st.arena.name, 'Spectrum');
  assert.strictEqual(st.arenaOwner, 0);
});

console.log('the triangle and the Flip');

test('Water beats Fire beats Earth beats Water', () => {
  const mk = (h) => cat({ House: hom('House', h) }, h);
  const st = (a, b) => ({ f: [a, b], arena: { fx: {} }, arenaOwner: 0, seed: 's' });
  assert.strictEqual(C.houseMultiplier(st(mk('Water'), mk('Fire')), 0), C.FAVOURABLE);
  assert.strictEqual(C.houseMultiplier(st(mk('Fire'), mk('Earth')), 0), C.FAVOURABLE);
  assert.strictEqual(C.houseMultiplier(st(mk('Earth'), mk('Water')), 0), C.FAVOURABLE);
  assert.strictEqual(C.houseMultiplier(st(mk('Fire'), mk('Water')), 0), C.UNFAVOURABLE);
  assert.strictEqual(C.houseMultiplier(st(mk('Fire'), mk('Fire')), 0), C.NEUTRAL);
});

test('a founder cannot Flip, and the button says so', () => {
  const founder = cat({}, 'founder');
  assert.strictEqual(founder.canFlip, false);
  const st = C.startFight({ a: founder, b: cat({}, 'b'), seed: 's' });
  C.act(st, 'FLIP');
  assert.ok(st.log.some((e) => e.type === 'flipLocked'));
});

test('a hybrid Flips to its Second Form, House and all', () => {
  const hybrid = C.createFighter({
    id: 'h', name: 'h', catnip: 1,
    genome: {
      Background: [0, 0], Body: [0, 0], Collar: [0, 0],
      Face: [R('Face', 'Perplexed Small'), R('Face', 'Perplexed Small')],
      Rune: [0, 0],
      House: [R('House', 'Fire'), R('House', 'Water')],
    },
  });
  assert.strictEqual(hybrid.canFlip, true);
  const before = hybrid.house;
  const st = C.startFight({ a: hybrid, b: cat({}, 'b'), seed: 's' });
  st.toAct = 0;
  C.act(st, 'FLIP');
  assert.ok(st.log.some((e) => e.type === 'flip'), 'the flip happened');
  assert.notStrictEqual(hybrid.house, before, 'a new House came out of it');
  assert.strictEqual(hybrid.catnip, 0, 'and it cost the catnip');
});

test('the Flip is once per fight and needs catnip', () => {
  const h = C.createFighter({
    id: 'h', name: 'h', catnip: 0,
    genome: { Background: [0, 0], Body: [0, 0], Collar: [0, 0],
              Face: [R('Face', 'Perplexed Small'), R('Face', 'Perplexed Small')],
              Rune: [0, 0], House: [R('House', 'Fire'), R('House', 'Water')] },
  });
  const st = C.startFight({ a: h, b: cat({}, 'b'), seed: 's' });
  st.toAct = 0;
  C.act(st, 'FLIP');
  assert.ok(st.log.some((e) => e.type === 'flipNoCatnip'));
});

console.log('rules, not numbers');

test('Cool ignores the arena, which is what makes it more than a bigger Cooler', () => {
  const cool = cat({ Face: hom('Face', 'Cool'), Background: hom('Background', 'Zombie') }, 'cool');
  const st = { f: [cool, cat({}, 'b')], arena: { fx: { noDeathBefore: 3 } }, arenaOwner: 1, seed: 's', turn: 1, log: [] };
  assert.strictEqual(C.activeFace(st, 0).fx.arenaImmune, true);
});

test('Spectrum takes the loser of initiative out of their own Face', () => {
  const spec = cat({ Background: hom('Background', 'Spectrum'), Body: hom('Body', 'Tiger') }, 'spec');
  const other = cat({ Face: hom('Face', 'Rainbow'), Body: hom('Body', 'Cow') }, 'other');
  const st = C.startFight({ a: spec, b: other, seed: 'x' });
  assert.strictEqual(st.arena.name, 'Spectrum');
  assert.notStrictEqual(C.activeFace(st, 1).name, 'Rainbow', 'the grail face is switched off');
  assert.strictEqual(C.houseMultiplier(st, 1) === C.FAVOURABLE, false, 'and so is Prism');
});

test('sessalG D3 swaps the Faces, both ways', () => {
  const mirror = cat({ Face: hom('Face', 'sessalG D3') }, 'mirror');
  const grail = cat({ Face: hom('Face', 'Rainbow') }, 'grail');
  const st = C.startFight({ a: mirror, b: grail, seed: 'x' });
  assert.strictEqual(C.activeFace(st, 0).name, 'Rainbow', 'the junk common wears the grail');
  assert.strictEqual(C.activeFace(st, 1).name, 'sessalG D3');
});

test('the Glasses tribe returns information and no damage at all', () => {
  const seer = cat({ Face: hom('Face', 'Rainbow Glasses') }, 'seer');
  const st = C.startFight({ a: seer, b: cat({}, 'b'), seed: 'x' });
  assert.strictEqual(C.visionOf(st, 0), 'genome');
  assert.strictEqual(C.visionOf(st, 1), 'none');
  const f = require('../src/adventure/faces').faceNamed('Rainbow Glasses');
  assert.strictEqual(f.fx.damageBonus, undefined);
});

console.log('determinism');

test('the same fight replays to the same log, every time', () => {
  const run = () => {
    const a = cat({ Body: hom('Body', 'Tiger'), House: hom('House', 'Water') }, 'a');
    const b = cat({ Body: hom('Body', 'Cow'), House: hom('House', 'Fire') }, 'b');
    const st = C.startFight({ a, b, seed: 'replay-me' });
    const script = ['CLAW', 'CLAW', 'RUNE', 'CLAW', 'CLAW', 'CLAW', 'CLAW', 'CLAW', 'RUNE', 'CLAW', 'CLAW', 'CLAW'];
    for (const m of script) { if (st.over) break; C.act(st, m); }
    return JSON.stringify(st.log);
  };
  assert.strictEqual(run(), run());
});

test('a fight ends, and in a sane number of turns', () => {
  let total = 0, fights = 0, stalls = 0;
  for (let i = 0; i < 200; i++) {
    const a = H.generateWild('bench', i * 2);
    const b = H.generateWild('bench', i * 2 + 1);
    const st = C.startFight({ a, b, seed: 'f' + i });
    let n = 0;
    while (!st.over && n < 100) { C.act(st, 'CLAW'); n++; }
    assert.ok(st.over, 'fight ' + i + ' never ended');
    if (st.timedOut) stalls++;
    total += st.turn; fights++;
  }
  const mean = total / fights;
  assert.ok(mean >= 3 && mean <= 12, 'mean fight length ' + mean.toFixed(1) + ' turns');
  assert.ok(stalls / fights < 0.10, (100 * stalls / fights).toFixed(1) + '% of fights hit the horizon');
  console.log('     (mean ' + mean.toFixed(1) + ' turns, ' + stalls + '/' + fights + ' reached the horizon)');
});

console.log('the wild pool');

test('wild Alphas draw at collection frequency and are never biased', () => {
  let rainbow = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const w = H.generateWild('pool', i);
    if (w.genome.Face.includes(P.rankOf('Face', 'Rainbow'))) rainbow++;
  }
  const seen = rainbow / N;
  const expected = 2 * (9 / 3333);
  assert.ok(seen < expected * 3, `Rainbow showed up at ${(seen * 100).toFixed(2)}%, expected about ${(expected * 100).toFixed(2)}%`);
});

test('a wild Alpha is always a hybrid, so the Flip is always on display', () => {
  for (let i = 0; i < 200; i++) assert.strictEqual(H.generateWild('h', i).canFlip, true);
});

test('the player chooses which locus a Strand samples', () => {
  const h = H.generateHunt('s', {});
  const w = H.generateWild('s', 3);
  const strand = H.takeStrand(h, w, 'Face');
  assert.strictEqual(strand.locus, 'Face');
  assert.ok(w.genome.Face.includes(strand.rank), 'it came off that wild');
  assert.deepStrictEqual(H.takeStrand(h, w, 'Whiskers'), { error: 'not a locus' });
});

console.log('the vivarium');

test('a five day absence resolves the same whenever you come back', () => {
  const mk = () => {
    const v = V.createVivarium('det');
    for (let i = 0; i < 12; i++) V.plant(v, 'Clover', 0);
    for (let i = 0; i < 12; i++) V.addNubbin(v, 0);
    for (let i = 0; i < 6; i++) V.addGlim(v, 0);
    V.pour(v, 40, 0);
    return v;
  };
  const a = mk(); V.resolve(a, 5 * 24 * 60);
  const b = mk(); V.resolve(b, 2 * 24 * 60); V.resolve(b, 4 * 24 * 60); V.resolve(b, 5 * 24 * 60);
  assert.deepStrictEqual(V.snapshot(a), V.snapshot(b));
});

test('bedrock: a month of neglect leaves something to restart from', () => {
  const v = V.createVivarium('gone');
  for (let i = 0; i < 12; i++) V.plant(v, 'Clover', 0);
  for (let i = 0; i < 12; i++) V.addNubbin(v, 0);
  V.pour(v, 40, 0);
  V.resolve(v, 30 * 24 * 60);
  const s = V.snapshot(v);
  assert.ok(s.nubbins > 0, 'the last Nubbins go torpid rather than die');
  assert.ok(Object.keys(v.seedBank).length > 0, 'seeds wait in the substrate');
  assert.strictEqual(s.freeTiles, v.tiles, 'and a dead plant releases its tile');
});

test('pouring too much at once floods, and that has a cost', () => {
  const v = V.createVivarium('flood');
  for (let i = 0; i < 4; i++) V.plant(v, 'Clover', 0);
  const events = V.pour(v, V.FLOOD_THRESHOLD + 1, 0);
  assert.ok(events.some((e) => e.type === 'flood'));
  assert.ok(events.some((e) => e.type === 'washedOut'), 'unrooted seeds are lost');
});

test('the Nubbins outrun the plants, which is what makes the Alphas the regulator', () => {
  const v = V.createVivarium('growth');
  for (let i = 0; i < 12; i++) V.plant(v, 'Clover', 0);
  for (let i = 0; i < 12; i++) V.addNubbin(v, 0);
  V.pour(v, 40, 0); V.pour(v, 40, 1);          // two flasks: over the lip, under the flood line
  V.resolve(v, 12 * 60);
  assert.ok(V.snapshot(v).nubbins > 12, 'a fed population doubles in twelve hours');
});

test('one flask damps the substrate even though it does not reach the lip', () => {
  // The trap this rule was split to remove: pouring less than the overflow used to do nothing at
  // all, so a careful player watched their plants wilt with a full basin.
  const v = V.createVivarium('damp');
  for (let i = 0; i < 4; i++) V.plant(v, 'Clover', 0);
  const before = v.humidity;
  const events = V.pour(v, 20, 0);
  assert.ok(v.humidity > before, 'watering damps');
  assert.ok(!events.some((e) => e.type === 'irrigation'), 'but it does not wash the droppings');
});

console.log(`\n${passed} checks passed`);
