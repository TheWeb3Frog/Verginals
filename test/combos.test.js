// Combo bonuses: color-match levels, tone folding, bicolor bodies, double rainbow, perfect pair.
// Run: node test/combos.test.js
const assert = require('assert');
const { comboBonus, POINTS } = require('../src/combos');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }
const item = (a) => ({ number: 1, attributes: Object.entries(a).map(([trait_type, value]) => ({ trait_type, value })) });

test('an all-neutral black-and-white piece is Monochrome, not Chromatic (like #1211)', () => {
  const b = comboBonus(item({ Background: 'Black', Body: 'Dark Grey', Collar: 'Black', Rune: 'Birch White', Face: 'Big Laughing' }));
  assert.deepStrictEqual(b.badges, ['Monochrome']);
  assert.strictEqual(b.points, POINTS.monochrome);
});

test('grey + white across four slots reads as Monochrome (like #2515)', () => {
  const b = comboBonus(item({ Background: 'Night Sky', Body: 'Burmilla', Collar: 'Black', Rune: 'Ride White', Face: 'Grumpier' }));
  assert.deepStrictEqual(b.badges, ['Monochrome']);
});

test('two vivid colors coordinated at once is Duotone (like #2931: blue x3 + red x2)', () => {
  const b = comboBonus(item({ Background: 'Sky Blue', Body: 'Blue', Collar: 'Dark Grey', Rune: 'Ride Red', Face: '3D Glasses' }));
  assert.deepStrictEqual(b.badges, ['Duotone Blue/Red']);
  assert.strictEqual(b.points, POINTS.duotone);
});

test('Collar + Body + Rune sharing a color adds a Tailored bonus on top', () => {
  const b = comboBonus(item({ Background: 'Blue', Body: 'Red', Collar: 'Red', Rune: 'Fire Red', Face: 'Happy' }));
  assert.ok(b.badges.includes('Chromatic Red'));
  assert.ok(b.badges.includes('Tailored'));
  assert.strictEqual(b.points, POINTS[3] + POINTS.tailored);
});

test('a 2-match earns points but no badge (too common to badge)', () => {
  const b = comboBonus(item({ Background: 'Red', Collar: 'Red', Body: 'Blue', Rune: 'Birch White', Face: 'Happy' }));
  assert.strictEqual(b.points, POINTS[2]);
  assert.deepStrictEqual(b.badges, []);
});

test('a bicolor body counts toward either of its colors (Harlequin Lava = red + orange)', () => {
  // lava(red,orange) + red bg + red collar -> red x3
  const red = comboBonus(item({ Background: 'Red', Body: 'Harlequin Lava', Collar: 'Red', Rune: 'Birch White', Face: 'Happy' }));
  assert.deepStrictEqual(red.badges, ['Chromatic Red']);
  // same body completing an orange match instead (4 orange slots -> Prismatic, +Tailored set)
  const orange = comboBonus(item({ Background: 'Bitcoin Orange', Body: 'Harlequin Lava', Collar: 'Bitcoin Orange', Rune: 'Fire Bitcoin Orange', Face: 'Happy' }));
  assert.ok(orange.badges.includes('Prismatic Orange'));
  assert.ok(orange.points >= POINTS[4]);
});

test('double rainbow = Rainbow-ish face + Spectrum background (+80)', () => {
  const b = comboBonus(item({ Background: 'Spectrum', Body: 'Grey', Collar: 'Blue', Rune: 'Birch White', Face: 'Old TV' }));
  assert.ok(b.badges.includes('Double Rainbow'));
  assert.ok(b.points >= POINTS.doubleRainbow);
});

test('perfect pair: Pink Sky + Harlequin Pink (+25) and nothing else pairs it', () => {
  const yes = comboBonus(item({ Background: 'Pink Sky', Body: 'Harlequin Pink', Collar: 'Blue', Rune: 'Birch White', Face: 'Happy' }));
  assert.ok(yes.badges.includes('Perfect Pair'));
  const no = comboBonus(item({ Background: 'Pink Sky', Body: 'Grey', Collar: 'Blue', Rune: 'Birch White', Face: 'Happy' }));
  assert.ok(!no.badges.includes('Perfect Pair'));
});

test('ears are ignored (no color contribution)', () => {
  const withEars = comboBonus(item({ Background: 'Pink', Ears: 'Pink', Body: 'Grey', Collar: 'Blue', Rune: 'Birch White', Face: 'Happy' }));
  // only Background pink -> level 1 -> no points (ears pink must NOT create a pink pair)
  assert.strictEqual(withEars.points, 0);
});

test('no color coherence yields no bonus', () => {
  const b = comboBonus(item({ Background: 'Blocks', Body: 'Brown', Collar: 'Blue', Rune: 'Birch White', Face: 'Happy' }));
  assert.strictEqual(b.points, 0);
  assert.deepStrictEqual(b.badges, []);
});

console.log(`\ncombos: ${passed} passed`);
