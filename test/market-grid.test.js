// What the market grid decides to show, and in what order.
//
// The old market drew the listings and nothing else. Twelve cards is not a marketplace: a visitor
// could read twelve prices and had no way to see what they were buying into, and a trait rail over
// twelve items would have been theatre. So the grid is the whole collection now, and that makes
// two rules load-bearing:
//
//   Something buyable comes before something that is not, whatever the sort says. Get that wrong
//   and 1,366 unlisted cats bury the twelve that are actually for sale, on the page whose entire
//   job is selling them.
//
//   A filter has to narrow honestly. A trait filter that ORs across groups instead of ANDing
//   returns more items the more you filter, which reads as a broken page.
//
// These run the SHIPPED functions, lifted out of web/app.js, rather than a copy of them here: a
// mirrored rule drifts from the real one and then passes while the site is wrong.
//
// Run: node test/market-grid.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const lift = (name) => {
  const m = new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n').exec(app);
  if (!m) throw new Error('cannot find ' + name + ' in web/app.js');
  return m[0];
};
const make = () => {
  const mkt = { sort: 'price-asc', q: '', forSale: false, picked: new Map(), rows: [] };
  const fns = new Function('mkt', lift('mktKeep') + lift('mktRows') + '\nreturn { mktKeep, mktRows };')(mkt);
  return { mkt, ...fns };
};

test('the harness really lifted both functions, so an empty check is not a pass', () => {
  assert.ok(lift('mktKeep').length > 200);
  assert.ok(lift('mktRows').length > 200);
  const { mktRows } = make();
  assert.strictEqual(typeof mktRows, 'function');
});

// --- fixtures: two listed cats and three that are not ------------------------------------------

const row = (n, over) => Object.assign(
  { n, rank: n, price: null, at: 0, traits: [{ trait_type: 'Background', value: 'Red' }] }, over);
const FIXED = [
  row(1, { price: 9000, at: 300, rank: 900 }),
  row(2, { rank: 40 }),
  row(3, { price: 1000, at: 100, rank: 700 }),
  row(4, { rank: 20, traits: [{ trait_type: 'Background', value: 'Blue' }, { trait_type: 'Face', value: 'Lazer' }] }),
  row(5, { rank: null }),
];
const load = (over) => {
  const m = make();
  m.mkt.rows = FIXED;
  Object.assign(m.mkt, over);
  return m;
};

// --- ordering ------------------------------------------------------------------------------------

test('FLOOR FIRST PUTS THE CHEAPEST LISTING FIRST AND EVERY UNLISTED CAT AFTER THE LISTED ONES', () => {
  const { mktRows } = load({ sort: 'price-asc' });
  const out = mktRows().map((r) => r.n);
  assert.deepStrictEqual(out.slice(0, 2), [3, 1], 'the two listings, cheapest first');
  assert.deepStrictEqual(out.slice(2), [2, 4, 5], 'then the rest, by number');
});

test('priciest first still keeps the unlisted ones out of the way', () => {
  const out = load({ sort: 'price-desc' }).mktRows().map((r) => r.n);
  assert.deepStrictEqual(out.slice(0, 2), [1, 3]);
  assert.ok(out.slice(2).every((n) => [2, 4, 5].includes(n)));
});

test('just listed reads the listing time, newest first', () => {
  const out = load({ sort: 'new' }).mktRows().map((r) => r.n);
  assert.deepStrictEqual(out.slice(0, 2), [1, 3], 'listed at 300 before listed at 100');
});

test('rarest first is about rarity ALONE, and an unranked item sorts last', () => {
  // The one sort where price must not interfere: somebody sorting by rank is hunting, not shopping.
  const out = load({ sort: 'rank' }).mktRows().map((r) => r.n);
  assert.deepStrictEqual(out, [4, 2, 3, 1, 5]);
});

test('by number is the plain order, listed or not', () => {
  assert.deepStrictEqual(load({ sort: 'number' }).mktRows().map((r) => r.n), [1, 2, 3, 4, 5]);
});

