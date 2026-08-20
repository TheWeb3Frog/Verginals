// The two rules the owner set on 2026-08-20: the activation height, and how long a rune must settle
// before an edict can move it.
//
// This file uses the REAL DEFAULTS. Every other test switches them off explicitly, because their
// histories live at heights like 100, so this is the only place the shipped numbers are exercised.
//
// The rule that is easiest to get wrong, and has its own test: holding an edict back must NOT destroy
// the balance. It falls through to the default assignment, exactly as an unnamed rune does. Burning
// somebody's premine because they moved a coin four minutes too early would be far worse than the
// problem the delay exists to solve.
//
// Run: node test/runes-maturity.test.js
const assert = require('assert');
const codec = require('../src/runes/codec');
const { RuneState, applyTx, index, runeRefOf, outpoint, mature } = require('../src/runes/indexer');
const verifyImpl = require('../src/runes/verify');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const A = codec.ACTIVATION_HEIGHT;
const DUST = 100000;
const out = (value = DUST) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });
const opret = (d) => ({ value: 0, isOpReturn: true, opReturnData: d });

/** An etching at `height`, paid for, with `premine` premined. */
function etchTx(txid, height, txIndex, ticker, premine = 1000) {
  const paid = lockFor(ticker);
  return {
    txid, height, txIndex, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: { ticker, supply: premine, premine, divisibility: 0, lock: paid.lock },
  };
}

// --- the activation height ------------------------------------------------------------------------
test('the shipped numbers are the ones the owner chose', () => {
  assert.strictEqual(codec.ACTIVATION_HEIGHT, 9420420);
  assert.strictEqual(codec.ETCH_MATURITY, 6);
});

test('an etching one block below activation is not a rune', () => {
  const s = new RuneState();
  applyTx(s, etchTx('early', A - 1, 1, 'EARLY'));
  assert.strictEqual(s.runes.size, 0);
  assert.strictEqual(s.tickers.size, 0, 'and the ticker stays free');
});

test('an etching exactly at activation is a rune', () => {
  const s = new RuneState();
  applyTx(s, etchTx('onblock', A, 1, 'ONBLOCK'));
  assert.strictEqual(s.runes.size, 1);
  assert.ok(s.tickers.has('ONBLOCK'));
});

test('a premine still lands on an ordinary etch, so etching is untouched by the delay', () => {
  const s = new RuneState();
  applyTx(s, etchTx('p', A + 10, 2, 'PREMINE', 4200));
  const ref = runeRefOf(A + 10, 2);
  assert.strictEqual(s.balanceOf(outpoint('p', 0), ref), 4200);
});

// --- maturity -------------------------------------------------------------------------------------
const REF = runeRefOf(A, 1);

/** Etch, then try to move 40 of it by edict `gap` blocks later. */
function moveAfter(gap) {
  const s = new RuneState();
  applyTx(s, etchTx('e', A, 1, 'MOVE', 100));
  applyTx(s, {
    txid: 'm', height: A + gap, txIndex: 0,
    inputs: [{ txid: 'e', vout: 0 }],
    outputs: [out(), out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 40, output: 1 }]))],
  });
  return s;
}

test('an edict five blocks after the etching is ignored', () => {
  const s = moveAfter(5);
  assert.strictEqual(s.balanceOf(outpoint('m', 1), REF), 0, 'the named output receives nothing');
});

test('an edict six blocks after the etching works', () => {
  const s = moveAfter(6);
  assert.strictEqual(s.balanceOf(outpoint('m', 1), REF), 40);
  assert.strictEqual(s.balanceOf(outpoint('m', 0), REF), 60, 'and the rest falls back as usual');
});

test('THE BALANCE IS NEVER DESTROYED: a held-back edict falls to the default assignment', () => {
  // This is the whole reason the delay is on edicts and not on the default path. If it were on both,
  // an ordinary wallet send four minutes after an etch would BURN the premine.
  const s = moveAfter(5);
  assert.strictEqual(s.balanceOf(outpoint('m', 0), REF), 100, 'all of it, on the first eligible output');
  const total = [...s.entries()].reduce((n, e) => n + e.amount, 0);
  assert.strictEqual(total, 100, 'nothing was burned');
});

test('the ticker is claimed IMMEDIATELY, before the rune is old enough to move', () => {
  // Otherwise two people could claim one name inside the gap and only one of them would find out.
  const s = new RuneState();
  applyTx(s, etchTx('first', A, 1, 'RACE'));
  applyTx(s, etchTx('second', A + 1, 1, 'RACE'));
  assert.strictEqual(s.tickers.get('RACE'), runeRefOf(A, 1));
  assert.strictEqual(s.runes.size, 1, 'the second etching of a taken name is ignored');
});

test('mature() is the rule, and it is off by one in the right direction', () => {
  assert.strictEqual(mature(REF, A + 5), false);
  assert.strictEqual(mature(REF, A + 6), true);
  assert.strictEqual(mature('not a ref', A + 999), false);
});

// --- both implementations ---------------------------------------------------------------------------
test('the second implementation agrees, block for block, on both rules', () => {
  const txs = [
    etchTx('early', A - 1, 1, 'EARLY'),          // below activation: not a rune
    etchTx('e', A, 1, 'MOVE', 100),              // a rune
    { txid: 'tooSoon', height: A + 3, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 40, output: 1 }]))] },
    { txid: 'okNow', height: A + 9, txIndex: 0, inputs: [{ txid: 'tooSoon', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 40, output: 1 }]))] },
  ];
  const mine = [...index(txs).entries()];
  const theirs = [...verifyImpl.index(txs).entries()];
  assert.deepStrictEqual(mine, theirs);
  // and it actually did something: the late move landed, the early one did not
  const landed = mine.find((e) => e.outpoint === outpoint('okNow', 1));
  assert.ok(landed && landed.amount === 40, 'the mature edict moved 40');
});

test('CONTROL: the two implementations would disagree if one skipped a rule', () => {
  // Same history, but one side is told the delay is zero. If this passed, the test above would be
  // comparing two identical configurations and proving nothing.
  const txs = [
    etchTx('e', A, 1, 'CTRL', 100),
    { txid: 'soon', height: A + 2, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 40, output: 1 }]))] },
  ];
  const strict = JSON.stringify([...index(txs).entries()]);
  const loose = JSON.stringify([...index(txs, { etchMaturity: 0 }).entries()]);
  assert.notStrictEqual(strict, loose);
});

console.log(`\n${passed} passed`);
