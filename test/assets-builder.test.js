// Asset transaction builders (ASSETS-PLAN §2.2).
// The ordering rules matter most: edicts address outputs by index, so a builder that reorders
// outputs sends someone's balance to the wrong recipient.
// Run: node test/assets-builder.test.js
const assert = require('assert');
const { DUST_UNITS, buildTransfer, buildMint, buildCheckpoint, buildEtch } = require('../src/assets/builder');
const codec = require('../src/assets/codec');
const cbor = require('../src/cbor');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const REF = 131001;
const REF2 = 131002;

test('the OP_RETURN is always last, so no edict can point at it', () => {
  const plan = buildTransfer([
    { address: 'D1', value: DUST_UNITS, assets: [{ assetRef: REF, amount: 10 }] },
    { address: 'D2', value: DUST_UNITS, assets: [{ assetRef: REF2, amount: 20 }] },
  ], { changeAddress: 'DCHANGE', changeValue: 5 * DUST_UNITS });

  const opIndex = plan.outputs.findIndex((o) => o.isOpReturn);
  assert.strictEqual(opIndex, plan.outputs.length - 1);
  for (const e of plan.edicts) assert.ok(e.output < opIndex, 'edict points at or past the OP_RETURN');
});

test('edict indices match the recipient positions exactly', () => {
  const plan = buildTransfer([
    { address: 'D1', value: DUST_UNITS, assets: [{ assetRef: REF, amount: 10 }] },
    { address: 'D2', value: DUST_UNITS, assets: [{ assetRef: REF2, amount: 20 }] },
  ]);
  const decoded = codec.decode(plan.opReturn);
  const byRef = Object.fromEntries(decoded.edicts.map((e) => [e.assetRef, e.output]));
  assert.strictEqual(plan.outputs[byRef[REF]].address, 'D1');
  assert.strictEqual(plan.outputs[byRef[REF2]].address, 'D2');
});

test('change sits between the recipients and the OP_RETURN, never shifting an edict index', () => {
  const withChange = buildTransfer(
    [{ address: 'D1', value: DUST_UNITS, assets: [{ assetRef: REF, amount: 10 }] }],
    { changeAddress: 'DCHANGE', changeValue: 3 * DUST_UNITS },
  );
  const without = buildTransfer([{ address: 'D1', value: DUST_UNITS, assets: [{ assetRef: REF, amount: 10 }] }]);
  assert.deepStrictEqual(
    codec.decode(withChange.opReturn).edicts,
    codec.decode(without.opReturn).edicts,
    'adding change must not move a recipient index',
  );
  assert.strictEqual(withChange.outputs[1].isChange, true);
});

test('an asset output below dust is refused', () => {
  assert.throws(
    () => buildTransfer([{ address: 'D1', value: DUST_UNITS - 1, assets: [{ assetRef: REF, amount: 1 }] }]),
    /dust minimum/,
  );
});

test('a transfer with no edict is refused (it would just be an ordinary send)', () => {
  assert.throws(() => buildTransfer([{ address: 'D1', value: DUST_UNITS }]), /no asset edict/);
  assert.throws(() => buildTransfer([]), /at least one recipient/);
});

test('a batch too large for one OP_RETURN is refused at build time, not on chain', () => {
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ address: 'D' + i, value: DUST_UNITS, assets: [{ assetRef: REF + i * 1000, amount: 1 }] });
  }
  assert.throws(() => buildTransfer(many), /OP_RETURN limit/);
});

test('the caller is told where the unassigned remainder will land', () => {
  const plan = buildTransfer([{ address: 'D1', value: DUST_UNITS, assets: [{ assetRef: REF, amount: 10 }] }]);
  assert.strictEqual(plan.remainderOutput, 0);
});

test('a mint puts the recipient first and the message last', () => {
  const plan = buildMint(REF, { address: 'D1' }, { changeAddress: 'DC', changeValue: DUST_UNITS });
  assert.strictEqual(plan.outputs[0].address, 'D1');
  assert.strictEqual(plan.outputs[plan.outputs.length - 1].isOpReturn, true);
  const msg = codec.decode(plan.opReturn);
  assert.strictEqual(msg.type, 'mint');
  assert.strictEqual(msg.assetRef, REF);
});

test('a mint carrying an allowlist proof index round-trips', () => {
  const msg = codec.decode(buildMint(REF, { address: 'D1' }, { proofIndex: 3 }).opReturn);
  assert.strictEqual(msg.proofIndex, 3);
});

test('a mint without a recipient is refused', () => {
  assert.throws(() => buildMint(REF, null), /recipient address/);
});

test('a checkpoint is just the message, optionally with change', () => {
  const root = Buffer.alloc(32, 0x11);
  const plan = buildCheckpoint(9363580, root);
  assert.strictEqual(plan.outputs.length, 1);
  assert.strictEqual(plan.outputs[0].isOpReturn, true);
  const msg = codec.decode(plan.opReturn);
  assert.strictEqual(msg.height, 9363580);
  assert.ok(msg.root.equals(root));
});

test('an etch produces the CBOR body the indexer will read back', () => {
  const plan = buildEtch({
    ticker: 'frog', name: 'Frog Token', divisibility: 2, supply: 1000000, premine: 100000,
    terms: { amount: 1000, cap: 500, openHeight: 200, closeHeight: 300 },
  }, { address: 'D1' });

  assert.strictEqual(plan.ticker, 'FROG'); // upper-cased
  assert.strictEqual(plan.contentType, 'application/vnd.verge-asset+cbor');
  const body = cbor.decode(plan.body);
  assert.strictEqual(body.t, 'FROG');
  assert.strictEqual(body.d, 2);
  assert.strictEqual(body.s, 1000000);
  assert.strictEqual(body.p, 100000);
  assert.deepStrictEqual(body.m, { a: 1000, c: 500, h0: 200, h1: 300 });
});

test('etch validation refuses what the indexer would silently drop', () => {
  const ok = { ticker: 'GOOD', supply: 1000, premine: 0 };
  const bad = [
    [{ ticker: 'has space' }, /ticker/],
    [{ ticker: 'TOOLONGTICKERNAMEFORTHEPROTOCOL' }, /ticker/],
    [{ divisibility: 9 }, /divisibility/],
    [{ supply: 0 }, /supply/],
    [{ premine: 99999 }, /premine/],
    [{ allowlistRoot: Buffer.alloc(31) }, /32 bytes/],
    [{ terms: { amount: 0 } }, /amount per mint/],
  ];
  for (const [patch, re] of bad) {
    assert.throws(() => buildEtch(Object.assign({}, ok, patch), { address: 'D1' }), re, JSON.stringify(patch));
  }
});

test('an open mint that premines the whole supply is refused (it could never mint)', () => {
  // exactly the mistake that made the regtest run fail the first time
  assert.throws(
    () => buildEtch({ ticker: 'FULL', supply: 1000, premine: 1000, terms: { amount: 10 } }, { address: 'D1' }),
    /can never mint/,
  );
});

console.log('\nassets builder: ' + passed + ' passed');
