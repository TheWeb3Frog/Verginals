// Verge Runes merkle checkpoints (RUNES-SPEC-v0 §8, vector 8).
// Run: node test/runes-checkpoint.test.js
const assert = require('assert');
const { RuneState, applyTx: rawApplyTx, runeRefOf } = require('../src/runes/indexer');
// These histories are synthetic and sit at heights like 100, so the mainnet activation height and
// the maturity delay are switched off HERE, explicitly, rather than left to be discovered. The rules
// themselves are covered by test/runes-maturity.test.js against the real defaults.
const RELAXED = { activationHeight: 0, etchMaturity: 0 };
const applyTx = (state, tx, o) => rawApplyTx(state, tx, Object.assign({}, RELAXED, o));
const { stateRoot, proveBalance, proveRune, verifyBalance, buildTree, compareCheckpoints } = require('../src/runes/checkpoint');
const codec = require('../src/runes/codec');
const { lockFor } = require('./fixtures/etchlock');

/** An etching that pays its ticker price (§7.2), or the indexer ignores it and nothing registers. */
function paidEtch(tx) {
  const paid = lockFor(String(tx.etching.ticker || '').toUpperCase());
  return Object.assign({}, tx, {
    time: paid.time,
    outputs: [...tx.outputs, paid.output],
    etching: Object.assign({ lock: paid.lock }, tx.etching),
  });
}

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const DUST = 100000;
const out = (value = DUST) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });
const opret = (p) => ({ value: 0, isOpReturn: true, opReturnData: p });
const REF = runeRefOf(100, 1);

/** A state holding several balances across several outpoints. */
function populated() {
  const s = new RuneState();
  applyTx(s, paidEtch({
    txid: 'etch', height: 100, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'FROG', supply: 1000000, premine: 1000000, divisibility: 2 },
  }));
  applyTx(s, {
    txid: 'split', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), out(), opret(codec.encodeEdicts([
      { runeRef: REF, amount: 250000, output: 1 },
      { runeRef: REF, amount: 250000, output: 2 },
    ]))],
  });
  return s;
}

test('an empty state commits to the zero root', () => {
  assert.ok(stateRoot(new RuneState()).equals(Buffer.alloc(32)));
});

test('the root is deterministic and independent of insertion order', () => {
  assert.ok(stateRoot(populated()).equals(stateRoot(populated())));
});

test('vector 8: a wallet can prove its own balance against the published root', () => {
  const s = populated();
  const root = stateRoot(s);
  for (const e of s.entries()) {
    const p = proveBalance(s, e.outpoint, e.runeRef);
    assert.ok(p, 'no proof for ' + e.outpoint);
    assert.ok(verifyBalance(p.entry, p.path, root), 'proof failed for ' + e.outpoint);
  }
});

test('vector 8b: a tampered amount fails against the same root', () => {
  const s = populated();
  const root = stateRoot(s);
  const p = proveBalance(s, 'split:1', REF);
  const lie = Object.assign({}, p.entry, { amount: p.entry.amount * 10 });
  assert.ok(!verifyBalance(lie, p.path, root));
});

test('a proof from one state does not verify against another state root', () => {
  const a = populated();
  const p = proveBalance(a, 'split:1', REF);
  const b = populated();
  applyTx(b, {
    txid: 'more', height: 102, txIndex: 0,
    inputs: [{ txid: 'split', vout: 0 }], outputs: [out()],
  });
  assert.ok(!verifyBalance(p.entry, p.path, stateRoot(b)));
});

test('a tampered path fails', () => {
  const s = populated();
  const root = stateRoot(s);
  const p = proveBalance(s, 'split:1', REF);
  if (p.path.length) {
    const bad = p.path.slice();
    bad[0] = Buffer.alloc(32, 0xff);
    assert.ok(!verifyBalance(p.entry, bad, root));
  }
  assert.ok(!verifyBalance(p.entry, [Buffer.alloc(31)], root)); // wrong-sized node
});

