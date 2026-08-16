// The browser rune module must behave exactly like the Node one it mirrors.
// A wallet that disagrees with the indexer about what a coin holds is a wallet that loses funds.
// Run: node extension/test-runes.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto; // verge.js uses WebCrypto

const require = createRequire(import.meta.url);
const nodeCodec = require('../src/runes/codec');
const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer');
const nodeCheckpoint = require('../src/runes/checkpoint');
const { lockFor } = require('../test/fixtures/etchlock');

/**
 * An etching that pays for its ticker (RUNES-SPEC-v0 §7.2). Since the price became a lock, an
 * etching that does not pay registers nothing at all, so every test that etches has to pay.
 */
function paidEtch(tx) {
  if (!tx.etching) return tx;            // a plain transfer has nothing to pay for
  const paid = lockFor(String(tx.etching.ticker).toUpperCase());
  return { ...tx, time: paid.time,
    outputs: [...tx.outputs, paid.output],
    etching: { lock: paid.lock, ...tx.etching } };
}

const {
  decodeMessage, verifyBalance, verifiedBalances,
  carriesRune, spendableForPayment, selectForRuneTransfer,
} = await import('./lib/runes.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log('  ok - ' + name); };

const REF = '131:1';
const DUST = 100000;

await test('the browser decoder matches the node encoder for edicts', () => {
  const payload = nodeCodec.encodeEdicts([
    { runeRef: REF, amount: 500, output: 0 },
    { runeRef: '131:41', amount: 0, output: 2 },
  ]);
  const browser = decodeMessage(Uint8Array.from(payload));
  const node = nodeCodec.decode(payload);
  assert.deepStrictEqual(browser.edicts, node.edicts);
});

await test('the browser decoder matches the node encoder for mint and checkpoint', () => {
  const mint = nodeCodec.encodeMint(REF);
  assert.strictEqual(decodeMessage(Uint8Array.from(mint)).runeRef, nodeCodec.decode(mint).runeRef);

  const root = Buffer.alloc(32, 0x2b);
  const cp = nodeCodec.encodeCheckpoint(9363580, root);
  const b = decodeMessage(Uint8Array.from(cp));
  assert.strictEqual(b.height, 9363580);
  assert.ok(Buffer.from(b.root).equals(root));
});

await test('the browser decoder rejects exactly what the node one rejects', () => {
  const bad = [
    Uint8Array.from([]), Uint8Array.from([0x56, 0x41]),
    Uint8Array.from([0x56, 0x41, 0x99, 0x01]), Uint8Array.from([0x00, 0x00, 0x00]),
    Uint8Array.from([0x56, 0x41, 0x00, 0x80]),
  ];
  for (const b of bad) {
    assert.strictEqual(decodeMessage(b), null);
    assert.strictEqual(nodeCodec.decode(Buffer.from(b)), null);
  }
});

await test('a proof built by the node verifies in the browser', async () => {
  const state = new RuneState();
  applyTx(state, paidEtch({
    txid: 'etch', height: 100, txIndex: 1, inputs: [],
    outputs: [{ value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
      { value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false }],
    etching: { ticker: 'WALLET', supply: 100000, premine: 100000, divisibility: 2 },
  }));
  applyTx(state, paidEtch({
    txid: 'split', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [{ value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
      { value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
      { value: 0, isOpReturn: true, opReturnData: nodeCodec.encodeEdicts([{ runeRef: runeRefOf(100, 1), amount: 30000, output: 1 }]) }],
  }));

  const root = nodeCheckpoint.stateRoot(state);
  for (const e of state.entries()) {
    const proof = nodeCheckpoint.proveBalance(state, e.outpoint, e.runeRef);
    const ok = await verifyBalance(proof.entry, proof.path.map((p) => Uint8Array.from(p)), Uint8Array.from(root));
    assert.ok(ok, 'browser rejected a valid node proof for ' + e.outpoint);
  }
});

await test('the browser rejects a tampered balance, exactly as the node does', async () => {
  const state = new RuneState();
  applyTx(state, paidEtch({
    txid: 'e', height: 1, txIndex: 1, inputs: [],
    outputs: [{ value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false }],
    etching: { ticker: 'TAMPER', supply: 10, premine: 10 },
  }));
  const root = nodeCheckpoint.stateRoot(state);
  const entry = [...state.entries()][0];
  const proof = nodeCheckpoint.proveBalance(state, entry.outpoint, entry.runeRef);
  const lie = { ...proof.entry, amount: proof.entry.amount * 2 };
  assert.strictEqual(await verifyBalance(lie, proof.path.map((p) => Uint8Array.from(p)), Uint8Array.from(root)), false);
  assert.strictEqual(nodeCheckpoint.verifyBalance(lie, proof.path, root), false);
});

await test('an answer containing one unproven balance is refused wholesale', async () => {
  const state = new RuneState();
  applyTx(state, paidEtch({
    txid: 'e', height: 1, txIndex: 1, inputs: [],
    outputs: [{ value: DUST, scriptPubKey: Buffer.alloc(1), isOpReturn: false }],
    etching: { ticker: 'PARTIAL', supply: 10, premine: 10 },
  }));
  const root = Uint8Array.from(nodeCheckpoint.stateRoot(state));
  const entry = [...state.entries()][0];
  const proof = nodeCheckpoint.proveBalance(state, entry.outpoint, entry.runeRef);
  const answer = {
    entries: [
      { entry: proof.entry, path: proof.path.map((p) => [...p]) },
      { entry: { outpoint: 'made:0', runeRef: 99, amount: 1000000 }, path: [] }, // invented
    ],
  };
  const { balances, rejected } = await verifiedBalances(answer, root);
  assert.strictEqual(rejected, 1);
  assert.ok(!balances.has('made:0'), 'an unproven balance must never be merged in');
});

await test('a coin of unknown rune status is treated as carrying one', () => {
  assert.strictEqual(carriesRune({ value: 1 }), true);            // undefined
  assert.strictEqual(carriesRune({ value: 1, runes: null }), true);
  assert.strictEqual(carriesRune({ value: 1, runes: {} }), false);
  assert.strictEqual(carriesRune({ value: 1, runes: { [REF]: 5 } }), true);
});

await test('a plain payment only spends coins proven clean on BOTH counts', () => {
  const utxos = [
    { txid: 'clean', vout: 0, value: 10 * DUST, inscription: null, runes: {} },
    { txid: 'hasRune', vout: 0, value: 99 * DUST, inscription: null, runes: { [REF]: 1 } },
    { txid: 'hasInscription', vout: 0, value: 99 * DUST, inscription: { id: 'x' }, runes: {} },
    { txid: 'unknownRune', vout: 0, value: 99 * DUST, inscription: null },            // undefined
    { txid: 'unknownInscription', vout: 0, value: 99 * DUST, runes: {} },             // undefined
  ];
  assert.deepStrictEqual(spendableForPayment(utxos).map((u) => u.txid), ['clean']);
});

await test('a rune transfer picks the carriers and tops up from clean coins', () => {
  const utxos = [
    { txid: 'a', vout: 0, value: DUST, inscription: null, runes: { [REF]: 400 } },
    { txid: 'b', vout: 0, value: DUST, inscription: null, runes: { [REF]: 700 } },
    { txid: 'fee', vout: 0, value: 20 * DUST, inscription: null, runes: {} },
  ];
  // the two carriers hold 2 x dust between them, so a 5 x dust requirement forces a top-up
  const sel = selectForRuneTransfer(utxos, REF, 900, { targetValue: DUST, fee: 4 * DUST });
  assert.ok(sel.gathered >= 900);
  assert.ok(sel.inputs.some((u) => u.txid === 'fee'), 'should have topped up for the fee');
  assert.ok(sel.inputValue >= 5 * DUST);
});

await test('a transfer refuses when the rune balance is short', () => {
  const utxos = [{ txid: 'a', vout: 0, value: DUST, inscription: null, runes: { [REF]: 10 } }];
  assert.throws(() => selectForRuneTransfer(utxos, REF, 500), /insufficient balance/);
});

await test('a second rune riding on a chosen coin is reported', () => {
  const utxos = [
    { txid: 'both', vout: 0, value: 30 * DUST, inscription: null, runes: { [REF]: 100, '222:2': 55 } },
  ];
  const sel = selectForRuneTransfer(utxos, REF, 100, { fee: DUST });
  assert.strictEqual(sel.alsoCarried['222:2'], 55);
});

console.log('\nextension runes: ' + passed + ' passed');
