// The lock record, the public list, and the promise that adding it changed no root.
// Run: node test/runes-locks.test.js
const assert = require('assert');
const crypto = require('crypto');
const { RuneState, applyTx: rawApplyTx } = require('../src/runes/indexer');
// These histories are synthetic and sit at heights like 100, so the mainnet activation height and
// the maturity delay are switched off HERE, explicitly, rather than left to be discovered. The rules
// themselves are covered by test/runes-maturity.test.js against the real defaults.
const RELAXED = { activationHeight: 0, etchMaturity: 0 };
const applyTx = (state, tx, o) => rawApplyTx(state, tx, Object.assign({}, RELAXED, o));
const tickers = require('../src/runes/tickers');
const checkpoint = require('../src/runes/checkpoint');
const locks = require('../src/runes/locks');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const COIN = 1e6;
const pub = (n) => Buffer.concat([Buffer.from([2]), crypto.createHash('sha256').update('k' + n).digest()]);

/** An etching that pays its ticker price into a real CLTV lock. */
function etchTx(ticker, { height = 100, txIndex = 1, time = 1_700_000_000, keyN = 1, extra = 0 } = {}) {
  const k = pub(keyN);
  const locktime = time + tickers.LOCK_SECONDS;
  const script = tickers.lockScriptFor({ t: locktime, k });
  const owed = tickers.priceOf(ticker);
  return {
    height, txIndex, time,
    txid: crypto.createHash('sha256').update(ticker).digest().toString('hex'),
    inputs: [],
    outputs: [
      { value: 1000, scriptPubKey: Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex') },
      { value: owed + extra, scriptPubKey: script.scriptPubKey },
    ],
    etching: { ticker, name: ticker, divisibility: 0, supply: 1000, premine: 0, spacers: 0, lock: { t: locktime, k } },
  };
}

console.log('the record');

test('an etched rune keeps where its price is locked', () => {
  const s = new RuneState();
  applyTx(s, etchTx('DOGGOTOTHEMOON'));
  const rune = [...s.runes.values()][0];
  assert.ok(rune.lock, 'the lock was recorded');
  assert.strictEqual(rune.lock.pubkey, pub(1).toString('hex'));
  assert.deepStrictEqual(rune.lock.vouts, [1], 'and which output holds it');
  assert.strictEqual(rune.lock.value, tickers.priceOf('DOGGOTOTHEMOON'));
});

test('it is plain JSON, so a snapshot round trip keeps it', () => {
  const s = new RuneState();
  applyTx(s, etchTx('ROUNDTRIP'));
  const back = RuneState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  const a = [...s.runes.values()][0].lock, b = [...back.runes.values()][0].lock;
  assert.deepStrictEqual(b, a, 'identical after JSON');
  assert.strictEqual(typeof b.pubkey, 'string', 'a hex string, never a Buffer');
});

test('several outputs to the same lock are all recorded', () => {
  const s = new RuneState();
  const tx = etchTx('SPLITLOCK');
  tx.outputs.push({ value: 5 * COIN, scriptPubKey: tx.outputs[1].scriptPubKey });
  applyTx(s, tx);
  assert.deepStrictEqual([...s.runes.values()][0].lock.vouts, [1, 2]);
});

test('an unpaid etching registers nothing, so it records no lock either', () => {
  const s = new RuneState();
  const tx = etchTx('UNPAID');
  tx.outputs[1].value = 1;                    // nowhere near the price
  applyTx(s, tx);
  assert.strictEqual(s.runes.size, 0);
});

console.log('the checkpoint must not have moved');

test('adding the lock to the record changes no merkle root', () => {
  // The whole point of this control. runeLeaf() names the fields it hashes, so a new field is
  // invisible to it, and this proves that rather than trusting the reading.
  const s = new RuneState();
  applyTx(s, etchTx('ROOTSTABLE'));
  const withLock = checkpoint.stateRoot(s).toString('hex');

  const stripped = new RuneState();
  applyTx(stripped, etchTx('ROOTSTABLE'));
  for (const r of stripped.runes.values()) delete r.lock;
  const withoutLock = checkpoint.stateRoot(stripped).toString('hex');

  assert.strictEqual(withLock, withoutLock, 'the root is the same with and without the lock');

  // And the control for the control: a root that ignores everything would also pass the line above.
  const other = new RuneState();
  applyTx(other, etchTx('DIFFERENT'));
  assert.notStrictEqual(checkpoint.stateRoot(other).toString('hex'), withLock,
    'a different rune must give a different root');
});

console.log('the public list');

test('it lists what a wallet needs and nothing secret', () => {
  const s = new RuneState();
  applyTx(s, etchTx('ALPHA', { height: 100, keyN: 1 }));
  applyTx(s, etchTx('BETA', { height: 200, keyN: 2 }));
  const list = locks.listLocks(s, { now: 1_700_000_000 });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].ticker, 'BETA', 'newest etch first');
  const keys = Object.keys(list[0]).sort();
  assert.ok(keys.includes('pubkey') && keys.includes('locktime') && keys.includes('value'));
  assert.ok(!keys.some((k) => /priv|wif|secret|seed/i.test(k)), 'nothing private, by shape');
});

test('the countdown reads off the record, not the clock', () => {
  const s = new RuneState();
  applyTx(s, etchTx('WAITING', { time: 1_700_000_000 }));
  const soon = locks.listLocks(s, { now: 1_700_000_000 })[0];
  assert.strictEqual(soon.open, false);
  assert.strictEqual(soon.secondsLeft, tickers.LOCK_SECONDS);
  const later = locks.listLocks(s, { now: 1_700_000_000 + tickers.LOCK_SECONDS + 1 })[0];
  assert.strictEqual(later.open, true);
  assert.strictEqual(later.secondsLeft, 0);
});

test('filtering by public key returns only those locks', () => {
  const s = new RuneState();
  applyTx(s, etchTx('MINE', { height: 100, keyN: 7 }));
  applyTx(s, etchTx('THEIRS', { height: 101, keyN: 8 }));
  const mine = locks.locksFor(s, [pub(7).toString('hex')]);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].ticker, 'MINE');
  assert.strictEqual(locks.locksFor(s, []).length, 0);
  assert.strictEqual(locks.locksFor(s, ['ab'.repeat(33)]).length, 0);
});

test('the summary adds up, and separates open from still locked', () => {
  const s = new RuneState();
  applyTx(s, etchTx('ONE', { height: 100, keyN: 1 }));
  applyTx(s, etchTx('TWO', { height: 101, keyN: 2, time: 1_600_000_000 }));
  const now = 1_600_000_000 + tickers.LOCK_SECONDS + 1;   // TWO is open, ONE is not
  const list = locks.listLocks(s, { now });
  const sum = locks.summarise(list);
  assert.strictEqual(sum.count, 2);
  assert.strictEqual(sum.open, 1);
  assert.strictEqual(sum.openValue, tickers.priceOf('TWO'));
  assert.strictEqual(sum.locked, tickers.priceOf('ONE'));
});

console.log(`\n${passed} checks passed`);