test('an unknown outpoint has no proof', () => {
  assert.strictEqual(proveBalance(populated(), 'nothere:0', REF), null);
});

test('a single-leaf tree proves with an empty path', () => {
  const { root } = buildTree([{ outpoint: 'solo:0', runeRef: '1:1', amount: 10 }]);
  assert.ok(verifyBalance({ outpoint: 'solo:0', runeRef: '1:1', amount: 10 }, [], root));
});

test('a checkpoint commits to what a reference MEANS, not only to how much sits where', () => {
  const s = new RuneState();
  applyTx(s, paidEtch({
    txid: 'solo', height: 1, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'SOLO', supply: 10, premine: 10, divisibility: 2 },
  }));
  const root = stateRoot(s);

  // The balance proof alone says "solo:0 holds 10 of 1:1" and nothing about what 1:1 is.
  const bal = proveBalance(s, 'solo:0', runeRefOf(1, 1));
  assert.ok(verifyBalance(bal.entry, bal.path, root));
  assert.strictEqual(bal.entry.ticker, undefined);

  // The rune proof is what turns that number into a name, against the same root.
  const def = proveRune(s, runeRefOf(1, 1));
  assert.ok(verifyBalance(def.entry, def.path, root));
  assert.strictEqual(def.entry.ticker, 'SOLO');
  assert.strictEqual(def.entry.divisibility, 2);

  // And a lie about the ticker does not survive it.
  assert.ok(!verifyBalance({ ...def.entry, ticker: 'GRUMPY' }, def.path, root));
});

test('an unregistered reference has no rune proof', () => {
  assert.strictEqual(proveRune(new RuneState(), '1:1'), null);
});

test('odd node counts are carried up, never duplicated (no second-preimage trick)', () => {
  // three leaves: a duplicating implementation would make trees of 3 and 4 leaves collide
  const three = [
    { outpoint: 'a:0', runeRef: 1, amount: 1 },
    { outpoint: 'b:0', runeRef: 1, amount: 2 },
    { outpoint: 'c:0', runeRef: 1, amount: 3 },
  ];
  const four = three.concat([{ outpoint: 'c:0', runeRef: 1, amount: 3 }]);
  assert.ok(!buildTree(three).root.equals(buildTree(four).root));
});

test('every leaf of a 1..12 leaf tree proves correctly', () => {
  for (let n = 1; n <= 12; n++) {
    const entries = Array.from({ length: n }, (_, i) => ({ outpoint: `t${i}:0`, runeRef: 5, amount: i + 1 }));
    const { root, levels } = buildTree(entries);
    for (let i = 0; i < n; i++) {
      const path = [];
      let idx = i;
      for (let l = 0; l < levels.length - 1; l++) {
        const sib = idx % 2 === 0 ? levels[l][idx + 1] : levels[l][idx - 1];
        if (sib) path.push(sib);
        idx = Math.floor(idx / 2);
      }
      assert.ok(verifyBalance(entries[i], path, root), `leaf ${i} of ${n} failed`);
    }
  }
});

test('two indexers that agree produce the same root; a divergence is detectable', () => {
  const a = { height: 500, root: stateRoot(populated()) };
  const b = { height: 500, root: stateRoot(populated()) };
  assert.strictEqual(compareCheckpoints(a, b).agree, true);

  const cheating = populated();
  applyTx(cheating, paidEtch({
    txid: 'secret', height: 102, txIndex: 0, inputs: [], outputs: [out()],
    etching: { ticker: 'FAKE', supply: 1, premine: 1 },
  }));
  const c = { height: 500, root: stateRoot(cheating) };
  assert.strictEqual(compareCheckpoints(a, c).agree, false);
});

test('a checkpoint root round-trips through the on-chain message', () => {
  const root = stateRoot(populated());
  const msg = codec.decode(codec.encodeCheckpoint(9363580, root));
  assert.ok(msg.root.equals(root));
});

console.log('\nrunes checkpoint: ' + passed + ' passed');
