// Verge Assets state machine (ASSETS-SPEC-v0 §12 test vectors).
// Run: node test/assets-indexer.test.js
const assert = require('assert');
const crypto = require('crypto');
const { AssetState, applyTx, index, assetRefOf, outpoint } = require('../src/assets/indexer');
const codec = require('../src/assets/codec');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

const DUST = 100000;
const out = (value = DUST, address = null) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false, address });
const opret = (payload) => ({ value: 0, isOpReturn: true, opReturnData: payload });

const ETCH = { ticker: 'FROG', name: 'Frog', divisibility: 2, supply: 1000000, premine: 100000 };
const REF = assetRefOf(100, 1);

/**
 * An etching transaction that pays for its ticker (§7.2). The lock output sits AFTER the premine
 * output so the indices every other test asserts on do not move.
 */
function etchTx(txid, height, txIndex, etching) {
  const paid = lockFor(etching.ticker);
  return {
    txid, height, txIndex, inputs: [], time: paid.time,
    outputs: [out(), paid.output],
    etching: Object.assign({ lock: paid.lock }, etching),
  };
}

/** A chain that etches FROG with a 100000-unit premine into tx "etch":0. */
function etched(extra = {}) {
  const state = new AssetState();
  applyTx(state, etchTx('etch', 100, 1, Object.assign({}, ETCH, extra)));
  return state;
}

test('an etching registers the asset and premines to the first output', () => {
  const s = etched();
  assert.strictEqual(s.assets.get(REF).ticker, 'FROG');
  assert.strictEqual(s.balanceOf('etch:0', REF), 100000);
});

test('a duplicate ticker is ignored and does not overwrite the first', () => {
  const s = etched();
  applyTx(s, etchTx('etch2', 101, 0, { ticker: 'FROG', supply: 5, premine: 5 }));
  assert.strictEqual(s.tickers.get('FROG'), REF);
  assert.strictEqual(s.assets.size, 1);
});

test('an invalid etching (bad ticker, premine over supply) is refused', () => {
  for (const bad of [{ ticker: 'lower case!' }, { premine: 999999999 }, { divisibility: 9 }]) {
    const s = new AssetState();
    const etching = Object.assign({}, ETCH, bad);
    // A bad ticker cannot be priced, so it cannot be paid for either: pay FROG's price and let the
    // etching fail on its own merits rather than on a missing lock.
    const paid = lockFor('FROG');
    applyTx(s, {
      txid: 't', height: 1, txIndex: 0, inputs: [], time: paid.time,
      outputs: [out(), paid.output],
      etching: Object.assign({ lock: paid.lock }, etching),
    });
    assert.strictEqual(s.assets.size, 0, JSON.stringify(bad));
  }
});

test('an edict moves the stated amount and leaves the rest to the remainder output', () => {
  const s = etched();
  applyTx(s, {
    txid: 'move', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 30000, output: 1 }]))],
  });
  assert.strictEqual(s.balanceOf('move:1', REF), 30000);
  assert.strictEqual(s.balanceOf('move:0', REF), 70000); // remainder to the first eligible output
  assert.strictEqual(s.balanceOf('etch:0', REF), 0);     // the input was consumed
});

test('vector 3: amount 0 moves the entire pooled balance', () => {
  const s = etched();
  applyTx(s, {
    txid: 'all', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 0, output: 1 }]))],
  });
  assert.strictEqual(s.balanceOf('all:1', REF), 100000);
  assert.strictEqual(s.balanceOf('all:0', REF), 0);
});

test('vector 4: a plain send with no message moves the whole balance, it does not burn it', () => {
  const s = etched();
  applyTx(s, {
    txid: 'plain', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out()], // a protocol-unaware wallet
  });
  assert.strictEqual(s.balanceOf('plain:0', REF), 100000);
});

test('vector 6: a malformed message still leaves the balance intact via the default assignment', () => {
  const s = etched();
  applyTx(s, {
    txid: 'junk', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), opret(Buffer.from('not a protocol message'))],
  });
  assert.strictEqual(s.balanceOf('junk:0', REF), 100000);
});

test('vector 5: with no eligible output the balance is burned', () => {
  const s = etched();
  applyTx(s, {
    txid: 'burn', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [opret(Buffer.from('x'))], // OP_RETURN only
  });
  assert.strictEqual(s.balanceOf('burn:0', REF), 0);
  let total = 0;
  for (const e of s.entries()) total += e.amount;
  assert.strictEqual(total, 0);
});

test('a dust output cannot receive a balance', () => {
  const s = etched();
  applyTx(s, {
    txid: 'dusty', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(DUST - 1), out(DUST), opret(codec.encodeEdicts([{ assetRef: REF, amount: 5, output: 0 }]))],
  });
  assert.strictEqual(s.balanceOf('dusty:0', REF), 0);   // refused: below dust
  assert.strictEqual(s.balanceOf('dusty:1', REF), 100000); // all of it lands on the eligible output
});

