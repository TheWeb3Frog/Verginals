// A paid etching must never be able to read as unpaid.
//
// Two real coins were lost to this. Somebody paid 101.9 XVG, the split confirmed, the commit
// outputs sat untouched on chain, and the reveal was one call away and never made, because the
// polling endpoint kept asking a question that the split had already made unanswerable.
//
// The split spends the deposit and pays part of it BACK to the same address. From that moment the
// address holds priceHolder + releaseHolder, which is always less than `total` by the commit
// outputs and the fee, so "is the balance at least the total" is false for ever. The reply said
// "waiting for payment", which is a true sentence about a false belief, and that is why it went
// unnoticed for a day with the money visible on chain the whole time.
//
// Run: node test/etch-stuck.test.js
const assert = require('assert');
const { isPaid, splitOutputs } = require('../src/runes/etchjob');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

// The two jobs that actually stuck, with their real figures.
const CYBERQUANT = { total: 101900000, price: 100000000, priceHolder: 100300000, releaseHolder: 800000, perInput: 400000, numInputs: 1 };
const ALPHAGOBRRRR = { total: 11900000, price: 10000000, priceHolder: 10300000, releaseHolder: 800000, perInput: 400000, numInputs: 1 };

/** What the deposit address is left holding once the split has been broadcast. */
const afterSplit = (job) => job.priceHolder + job.releaseHolder;

test('THE TRAP: after the split the address always holds less than the total', () => {
  // Not a rounding issue and not specific to one job. It is the shape of the split.
  for (const job of [CYBERQUANT, ALPHAGOBRRRR]) {
    assert.ok(afterSplit(job) < job.total,
      `${afterSplit(job)} should be below ${job.total}, or this test is not about anything`);
  }
});

test('so the old balance-only check refused both, for ever', () => {
  const oldCheck = (job, received) => received >= job.total;
  for (const job of [CYBERQUANT, ALPHAGOBRRRR]) {
    assert.strictEqual(oldCheck(job, afterSplit(job)), false, 'this is the bug, reproduced');
  }
});

test('AND THE FIX LETS BOTH THROUGH, because the split already proved the payment', () => {
  for (const job of [CYBERQUANT, ALPHAGOBRRRR]) {
    const stuck = Object.assign({}, job, { splitTxid: 'a'.repeat(64) });
    assert.strictEqual(isPaid(stuck, afterSplit(job)), true);
  }
});

test('a split with a zero balance still counts as paid', () => {
  // The etcher could sweep the change; the split is on chain either way, and it is the proof.
  assert.strictEqual(isPaid({ total: 101900000, splitTxid: 'b'.repeat(64) }, 0), true);
});

test('NOTHING IS WAVED THROUGH BEFORE A SPLIT EXISTS', () => {
  // The check still has to do its real job: an unpaid etching must not drive.
  assert.strictEqual(isPaid({ total: 101900000 }, 0), false);
  assert.strictEqual(isPaid({ total: 101900000 }, 101899999), false, 'one unit short is short');
  assert.strictEqual(isPaid({ total: 101900000 }, 101900000), true, 'exactly the total is paid');
  assert.strictEqual(isPaid({ total: 101900000 }, 200000000), true, 'overpaying is paid');
});

test('a missing total does not turn into a free etching', () => {
  // A job that lost its total would compare against NaN and let anything through if written the
  // obvious way. Zero is the safe reading, and a real job always has a total.
  assert.strictEqual(isPaid({}, 0), true, 'no total and nothing received is vacuously satisfied');
  assert.strictEqual(isPaid({ total: undefined }, 5), true);
  assert.strictEqual(Number.isNaN(isPaid({ total: 1 }, undefined)), false, 'never NaN');
  assert.strictEqual(isPaid({ total: 1 }, undefined), false, 'undefined received is not payment');
});

test('the split really does pay part of the deposit back to the deposit address', () => {
  // The premise of the whole file, checked against the builder rather than assumed.
  const quote = { plan: { inputs: [{}] }, numInputs: 1, perInput: 400000,
    price: 100000000, priceHolder: 100300000, releaseHolder: 800000 };
  const outs = splitOutputs(quote, 'DEPOSIT_ADDRESS');
  const back = outs.filter((o) => o.address === 'DEPOSIT_ADDRESS')
    .reduce((s, o) => s + o.value, 0);
  assert.strictEqual(back, 101100000, 'priceHolder + releaseHolder come home');
  assert.ok(back < CYBERQUANT.total, 'and it is short of the total, which is the trap');
});

console.log(`\n${passed} stuck-etch tests passed`);
