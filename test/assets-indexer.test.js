// Verge Assets state machine (ASSETS-SPEC-v0 §12 test vectors).
// Run: node test/assets-indexer.test.js
const assert = require('assert');
const crypto = require('crypto');
const { AssetState, applyTx, index, assetRefOf, outpoint } = require('../src/assets/indexer');
const codec = require('../src/assets/codec');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

const DUST = 100000;
const out = (value = DUST, address = null) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false, address });
const opret = (payload) => ({ value: 0, isOpReturn: true, opReturnData: payload });

const ETCH = { ticker: 'FROG', name: 'Frog', divisibility: 2, supply: 1000000, premine: 100000 };
const REF = assetRefOf(100, 1);

/** A chain that etches FROG with a 100000-unit premine into tx "etch":0. */
function etched(extra = {}) {
  const state = new AssetState();
  applyTx(state, {
    txid: 'etch', height: 100, txIndex: 1, inputs: [],
    outputs: [out()],
    etching: Object.assign({}, ETCH, extra),
  });
  return state;
}

test('an etching registers the asset and premines to the first output', () => {
  const s = etched();
  assert.strictEqual(s.assets.get(REF).ticker, 'FROG');
  assert.strictEqual(s.balanceOf('etch:0', REF), 100000);
});

test('a duplicate ticker is ignored and does not overwrite the first', () => {
  const s = etched();
  applyTx(s, {
    txid: 'etch2', height: 101, txIndex: 0, inputs: [], outputs: [out()],
    etching: { ticker: 'FROG', supply: 5, premine: 5 },
  });
  assert.strictEqual(s.tickers.get('FROG'), REF);
  assert.strictEqual(s.assets.size, 1);
});

test('an invalid etching (bad ticker, premine over supply) is refused', () => {
  for (const bad of [{ ticker: 'lower case!' }, { premine: 999999999 }, { divisibility: 9 }]) {
    const s = new AssetState();
    applyTx(s, {
      txid: 't', height: 1, txIndex: 0, inputs: [], outputs: [out()],
      etching: Object.assign({}, ETCH, bad),
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

test('vector 8: a transfer that underpays a declared royalty does not move the asset', () => {
  const royalty = { bps: 500, address: 'DCREATOR' }; // 5%
  const s = etched({ royalty });
  const edicts = codec.encodeEdicts([{ assetRef: REF, amount: 100000, output: 1 }]);

  const underpaid = new AssetState();
  Object.assign(underpaid, s);
  applyTx(s, {
    txid: 'cheap', height: 101, txIndex: 0, saleValue: 1000000,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), out(10000, 'DCREATOR'), opret(edicts)], // owes 50000, paid 10000
  });
  // the edict is refused, so the balance falls through to the remainder output, still owned by the seller
  assert.strictEqual(s.balanceOf('cheap:1', REF), 0);

  const s2 = etched({ royalty });
  applyTx(s2, {
    txid: 'fair', height: 101, txIndex: 0, saleValue: 1000000,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), out(50000, 'DCREATOR'), opret(edicts)],
  });
  assert.strictEqual(s2.balanceOf('fair:1', REF), 100000);
});

test('a plain move with no declared sale is not blocked by a royalty', () => {
  const s = etched({ royalty: { bps: 500, address: 'DCREATOR' } });
  applyTx(s, {
    txid: 'gift', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 100000, output: 1 }]))],
  });
  assert.strictEqual(s.balanceOf('gift:1', REF), 100000);
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
  applyTx(s, {
    txid: 'etch2', height: 100, txIndex: 2, inputs: [], outputs: [out()],
    etching: { ticker: 'MOON', supply: 500, premine: 500 },
  });
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
    { txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()], etching: ETCH },
    { txid: 'm', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ assetRef: REF, amount: 40000, output: 1 }]))] },
  ];
  const a = [...index(txs).entries()];
  const b = [...index(txs).entries()];
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 2);
});

console.log('\nassets indexer: ' + passed + ' passed');
