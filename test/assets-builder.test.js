// Asset transaction builders (ASSETS-PLAN §2.2).
// The ordering rules matter most: edicts address outputs by index, so a builder that reorders
// outputs sends someone's balance to the wrong recipient.
// Run: node test/assets-builder.test.js
const assert = require('assert');
const { DUST_UNITS, buildTransfer, buildMint, buildCheckpoint, buildEtch } = require('../src/assets/builder');
const codec = require('../src/assets/codec');
const cbor = require('../src/cbor');
const {
  priceOf, LOCK_SECONDS, lockRedeemScript, p2shScriptPubKey, MAX_MINT_PRICE, ABSURD_FEE_UNITS,
} = require('../src/assets/tickers');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const REF = 131001;
const KEY = Buffer.from('02' + '11'.repeat(32), 'hex');
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

// §7.2 and §2.2: the two prices. One is locked in this transaction, the other is charged per mint
// and never appears as an output at all.

test('an etch pays its ticker price into a lock output of its own transaction', () => {
  const lock = { locktime: 1700000000 + LOCK_SECONDS, pubkey: KEY };
  const p = buildEtch({ ticker: 'FROG', supply: 1000, premine: 1000, lock }, { address: 'D1' });
  assert.strictEqual(p.price, priceOf('FROG'));
  const paid = p.outputs.find((o) => o.isPriceLock);
  assert.ok(paid, 'no lock output');
  assert.strictEqual(paid.value, priceOf('FROG'));
  assert.ok(paid.scriptPubKey.equals(p2shScriptPubKey(lockRedeemScript(lock.locktime, KEY))));
  // and the premine output is still first, so nothing an edict could point at moved
  assert.strictEqual(p.premineOutput, 0);
  assert.strictEqual(p.outputs[0].address, 'D1');
});

test('the etching publishes the two numbers a recovery tool needs, and nothing else', () => {
  const lock = { locktime: 1700000000 + LOCK_SECONDS, pubkey: KEY };
  const p = buildEtch({ ticker: 'FROG', supply: 1000, premine: 1000, lock }, { address: 'D1' });
  const body = cbor.decode(p.body);
  assert.strictEqual(body.l.t, lock.locktime);
  assert.ok(Buffer.from(Object.values(body.l.k)).equals(KEY));
});

test('a mint price rides in the terms and is charged as a fee, not an output', () => {
  const lock = { locktime: 1700000000 + LOCK_SECONDS, pubkey: KEY };
  const p = buildEtch({
    ticker: 'FROG', supply: 100000, premine: 0, lock,
    terms: { amount: 1000, price: 20 * 1e6 },
  }, { address: 'D1' });
  assert.strictEqual(cbor.decode(p.body).m.f, 20 * 1e6);

  const m = buildMint(100001, { address: 'D2' }, { mintPrice: 20 * 1e6 });
  assert.strictEqual(m.mintPrice, 20 * 1e6);
  // nothing in the plan holds the price: the caller has to leave it behind as fee
  const paid = m.outputs.reduce((sum, o) => sum + (o.value || 0), 0);
  assert.ok(paid < 20 * 1e6, 'the price leaked into an output');
});

// §7.1: separators are display only. These are end to end through the builder, because the
// helpers in tickers.js were correct for months while nothing called them.

test('a name typed with separators etches as the bare name plus a mask', () => {
  const B = '\u2022';
  const p = buildEtch({ ticker: 'DOG' + B + 'GO' + B + 'TO' + B + 'THE' + B + 'MOON', supply: 1000, premine: 1000 },
    { address: 'D1' });
  assert.strictEqual(p.ticker, 'DOGGOTOTHEMOON');            // the identity is bare
  assert.strictEqual(p.display, 'DOG' + B + 'GO' + B + 'TO' + B + 'THE' + B + 'MOON');
  assert.strictEqual(cbor.decode(p.body).t, 'DOGGOTOTHEMOON');
  assert.strictEqual(cbor.decode(p.body).x, p.spacers);
  assert.ok(p.spacers > 0, 'the mask never reached the etching');
});

