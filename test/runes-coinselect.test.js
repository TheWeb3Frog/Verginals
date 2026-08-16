// Rune-aware coin selection: the safety-critical path (RUNES-PLAN §2.3).
// Every test here exists because getting it wrong destroys someone's rune permanently.
// Run: node test/runes-coinselect.test.js
const assert = require('assert');
const {
  DUST_UNITS, selectCoins, assertNoRunesSpent, unassignedRunes,
  InsufficientFunds, InsufficientRune,
} = require('../src/runes/coinselect');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const REF = '131:1';
const REF2 = '131:2';
const clean = (txid, value) => ({ txid, vout: 0, value });
const bearing = (txid, value, runes) => ({ txid, vout: 0, value, runes });

test('a plain payment never touches a rune-carrying utxo, even when it is the fattest', () => {
  const utxos = [
    bearing('rich', 100 * DUST_UNITS, { [REF]: 5000 }), // by far the biggest
    clean('small1', 2 * DUST_UNITS),
    clean('small2', 2 * DUST_UNITS),
  ];
  const sel = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS });
  assert.ok(!sel.inputs.some((u) => u.txid === 'rich'), 'the rune utxo must never be selected for its value');
  assert.deepStrictEqual(sel.carriedRunes, {});
  assertNoRunesSpent(sel); // must not throw
});

test('it fails rather than spending a rune utxo when clean funds are short', () => {
  const utxos = [
    bearing('carrier', 1000 * DUST_UNITS, { [REF]: 5000 }),
    clean('tiny', DUST_UNITS),
  ];
  assert.throws(
    () => selectCoins({ utxos, targetValue: 50 * DUST_UNITS, fee: DUST_UNITS }),
    InsufficientFunds,
    'must refuse, not reach for the rune utxo',
  );
});

test('a rune utxo IS spent when the transaction is deliberately moving that rune', () => {
  const utxos = [
    bearing('carrier', DUST_UNITS, { [REF]: 5000 }),
    clean('fee', 5 * DUST_UNITS),
  ];
  const sel = selectCoins({
    utxos, targetValue: DUST_UNITS, fee: DUST_UNITS,
    requiredRunes: [{ runeRef: REF, amount: 5000 }],
  });
  assert.ok(sel.inputs.some((u) => u.txid === 'carrier'));
  assert.strictEqual(sel.gathered[REF], 5000);
});

test('several holders are combined when one is not enough', () => {
  const utxos = [
    bearing('a', DUST_UNITS, { [REF]: 300 }),
    bearing('b', DUST_UNITS, { [REF]: 400 }),
    bearing('c', DUST_UNITS, { [REF]: 500 }),
    clean('fee', 10 * DUST_UNITS),
  ];
  const sel = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 800 }] });
  assert.ok(sel.gathered[REF] >= 800);
  // largest first, so c(500) + b(400) is enough and a is left alone
  assert.ok(!sel.inputs.some((u) => u.txid === 'a'));
});

test('amount 0 sweeps every unit of that rune', () => {
  const utxos = [
    bearing('a', DUST_UNITS, { [REF]: 300 }),
    bearing('b', DUST_UNITS, { [REF]: 700 }),
    clean('fee', 10 * DUST_UNITS),
  ];
  const sel = selectCoins({ utxos, targetValue: 0, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 0 }] });
  assert.strictEqual(sel.gathered[REF], 1000);
  assert.strictEqual(sel.inputs.filter((u) => u.runes).length, 2);
});

test('asking for more of a rune than is held fails loudly', () => {
  const utxos = [bearing('a', DUST_UNITS, { [REF]: 100 }), clean('fee', 10 * DUST_UNITS)];
  assert.throws(() => selectCoins({ utxos, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 500 }] }), InsufficientRune);
});

test('asking for a rune that is not held at all fails loudly', () => {
  const utxos = [clean('a', 10 * DUST_UNITS)];
  assert.throws(() => selectCoins({ utxos, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 1 }] }), InsufficientRune);
});

test('a second rune riding along on a needed utxo is reported, never silently lost', () => {
  const utxos = [
    bearing('both', DUST_UNITS, { [REF]: 500, [REF2]: 900 }), // moving REF drags REF2 along
    clean('fee', 10 * DUST_UNITS),
  ];
  const sel = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 500 }] });
  assert.strictEqual(sel.carriedRunes[REF2], 900);

  // the wallet is told REF2 still needs an explicit destination
  const edicts = [{ runeRef: REF, amount: 500, output: 0 }];
  assert.deepStrictEqual(unassignedRunes(sel, edicts), [{ runeRef: REF2, amount: 900 }]);

  // once assigned, nothing is left dangling
  assert.deepStrictEqual(unassignedRunes(sel, edicts.concat([{ runeRef: REF2, amount: 900, output: 1 }])), []);
});

test('assertNoRunesSpent is the guard a plain send must call', () => {
  const utxos = [bearing('c', DUST_UNITS, { [REF]: 1 }), clean('f', 10 * DUST_UNITS)];
  const moving = selectCoins({ utxos, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 1 }] });
  assert.throws(() => assertNoRunesSpent(moving), /refusing to spend rune-carrying inputs/);
});

test('change below dust is dropped rather than made unspendable', () => {
  const utxos = [clean('a', 2 * DUST_UNITS + 5)];
  const sel = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS });
  assert.strictEqual(sel.changeValue, 0); // the 5 units go to the miner
  const bigger = selectCoins({ utxos: [clean('a', 5 * DUST_UNITS)], targetValue: DUST_UNITS, fee: DUST_UNITS });
  assert.strictEqual(bigger.changeValue, 3 * DUST_UNITS);
});

test('the same utxo is never selected twice', () => {
  const utxos = [
    bearing('a', DUST_UNITS, { [REF]: 100, [REF2]: 100 }),
    clean('fee', 10 * DUST_UNITS),
  ];
  const sel = selectCoins({
    utxos, fee: DUST_UNITS,
    requiredRunes: [{ runeRef: REF, amount: 100 }, { runeRef: REF2, amount: 100 }],
  });
  const keys = sel.inputs.map((u) => u.txid + ':' + u.vout);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('an empty wallet fails cleanly instead of returning nonsense', () => {
  assert.throws(() => selectCoins({ utxos: [], targetValue: DUST_UNITS, fee: DUST_UNITS }), InsufficientFunds);
  const free = selectCoins({ utxos: [], targetValue: 0, fee: 0 });
  assert.deepStrictEqual(free.inputs, []);
});

test('the value of a rune utxo still counts toward funding once it is legitimately spent', () => {
  const utxos = [bearing('carrier', 10 * DUST_UNITS, { [REF]: 5 })];
  const sel = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS, requiredRunes: [{ runeRef: REF, amount: 5 }] });
  assert.strictEqual(sel.inputValue, 10 * DUST_UNITS);
  assert.strictEqual(sel.changeValue, 8 * DUST_UNITS);
});

console.log('\nrunes coinselect: ' + passed + ' passed');
