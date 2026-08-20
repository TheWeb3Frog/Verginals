// What the mint page is allowed to offer must match what the indexer will accept.
// Run: node test/runes-mintable.test.js
const assert = require('assert');
const codec = require('../src/runes/codec');
const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer');
const { mintable, describe: describeMint } = require('../src/runes/mintable');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };
const A = codec.ACTIVATION_HEIGHT;
const DUST = 100000;
const out = (v = DUST) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });

function etch(ticker, terms, over = {}) {
  const s = new RuneState();
  const paid = lockFor(ticker);
  applyTx(s, {
    txid: 'e' + ticker, height: A, txIndex: 1, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: Object.assign({ ticker, supply: 1000, premine: 0, divisibility: 0, lock: paid.lock, terms }, over),
  });
  s.height = A;
  return s;
}

test('a coin with no terms is not offered at all', () => {
  const s = etch('NOTERMS', null);
  assert.strictEqual(mintable(s, A).length, 0);
});

test('an open mint is offered, with what it gives and what it costs', () => {
  const s = etch('OPEN', { amount: 100, price: 20000000 });
  const [m] = mintable(s, A);
  assert.strictEqual(m.open, true);
  assert.strictEqual(m.amount, 100);
  assert.strictEqual(m.priceUnits, 20000000);
  assert.match(m.priceGoesTo, /miner/);
});

test('remaining is the SMALLER of the cap and the supply, never the friendlier one', () => {
  // cap says 50 mints, supply says 10. Reporting 50 would promise 40 mints that cannot exist.
  const s = etch('TIGHT', { amount: 100, cap: 50 }, { supply: 1000, premine: 0 });
  const [m] = mintable(s, A);
  assert.strictEqual(m.remaining, 10, 'supply binds before the cap here');
});

test('a premine eats into what is left to mint', () => {
  const s = etch('PRE', { amount: 100 }, { supply: 1000, premine: 600 });
  const [m] = mintable(s, A);
  assert.strictEqual(m.remaining, 4, '400 left, 100 a mint');
});

test('a window that has not opened says so, and says when', () => {
  const s = etch('LATER', { amount: 10, openHeight: A + 500 });
  const [m] = mintable(s, A);
  assert.strictEqual(m.open, false);
  assert.match(m.closedBecause.join(' '), /opens at block/);
});

test('a window that has shut says so, and is still listed', () => {
  const s = etch('GONE', { amount: 10, closeHeight: A + 1 });
  s.height = A + 50;
  const [m] = mintable(s, A + 50);
  assert.strictEqual(m.open, false);
  assert.match(m.closedBecause.join(' '), /closed at block/);
});

test('THE WINDOW IS JUDGED AT THE NEXT BLOCK, not the one already mined', () => {
  // applyMint compares against the height of the block CARRYING the mint. A page that judged the
  // current tip would grey out a mint that opens in the very next block, one it could be sent for.
  const s = etch('EDGE', { amount: 10, openHeight: A + 1 });
  assert.strictEqual(describeMint(s.runes.get(runeRefOf(A, 1)), runeRefOf(A, 1), A).open, true);
  assert.strictEqual(describeMint(s.runes.get(runeRefOf(A, 1)), runeRefOf(A, 1), A - 1).open, false);
});

test('an allowlisted mint is flagged rather than offered as a plain button', () => {
  const s = etch('GATED', { amount: 10 }, { allowlistRoot: Buffer.alloc(32, 7) });
  const [m] = mintable(s, A);
  assert.strictEqual(m.allowlisted, true);
});

test('open coins come first, then the ones with most left', () => {
  const s = etch('AAA', { amount: 10, closeHeight: A - 1 });
  const paid = lockFor('BBB');
  applyTx(s, {
    txid: 'e2', height: A, txIndex: 2, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: { ticker: 'BBB', supply: 1000, premine: 0, divisibility: 0, lock: paid.lock, terms: { amount: 10 } },
  });
  const rows = mintable(s, A);
  assert.strictEqual(rows[0].ticker, 'BBB', 'the open one leads');
  assert.strictEqual(rows[0].open, true);
  assert.strictEqual(rows[1].open, false);
});

console.log(`\n${passed} passed`);
