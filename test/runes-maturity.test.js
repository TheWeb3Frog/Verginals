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
const { lockFor, PUBKEY } = require('./fixtures/etchlock');
const tickers = require('../src/runes/tickers');

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

// --- the two names nobody gets ----------------------------------------------------------------------
test('VERGE and XVG cannot be etched, by either implementation, even when fully paid', () => {
  // The attacker here does everything right except the name: they lock the correct amount for a
  // ticker of that length and claim the reserved one anyway. Note the fixture cannot even quote a
  // price for VERGE any more, so the lock is built against a legal name of the same length. Refusing
  // an underpaid etching would prove nothing; this proves the NAME is what is refused.
  for (const [name, sameLength] of [['VERGE', 'ALPHA'], ['XVG', 'ABC'], ['VERGECOIN', 'ALPHACOIN']]) {
    const paid = lockFor(sameLength);
    const tx = {
      txid: 'r' + name, height: A, txIndex: 1, inputs: [], time: paid.time,
      outputs: [out(), paid.output],
      etching: { ticker: name, supply: 1000, premine: 1000, divisibility: 0, lock: paid.lock },
    };
    const st = new RuneState();
    applyTx(st, tx);
    assert.strictEqual(st.runes.size, 0, name + ' must not become a rune');
    assert.strictEqual(st.tickers.size, 0, name + ' must stay unclaimed');

    const j = verifyImpl.index([tx]);
    assert.strictEqual(j.definitions.size, 0, name + ' must not become a rune in verify.js either');

    // CONTROL: the very same transaction with a legal name of the same length DOES etch, so the
    // refusal above is about the name and not about the transaction being malformed.
    const okTx = { ...tx, etching: { ...tx.etching, ticker: sameLength } };
    const st2 = new RuneState();
    applyTx(st2, okTx);
    assert.strictEqual(st2.runes.size, 1, sameLength + ' must etch');
  }
});

test('a spacer cannot walk around the reservation', () => {
  // Spacers are display only, so the bare ticker is what the rule sees. If it ever saw the typed form
  // instead, V(bullet)ERGE would be a rune that renders as VERGE.
  assert.strictEqual(tickers.bareTicker('V\u2022ERGE'), 'VERGE');
  assert.strictEqual(tickers.isReserved(tickers.bareTicker('V\u2022ERGE')), true);
  assert.throws(() => tickers.priceOf('VERGE'), /chain's own name/);
  // And the fold is real, not decoration: every caller uppercases before asking, so this is the only
  // place that would notice if it were dropped.
  assert.strictEqual(tickers.isReserved('verge'), true);
  assert.strictEqual(tickers.isReserved('xvg'), true);
  assert.strictEqual(tickers.isReserved('Verge'), true);
});

test('the list is the frozen six, and ordinary words containing verge are not swept up', () => {
  assert.deepStrictEqual([...tickers.RESERVED].sort(),
    ['VERGE', 'VERGECOIN', 'VERGECURENCY', 'VERGECURRENCY', 'VERGEXVG',
      'XVG', 'XVGCOIN', 'XVGCURENCY', 'XVGCURRENCY', 'XVGVERGE']);
  assert.strictEqual(tickers.RESERVED.length, 10, 'ten, and closed');
  // CONVERGE and DIVERGE contain "verge" and impersonate nothing. A rule broad enough to catch them
  // would be a rule about spelling rather than about identity, which is how a reservation list stops
  // being defensible.
  for (const ok of ['CONVERGE', 'DIVERGE', 'VERGENCE', 'VERG', 'ALPHA']) {
    assert.strictEqual(tickers.isReserved(ok), false, ok + ' impersonates nothing');
    assert.ok(tickers.priceOf(ok) > 0, ok + ' must still be etchable');
  }
});

test('both implementations refuse all six, and neither refuses a seventh', () => {
  // The lists are written out separately on each side. If one drifted, this is where it shows.
  for (const name of tickers.RESERVED) {
    const paid = lockFor('ALPHA');
    const tx = {
      txid: 'x' + name, height: A, txIndex: 1, inputs: [], time: paid.time,
      outputs: [out(), paid.output],
      etching: { ticker: name, supply: 10, premine: 10, divisibility: 0, lock: paid.lock },
    };
    const st = new RuneState(); applyTx(st, tx);
    assert.strictEqual(st.runes.size, 0, name + ' refused by indexer.js');
    assert.strictEqual(verifyImpl.index([tx]).definitions.size, 0, name + ' refused by verify.js');
  }
  // CONTROL: a name that is NOT on the list etches in both, so the two are not simply refusing all.
  const paid = lockFor('ALPHA');
  const okTx = {
    txid: 'okone', height: A, txIndex: 1, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: { ticker: 'CONVERGE', supply: 10, premine: 10, divisibility: 0, lock: paid.lock },
  };
  const st = new RuneState(); applyTx(st, okTx);
  assert.strictEqual(st.runes.size, 1, 'CONVERGE must etch in indexer.js');
  assert.strictEqual(verifyImpl.index([okTx]).definitions.size, 1, 'CONVERGE must etch in verify.js');
});

test('a reserved name is refused at compose time too, not only by the indexer', () => {
  const { buildEtch } = require('../src/runes/builder');
  assert.throws(() => buildEtch({ ticker: 'XVG', supply: 100, premine: 100, lock: { t: 1_800_000_000, k: PUBKEY } },
    { address: 'D7CaV2E9RLJwaPY2MXD14Th12SYpjFuB8H', value: 100000 }), /chain's own name/);
  // CONTROL: a legal name gets PAST that line. Asserted on the message rather than on success,
  // because buildEtch has other requirements this call does not satisfy and the point here is only
  // that the reserved-name guard is not rejecting everything it sees.
  let msg = '';
  try {
    buildEtch({ ticker: 'ALPHA', supply: 100, premine: 100, lock: { t: 1_800_000_000, k: PUBKEY } },
      { address: 'D7CaV2E9RLJwaPY2MXD14Th12SYpjFuB8H', value: 100000 });
  } catch (e) { msg = e.message; }
  assert.doesNotMatch(msg, /chain's own name/, 'ALPHA must not be refused as reserved');
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