test('an edict cannot conjure more than the inputs carried', () => {
  const s = etched();
  applyTx(s, {
    txid: 'greedy', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 999999999, output: 1 }]))],
  });
  assert.strictEqual(s.balanceOf('greedy:1', REF), 100000); // capped at what was available
});

test('vector 7: a mint is refused past its close height and once the cap is reached', () => {
  const terms = { amount: 1000, cap: 2, openHeight: 200, closeHeight: 300 };
  const mint = (state, height, txid) => applyTx(state, {
    txid, height, txIndex: 0, inputs: [], outputs: [out(), opret(codec.encodeMint(REF))],
  });

  const early = etched({ terms }); mint(early, 199, 'a');
  assert.strictEqual(early.balanceOf('a:0', REF), 0, 'minted before the window opened');

  const late = etched({ terms }); mint(late, 301, 'b');
  assert.strictEqual(late.balanceOf('b:0', REF), 0, 'minted after the window closed');

  const ok = etched({ terms });
  mint(ok, 250, 'c'); mint(ok, 251, 'd'); mint(ok, 252, 'e'); // third exceeds cap 2
  assert.strictEqual(ok.balanceOf('c:0', REF), 1000);
  assert.strictEqual(ok.balanceOf('d:0', REF), 1000);
  assert.strictEqual(ok.balanceOf('e:0', REF), 0);
  assert.strictEqual(ok.assets.get(REF).mintCount, 2);
});

