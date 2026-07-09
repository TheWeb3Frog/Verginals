// Rarity math: distribution counts, None handling, scores, competition ranking.
// Run: node test/rarity.test.js
const assert = require('assert');
const { computeRarity } = require('../src/rarity');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// 4-item toy collection:
//   #1 Body=Red,  Hat=Crown   (Crown is unique)
//   #2 Body=Red,  Hat=Cap
//   #3 Body=Red,  Hat=Cap
//   #4 Body=Blue              (no Hat at all)
const items = [
  { number: 1, name: 'One', attributes: [{ trait_type: 'Body', value: 'Red' }, { trait_type: 'Hat', value: 'Crown' }] },
  { number: 2, name: 'Two', attributes: [{ trait_type: 'Body', value: 'Red' }, { trait_type: 'Hat', value: 'Cap' }] },
  { number: 3, name: 'Three', attributes: [{ trait_type: 'Body', value: 'Red' }, { trait_type: 'Hat', value: 'Cap' }] },
  { number: 4, name: 'Four', attributes: [{ trait_type: 'Body', value: 'Blue' }] },
];
const r = computeRarity(items);

test('supply defaults to item count', () => {
  assert.strictEqual(r.supply, 4);
});

test('value counts and percentages are exact', () => {
  const body = r.traits.find((t) => t.trait_type === 'Body');
  const red = body.values.find((v) => v.value === 'Red');
  const blue = body.values.find((v) => v.value === 'Blue');
  assert.strictEqual(red.count, 3);
  assert.strictEqual(red.pct, 75);
  assert.strictEqual(blue.count, 1);
  assert.strictEqual(blue.pct, 25);
});

test('missing trait types count as None so distributions sum to supply', () => {
  const hat = r.traits.find((t) => t.trait_type === 'Hat');
  const none = hat.values.find((v) => v.value === 'None');
  assert.strictEqual(none.count, 1); // item 4
  const total = hat.values.reduce((s, v) => s + v.count, 0);
  assert.strictEqual(total, 4);
});

test('rarer traits produce higher scores', () => {
  // #1: Red(3) + Crown(1) -> 4/3 + 4 = 5.33 ; #4: Blue(1) + Hat None(1) -> 4 + 4 = 8
  const one = r.byNumber.get(1);
  const two = r.byNumber.get(2);
  const four = r.byNumber.get(4);
  assert.ok(four.score > one.score, 'unique Blue + unique no-Hat beats Crown');
  assert.ok(one.score > two.score, 'Crown beats Cap');
});

test('leaderboard is sorted by rank with number 4 rarest', () => {
  assert.strictEqual(r.leaderboard[0].number, 4);
  assert.strictEqual(r.leaderboard[0].rank, 1);
});

test('equal scores share a rank (competition ranking)', () => {
  const two = r.byNumber.get(2);
  const three = r.byNumber.get(3);
  assert.strictEqual(two.score, three.score);
  assert.strictEqual(two.rank, three.rank);
});

test('item traits carry their own count and pct', () => {
  const one = r.byNumber.get(1);
  const crown = one.traits.find((t) => t.trait_type === 'Hat');
  assert.strictEqual(crown.value, 'Crown');
  assert.strictEqual(crown.pct, 25);
});

console.log(`\n${passed} rarity tests passed`);