test('separators cost nothing: the price follows the bare length', () => {
  const B = '\u2022';
  const spaced = buildEtch({ ticker: 'GR' + B + 'UM' + B + 'PY', supply: 1000, premine: 1000 }, { address: 'D1' });
  const bare = buildEtch({ ticker: 'GRUMPY', supply: 1000, premine: 1000 }, { address: 'D1' });
  assert.strictEqual(spaced.price, bare.price);
  assert.strictEqual(spaced.price, priceOf('GRUMPY'));
  assert.strictEqual(spaced.ticker, bare.ticker);
});

test('a full length name survives its separators', () => {
  // the boundary the interface got wrong: 26 real characters plus separators is a legal name, and
  // counting the separators against the limit silently eats a real letter for each one
  const B = '\u2022';
  const typed = 'MY' + B + 'VERY' + B + 'LONG' + B + 'HONEST' + B + 'PROJEC' + B + 'NAME';
  const p = buildEtch({ ticker: typed, supply: 10, premine: 10 }, { address: 'D1' });
  assert.strictEqual(p.ticker.length, 26);
  assert.strictEqual(p.ticker, 'MYVERYLONGHONESTPROJECNAME');
  assert.strictEqual(p.display, typed);
  // and the limit is still 26 REAL characters, counted without them
  assert.throws(() => buildEtch({ ticker: 'A' + B + 'A'.repeat(26), supply: 10, premine: 10 },
    { address: 'D1' }), /1\.\.26/);
});

test('a mask can be given directly instead of typing separators', () => {
  const p = buildEtch({ ticker: 'ABC', spacers: 0b11, supply: 10, premine: 10 }, { address: 'D1' });
  assert.strictEqual(p.display, 'A\u2022B\u2022C');
  assert.strictEqual(cbor.decode(p.body).x, 0b11);
});

test('a name with no separators carries no mask at all', () => {
  const p = buildEtch({ ticker: 'PLAIN', supply: 10, premine: 10 }, { address: 'D1' });
  assert.strictEqual(p.spacers, 0);
  assert.strictEqual(cbor.decode(p.body).x, undefined, 'an empty field is still bytes on chain');
});

test('separators that cannot be rendered are dropped, never fatal', () => {
  const B = '\u2022';
  // leading, trailing and doubled: an etching is paid for and permanent, so none of these may
  // destroy it over where a bullet goes
  for (const typed of [B + 'ABC', 'ABC' + B, 'A' + B + B + 'BC', B + B + 'A' + B + B + 'BC' + B]) {
    const p = buildEtch({ ticker: typed, supply: 10, premine: 10 }, { address: 'D1' });
    assert.strictEqual(p.ticker, 'ABC', JSON.stringify(typed));
    assert.strictEqual(p.display, typed.replace(new RegExp(B + '+', 'g'), B).replace(new RegExp('^' + B + '|' + B + '$', 'g'), ''),
      JSON.stringify(typed));
  }
});

test('a mint price above what a node will relay is refused at etch time', () => {
  // measured on regtest: Verge Core refuses any ABSOLUTE fee over 50 XVG, so a higher price would
  // etch an asset nobody could mint with an ordinary wallet, permanently
  const lock = { locktime: 1700000000 + LOCK_SECONDS, pubkey: KEY };
  const etchAt = (price) => buildEtch({
    ticker: 'FROG', supply: 100000, premine: 0, lock, terms: { amount: 1000, price },
  }, { address: 'D1' });
  assert.doesNotThrow(() => etchAt(MAX_MINT_PRICE));
  assert.throws(() => etchAt(MAX_MINT_PRICE + 1), /ordinary wallet/);
  assert.throws(() => etchAt(ABSURD_FEE_UNITS), /ordinary wallet/);
  // the headroom is for the relay fee that stacks on top of the price
  assert.ok(MAX_MINT_PRICE < ABSURD_FEE_UNITS);
});

test('a fractional or negative price is refused before it can be etched forever', () => {
  const lock = { locktime: 1700000000 + LOCK_SECONDS, pubkey: KEY };
  // atomic units are whole by definition, so half a unit is not a price, it is a typo
  for (const price of [-1, 0.5, 20 * 1e6 + 0.5, Infinity]) {
    assert.throws(() => buildEtch({
      ticker: 'FROG', supply: 100000, premine: 0, lock, terms: { amount: 1000, price },
    }, { address: 'D1' }), /whole number/, String(price));
  }
});

console.log('\nassets builder: ' + passed + ' passed');