test('a mint cannot push the asset past its supply cap', () => {
  const s = etched({ supply: 101000, premine: 100000, terms: { amount: 1000 } });
  applyTx(s, { txid: 'm1', height: 200, txIndex: 0, inputs: [], outputs: [out(), opret(codec.encodeMint(REF))] });
  applyTx(s, { txid: 'm2', height: 201, txIndex: 0, inputs: [], outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m1:0', REF), 1000);
  assert.strictEqual(s.balanceOf('m2:0', REF), 0); // would exceed supply
});

// §2.2: the mint price is a transaction FEE, which is the only price on this protocol that reaches
// anyone at all. It reaches the miner, exactly like every other fee, so there is still no
// beneficiary written into the rules.
const PRICE = 20 * 1e6;

test('a mint that pays the price the etcher set is credited', () => {
  const s = etched({ premine: 0, terms: { amount: 1000, price: PRICE } });
  applyTx(s, { txid: 'm', height: 200, txIndex: 0, inputs: [], fee: PRICE,
    outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m:0', REF), 1000);
});

test('a mint that underpays by one unit mints nothing', () => {
  const s = etched({ premine: 0, terms: { amount: 1000, price: PRICE } });
  applyTx(s, { txid: 'm', height: 200, txIndex: 0, inputs: [], fee: PRICE - 1,
    outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m:0', REF), 0);
  assert.strictEqual(s.assets.get(REF).minted, 0);
});

test('paying the relay minimum instead of the price mints nothing', () => {
  // the failure this rule exists to prevent: an ordinary wallet funds the transaction the ordinary
  // way, pays 0.1 XVG, and takes the whole supply for the price of the network fees
  const s = etched({ premine: 0, terms: { amount: 1000, price: PRICE } });
  applyTx(s, { txid: 'm', height: 200, txIndex: 0, inputs: [], fee: 100000,
    outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m:0', REF), 0);
});

test('overpaying is fine, and the miner keeps the difference', () => {
  const s = etched({ premine: 0, terms: { amount: 1000, price: PRICE } });
  applyTx(s, { txid: 'm', height: 200, txIndex: 0, inputs: [], fee: PRICE * 4,
    outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m:0', REF), 1000);
});

test('a fee the indexer could not resolve fails closed', () => {
  // two indexers reading the same chain must agree, so an unknown fee has to be refused rather
  // than waved through: one node with txindex and one without would otherwise disagree on balances
  const s = etched({ premine: 0, terms: { amount: 1000, price: PRICE } });
  for (const fee of [null, undefined, NaN, 'lots']) {
    applyTx(s, { txid: 'm' + String(fee), height: 200, txIndex: 0, inputs: [], fee,
      outputs: [out(), opret(codec.encodeMint(REF))] });
  }
  assert.strictEqual(s.assets.get(REF).minted, 0);
});

test('an asset that charges nothing per mint does not need a fee at all', () => {
  const s = etched({ premine: 0, terms: { amount: 1000 } });
  applyTx(s, { txid: 'm', height: 200, txIndex: 0, inputs: [],
    outputs: [out(), opret(codec.encodeMint(REF))] });
  assert.strictEqual(s.balanceOf('m:0', REF), 1000);
});

// §7.2: paying for the ticker is what makes an allocation valid, so this is tested here as well as
// in assets-tickers.test.js, where the lock itself is picked apart.
test('an etching that never locked the price does not take the ticker', () => {
  const s = new AssetState();
  applyTx(s, { txid: 'free', height: 100, txIndex: 1, inputs: [], time: 1700000000,
    outputs: [out()], etching: ETCH });
  assert.strictEqual(s.assets.size, 0);
  assert.strictEqual(s.tickers.size, 0);
  // and the name is still there for whoever does pay for it
  applyTx(s, etchTx('paid', 101, 1, ETCH));
  assert.strictEqual(s.tickers.get('FROG'), assetRefOf(101, 1));
});

// §7.1: a separator is display only, so it buys no namespace. This is the property that keeps the
// price schedule meaningful, and it belongs here rather than in a rendering test.
test('re-spacing a name does not buy a second one', () => {
  const s = new AssetState();
  applyTx(s, etchTx('a', 100, 1, { ticker: 'DOGGOTOTHEMOON', spacers: 0b1010100, supply: 1000, premine: 1000 }));
  assert.strictEqual(s.tickers.get('DOGGOTOTHEMOON'), assetRefOf(100, 1));

  // the same letters spaced differently, then not spaced at all
  applyTx(s, etchTx('b', 101, 1, { ticker: 'DOGGOTOTHEMOON', spacers: 0b110, supply: 1000, premine: 1000 }));
  applyTx(s, etchTx('c', 102, 1, { ticker: 'DOGGOTOTHEMOON', supply: 1000, premine: 1000 }));
  assert.strictEqual(s.assets.size, 1, 'a separator bought a second asset');
  assert.strictEqual(s.tickers.size, 1);
  assert.strictEqual(s.tickers.get('DOGGOTOTHEMOON'), assetRefOf(100, 1), 'the first etcher lost the name');
});

test('the mask is normalised at indexing time, so every indexer draws the same name', () => {
  const s = new AssetState();
  // bits past the end of a 3-character name have no gap to sit in
  applyTx(s, etchTx('x', 100, 1, { ticker: 'ABC', spacers: 0b11111111, supply: 10, premine: 10 }));
  assert.strictEqual(s.assets.get(assetRefOf(100, 1)).spacers, 0b11);
});

// §6: an etch has no owner, so nothing about a registered asset can be revised after the fact. There
// is no update message to test against, which is the point; what can be tested is that a later
// etching cannot reach an existing one (above) and that an unrecognised field is ignored rather than
// taken as an instruction.
test('a field the protocol does not define is ignored, and the asset registers anyway', () => {
  const s = etched({ owner: 'DSOMEONE', mutable: true });
  const asset = s.assets.get(REF);
  assert.strictEqual(asset.ticker, 'FROG');
  assert.strictEqual(asset.owner, undefined);
  assert.strictEqual(asset.mutable, undefined);
});

test('an allowlisted mint needs a valid proof from a spent input', () => {
  const spk = Buffer.from('76a914deadbeef88ac', 'hex');
  const leaf = sha256(Buffer.concat([spk, Buffer.from('5000')]));
  const sibling = sha256(Buffer.from('other'));
  const root = Buffer.compare(leaf, sibling) <= 0
    ? sha256(Buffer.concat([leaf, sibling])) : sha256(Buffer.concat([sibling, leaf]));
  const base = { terms: { amount: 1000 }, allowlistRoot: root };

  const ok = etched(base);
  applyTx(ok, {
    txid: 'wl', height: 200, txIndex: 0,
    inputs: [{ txid: 'x', vout: 0, scriptPubKey: spk }],
    outputs: [out(), opret(codec.encodeMint(REF))],
    allowlistProof: { scriptPubKey: spk, maxAmount: 5000, path: [sibling] },
  });
  assert.strictEqual(ok.balanceOf('wl:0', REF), 1000);

  const noProof = etched(base);
  applyTx(noProof, {
    txid: 'nope', height: 200, txIndex: 0,
    inputs: [{ txid: 'x', vout: 0, scriptPubKey: spk }],
    outputs: [out(), opret(codec.encodeMint(REF))],
  });
  assert.strictEqual(noProof.balanceOf('nope:0', REF), 0);

  const tampered = etched(base);
  applyTx(tampered, {
    txid: 'bad', height: 200, txIndex: 0,
    inputs: [{ txid: 'x', vout: 0, scriptPubKey: spk }],
    outputs: [out(), opret(codec.encodeMint(REF))],
    allowlistProof: { scriptPubKey: spk, maxAmount: 5000, path: [sha256(Buffer.from('wrong'))] },
  });
  assert.strictEqual(tampered.balanceOf('bad:0', REF), 0);
});

test('one output can hold several different assets at once', () => {
  const s = etched();
  applyTx(s, etchTx('etch2', 100, 2, { ticker: 'MOON', supply: 500, premine: 500 }));
  const REF2 = assetRefOf(100, 2);
  applyTx(s, {
    txid: 'merge', height: 102, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }, { txid: 'etch2', vout: 0 }],
    outputs: [out()],
  });
  assert.strictEqual(s.balanceOf('merge:0', REF), 100000);
  assert.strictEqual(s.balanceOf('merge:0', REF2), 500);
});

test('indexing is deterministic: the same blocks always give the same state', () => {
  const txs = [
    etchTx('e', 100, 1, ETCH),
    { txid: 'm', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 40000, output: 1 }]))] },
  ];
  const a = [...index(txs).entries()];
  const b = [...index(txs).entries()];
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 2);
});

console.log('\nassets indexer: ' + passed + ' passed');
