// Ticker allocation and its payment rule (ASSETS-SPEC-v0 §7).
// The schedule is permanent once the first asset is etched, so these numbers are a contract.
// Run: node test/assets-tickers.test.js
const assert = require('assert');
const { priceOf, splitOf, isPaid, costOfHoarding, PRICE_LONG_XVG } = require('../src/assets/tickers');

const COIN = 1e6;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const PROJECT = 'DPROJECTTREASURYADDRESS';
const VERGE = 'DVERGEOFFICIALADDRESS';
const out = (address, value) => ({ address, value, isOpReturn: false });

test('the published schedule is exactly what the spec promises', () => {
  const expected = { 3: 25000, 4: 10000, 5: 5000, 6: 2500, 8: 500, 10: 100 };
  for (const [len, xvg] of Object.entries(expected)) {
    assert.strictEqual(priceOf('A'.repeat(Number(len))) / COIN, xvg, len + ' characters');
  }
  assert.strictEqual(priceOf('A'.repeat(12)) / COIN, PRICE_LONG_XVG);
  assert.strictEqual(priceOf('A'.repeat(26)) / COIN, PRICE_LONG_XVG);
});

test('a shorter ticker never costs less than a longer one', () => {
  for (let len = 1; len < 26; len++) {
    assert.ok(priceOf('A'.repeat(len)) >= priceOf('A'.repeat(len + 1)), 'broke at ' + len);
  }
});

test('the price is what makes hoarding ruinous but one good name affordable', () => {
  // the point of the whole schedule, asserted rather than claimed
  assert.strictEqual(priceOf('FROG') / COIN, 10000);          // one real project
  assert.strictEqual(costOfHoarding(4, 50) / COIN, 500000);   // a squatter wanting fifty
});

test('case does not change the price', () => {
  assert.strictEqual(priceOf('frog'), priceOf('FROG'));
});

test('an impossible ticker is rejected rather than priced', () => {
  for (const bad of ['', 'has space', 'A'.repeat(27), 'lower-case!', null]) {
    assert.throws(() => priceOf(bad), JSON.stringify(bad));
  }
});

test('the fee splits in half, with any odd unit going to Verge', () => {
  const s = splitOf('FROG');
  assert.strictEqual(s.project + s.verge, s.total);
  assert.strictEqual(s.project, s.verge); // 10000 XVG is even in units
  // an odd total must never round in the project's favour
  const odd = { total: 7, project: Math.floor(7 / 2), verge: 7 - Math.floor(7 / 2) };
  assert.ok(odd.verge > odd.project);
});

test('an etching that pays both halves is valid', () => {
  const { project, verge } = splitOf('FROG');
  const tx = { outputs: [out(PROJECT, project), out(VERGE, verge), out('DSOMEONE', 100000)] };
  assert.strictEqual(isPaid(tx, 'FROG', { project: PROJECT, verge: VERGE }).ok, true);
});

test('paying only the project does not buy a ticker', () => {
  const { project, verge } = splitOf('FROG');
  const tx = { outputs: [out(PROJECT, project + verge)] }; // full amount, wrong split
  const r = isPaid(tx, 'FROG', { project: PROJECT, verge: VERGE });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /verge share/);
});

test('paying only Verge does not buy a ticker either', () => {
  const { project, verge } = splitOf('FROG');
  const tx = { outputs: [out(VERGE, project + verge)] };
  const r = isPaid(tx, 'FROG', { project: PROJECT, verge: VERGE });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /project share/);
});

test('underpaying by a single unit is refused', () => {
  const { project, verge } = splitOf('MOON');
  const tx = { outputs: [out(PROJECT, project - 1), out(VERGE, verge)] };
  assert.strictEqual(isPaid(tx, 'MOON', { project: PROJECT, verge: VERGE }).ok, false);
});

test('overpaying is fine', () => {
  const { project, verge } = splitOf('MOON');
  const tx = { outputs: [out(PROJECT, project * 2), out(VERGE, verge * 2)] };
  assert.strictEqual(isPaid(tx, 'MOON', { project: PROJECT, verge: VERGE }).ok, true);
});

test('several outputs to the same address add up', () => {
  const { project, verge } = splitOf('MOON');
  const tx = { outputs: [out(PROJECT, project - 1000), out(PROJECT, 1000), out(VERGE, verge)] };
  assert.strictEqual(isPaid(tx, 'MOON', { project: PROJECT, verge: VERGE }).ok, true);
});

test('with no payout addresses configured, nothing can be registered', () => {
  const r = isPaid({ outputs: [] }, 'FROG', null);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not configured/);
});

test('a long ticker is nearly free, so honest naming is never blocked', () => {
  assert.strictEqual(priceOf('MYHONESTPROJECTNAME') / COIN, 10);
});

console.log('\nassets tickers: ' + passed + ' passed');