test('CONTROL: a comparator blind to listed/unlisted fails the floor-first check', () => {
  // Proves the assertion above bites. Sorting on price alone leaves an unlisted cat at the front,
  // because "no price" is not a small price.
  const wrong = [...FIXED].sort((a, b) => (a.price || 0) - (b.price || 0)).map((r) => r.n);
  assert.notDeepStrictEqual(wrong.slice(0, 2), [3, 1]);
  assert.strictEqual(wrong[0], 2, 'an unlisted one leads, which is the bug being guarded against');
});

// --- filtering ------------------------------------------------------------------------------------

test('for sale keeps only what somebody can actually buy', () => {
  const out = load({ forSale: true }).mktRows().map((r) => r.n);
  assert.deepStrictEqual(out, [3, 1]);
});

test('TRAITS ARE OR INSIDE A GROUP AND AND ACROSS GROUPS', () => {
  const both = new Map([['Background', new Set(['Red', 'Blue'])]]);
  assert.deepStrictEqual(load({ picked: both }).mktRows().map((r) => r.n), [3, 1, 2, 4, 5],
    'either colour matches');

  const across = new Map([['Background', new Set(['Blue'])], ['Face', new Set(['Lazer'])]]);
  assert.deepStrictEqual(load({ picked: across }).mktRows().map((r) => r.n), [4],
    'both groups have to match, not either');

  const impossible = new Map([['Background', new Set(['Red'])], ['Face', new Set(['Lazer'])]]);
  assert.deepStrictEqual(load({ picked: impossible }).mktRows().map((r) => r.n), [],
    'a contradiction returns nothing rather than everything');
});

test('CONTROL: ORing across groups would widen the result instead of narrowing it', () => {
  const across = new Map([['Background', new Set(['Blue'])], ['Face', new Set(['Lazer'])]]);
  const anded = load({ picked: across }).mktRows().length;
  const ored = FIXED.filter((r) => r.traits.some((t) =>
    (t.trait_type === 'Background' && t.value === 'Blue') || (t.trait_type === 'Face' && t.value === 'Lazer'))).length;
  assert.ok(ored >= anded);
  assert.notStrictEqual(ored, 0);
});

test('the search box reads a number, a rank or a trait, and ignores case', () => {
  assert.deepStrictEqual(load({ q: '4' }).mktRows().map((r) => r.n), [4],
    'a number match (the ranks above avoid single digits so this cannot pass as a rank hit)');
  assert.deepStrictEqual(load({ q: '900' }).mktRows().map((r) => r.n), [1],
    'a rank match, which is not any item number here');
  assert.deepStrictEqual(load({ q: 'blue' }).mktRows().map((r) => r.n), [4],
    'a trait value, lowercased');
  assert.deepStrictEqual(load({ q: 'LAZER' }).mktRows().map((r) => r.n), [4],
    'and uppercased');
});

test('a search and a trait filter stack rather than replacing each other', () => {
  const picked = new Map([['Background', new Set(['Red'])]]);
  assert.deepStrictEqual(load({ picked, q: '3' }).mktRows().map((r) => r.n), [3]);
  assert.deepStrictEqual(load({ picked, q: '4' }).mktRows().map((r) => r.n), [],
    '#4 is Blue, so the trait filter still excludes it');
});

test('nothing matching returns an empty list rather than everything', () => {
  assert.deepStrictEqual(load({ q: 'nosuchtrait' }).mktRows().map((r) => r.n), []);
});

// --- the grid is the collection, not the order book -----------------------------------------------

test('THE GRID IS BUILT FROM THE COLLECTION, NOT ONLY FROM THE LISTINGS', () => {
  // The bug this whole rebuild exists to fix. If mkt.rows is ever fed from listResp again, the page
  // goes back to being twelve cards.
  const fn = /async function loadMarket\(force\) \{[\s\S]*?\n\}\n/.exec(app);
  assert.ok(fn, 'loadMarket should exist');
  assert.match(fn[0], /mkt\.rows = [\s\S]*?mkt\.items\.map\(/,
    'the rows come from the collection items');
  assert.match(fn[0], /api\('\/api\/collection\/items'\)/);
  assert.match(fn[0], /mkt\.loose/, 'and a listing that is not an Alpha still gets a card');
});

console.log('\n' + passed + ' market grid tests passed');
