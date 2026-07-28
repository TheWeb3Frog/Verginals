// Inscription pricing: the money path. Tests src/pricing.js directly (real code, not a mirror).
// Run: node test/pricing.test.js
const assert = require('assert');
const {
  feeForBytes, suggestRevealFeeXVG, suggestSplitFeeXVG,
  DUST_UNITS, CARRIER_TARGET_UNITS, priceInscription,
} = require('../src/pricing');

const COIN = 1e6;
const FLAT_PER_INPUT = 0.3 * COIN; // the configured rate, and the ceiling
const price = (n, parented = true) => priceInscription({ numInputs: n, parented, maxPerInput: FLAT_PER_INPUT });
// What the previous flat-rate model charged, for comparison.
const oldTotal = (n) => FLAT_PER_INPUT * n + Math.round(suggestSplitFeeXVG(n) * COIN);

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const ALL = Array.from({ length: 30 }, (_, i) => i + 1);

test('the fee rate never goes below the node relay floor of 0.2 XVG/kB', () => {
  assert.strictEqual(feeForBytes(1), 0.2);
  assert.strictEqual(feeForBytes(1000), 0.2);
  assert.strictEqual(feeForBytes(1001), 0.4);
});

test('parent bytes are billed inside the same rounding, not as a second kB', () => {
  // 3 inputs: 1800 B of reveal + 184 B of parent stays inside 2 kB
  assert.strictEqual(suggestRevealFeeXVG(3, true), feeForBytes(1984));
  // the old shape charged an extra 0.2 XVG here
  assert.ok(suggestRevealFeeXVG(3, true) < feeForBytes(1800) + feeForBytes(184));
});

test('the carrier always clears dust, for every plan size', () => {
  for (const n of ALL) assert.ok(price(n).carrier >= DUST_UNITS, 'dust at n=' + n);
});

test('the carrier is never left below the target when the ceiling allows it', () => {
  for (const n of ALL) {
    const p = price(n);
    if (p.perInput < FLAT_PER_INPUT) assert.ok(p.carrier >= CARRIER_TARGET_UNITS, 'thin carrier at n=' + n);
  }
});

test('pricing never charges more than the old flat model (ceiling is respected)', () => {
  for (const n of ALL) assert.ok(price(n).total <= oldTotal(n), 'price rose at n=' + n);
});

test('the accounting identity holds: total - carrier = the fees actually spent', () => {
  for (const n of ALL) {
    const p = price(n);
    assert.strictEqual(p.total - p.carrier, p.splitFee + p.serviceFee + p.revealFee, 'identity broke at n=' + n);
    assert.strictEqual(p.total, p.commitTotal + p.splitFee + p.serviceFee);
    assert.strictEqual(p.carrier, p.commitTotal - p.revealFee);
  }
});

test('heavy items save the most (a 20-input plan roughly halves)', () => {
  const p = price(20);
  assert.ok(p.total <= oldTotal(20) * 0.55, 'expected ~50% off, got ' + (p.total / oldTotal(20)));
  assert.ok(p.total / COIN < 3.5);
});

test('a 3-input plan still costs about 0.9 XVG', () => {
  assert.ok(Math.abs(price(3).total / COIN - 0.9) < 0.001);
});

test('the commit always covers the reveal fee it has to pay', () => {
  for (const n of ALL) assert.ok(price(n).commitTotal > price(n).revealFee, 'commit too small at n=' + n);
});

test('an unparented plan is never dearer than the parented one', () => {
  for (const n of ALL) assert.ok(price(n, false).total <= price(n, true).total);
});

test('a service fee is added on top and does not eat the carrier', () => {
  const withFee = priceInscription({ numInputs: 5, parented: true, maxPerInput: FLAT_PER_INPUT, serviceFee: 50000 });
  const without = price(5);
  assert.strictEqual(withFee.total, without.total + 50000);
  assert.strictEqual(withFee.carrier, without.carrier);
});

test('a nonsense input count is rejected rather than priced', () => {
  assert.throws(() => priceInscription({ numInputs: 0, maxPerInput: FLAT_PER_INPUT }));
  assert.throws(() => priceInscription({ numInputs: 2.5, maxPerInput: FLAT_PER_INPUT }));
});

test('every figure is a whole number of atomic units', () => {
  for (const n of ALL) {
    for (const [k, v] of Object.entries(price(n))) assert.ok(Number.isInteger(v), k + ' not integer at n=' + n);
  }
});

console.log('\npricing: ' + passed + ' passed');
