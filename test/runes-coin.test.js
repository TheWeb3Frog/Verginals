// One coin's page data. Two numbers on it are easy to misread and both have a test here.
// Run: node test/runes-coin.test.js
const assert = require('assert');
const codec = require('../src/runes/codec');
const { RuneState, applyTx, runeRefOf, outpoint } = require('../src/runes/indexer');
const { coin, distribution } = require('../src/runes/coin');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };
const A = codec.ACTIVATION_HEIGHT;
const DUST = 100000;
const out = (v = DUST) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });

function etched({ ticker = 'TEST', supply = 1000, premine = 0, div = 0, terms = null } = {}) {
  const s = new RuneState();
  const paid = lockFor(ticker);
  applyTx(s, {
    txid: 'e', height: A, txIndex: 1, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: { ticker, supply, premine, divisibility: div, lock: paid.lock, terms },
  });
  s.height = A;
  return s;
}

test('a coin nobody etched is null, not an empty shell', () => {
  assert.strictEqual(coin(new RuneState(), runeRefOf(A, 1), A), null);
});

test('the identity comes off the reference, not off a stored copy', () => {
  const c = coin(etched({ ticker: 'IDENT' }), runeRefOf(A, 1), A);
  assert.strictEqual(c.ticker, 'IDENT');
  assert.strictEqual(c.etchedAtHeight, A);
  assert.strictEqual(c.etchedAtIndex, 1);
});

test('MINT PROGRESS IS AGAINST THE OPEN SUPPLY, never the whole one', () => {
  // A creator keeping half and half the rest minted is HALF done, not a quarter. Reporting it
  // against the total would call a coin barely started when the part anybody can have is gone.
  const s = etched({ ticker: 'HALF', supply: 1000, premine: 500, terms: { amount: 250 } });
  s.runes.get(runeRefOf(A, 1)).minted = 250;
  const c = coin(s, runeRefOf(A, 1), A);
  assert.strictEqual(c.openSupply, 500);
  assert.strictEqual(c.mintedShare, 0.5);
});

test('a coin with nothing left open reports no share rather than dividing by zero', () => {
  const c = coin(etched({ ticker: 'ALLMINE', supply: 1000, premine: 1000 }), runeRefOf(A, 1), A);
  assert.strictEqual(c.openSupply, 0);
  assert.strictEqual(c.mintedShare, 0);
});

test('whole coins are the atomic figures divided by the divisibility, everywhere', () => {
  const c = coin(etched({ ticker: 'DEC', supply: 100000, premine: 20000, div: 2 }), runeRefOf(A, 1), A);
  assert.strictEqual(c.inWholeCoins.supply, 1000);
  assert.strictEqual(c.inWholeCoins.premine, 200);
});

test('THE HOLDER COUNT COUNTS COINS, and the name in the data says so', () => {
  // The indexer never learns which address an outpoint pays, so "holders" would be a number people
  // would quote and would be wrong. The field is called carriers for that reason.
  const s = etched({ ticker: 'SPREAD', supply: 1000, premine: 600 });
  const ref = runeRefOf(A, 1);
  s.credit(outpoint('a'.repeat(64), 0), ref, 300);
  s.credit(outpoint('a'.repeat(64), 1), ref, 200);
  s.credit(outpoint('b'.repeat(64), 0), ref, 100);
  const d = distribution(s, ref);
  assert.ok('carriers' in d && !('holders' in d), 'the field must not claim to count people');
  assert.strictEqual(d.carriers, 4, 'three credited here plus the premine carrier');
  assert.strictEqual(d.largest, 600);
});

test('the top ten share is a fraction of what is actually out, not of the supply', () => {
  const s = etched({ ticker: 'CONC', supply: 1000, premine: 0 });
  const ref = runeRefOf(A, 1);
  for (let i = 0; i < 12; i++) s.credit(outpoint(String(i).padStart(64, '0'), 0), ref, i === 0 ? 910 : 10);
  const d = distribution(s, ref);
  // One whale of 910 and eleven minnows of 10 is 1020 out, across twelve carriers. The top ten hold
  // 910 plus nine tens, so 1000 of 1020: the point is that two carriers fall OUTSIDE the ten, which
  // is what makes this a test of the cut rather than of a sum.
  assert.strictEqual(d.circulating, 1020);
  assert.strictEqual(d.carriers, 12);
  assert.ok(d.topTenShare > 0.97 && d.topTenShare < 1, 'concentrated, and not everything is in the top ten');
});

test('the name deposit is reported, and says nobody was paid and nothing burned', () => {
  const c = coin(etched({ ticker: 'LOCKED' }), runeRefOf(A, 1), A);
  assert.ok(c.nameDeposit);
  assert.strictEqual(c.nameDeposit.paidToAnybody, false);
  assert.strictEqual(c.nameDeposit.burned, false);
  assert.ok(c.nameDeposit.lockedUnits > 0);
  assert.ok(c.nameDeposit.opensAt > 1_700_000_000);
});

console.log(`\n${passed} passed`);
