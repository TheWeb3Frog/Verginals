// Scanner: the boundary between real chain data and the pure state machine (ASSETS-PLAN §2.1).
// Run: node test/assets-scanner.test.js
const assert = require('assert');
const { ETCH_CONTENT_TYPE, readOpReturn, detectEtching, toIndexerTx } = require('../src/assets/scanner');
const { buildEtch } = require('../src/assets/builder');
const { buildInscriptionScript } = require('../src/envelope');
const codec = require('../src/assets/codec');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

/** A scriptSig that pushes `redeem` as its last element, the way a P2SH spend reveals it. */
function scriptSigPushing(redeem) {
  const parts = [];
  if (redeem.length <= 75) parts.push(Buffer.from([redeem.length]));
  else if (redeem.length <= 255) parts.push(Buffer.from([0x4c, redeem.length]));
  else parts.push(Buffer.from([0x4d, redeem.length & 0xff, redeem.length >> 8]));
  return { hex: Buffer.concat([...parts, redeem]).toString('hex') };
}

/** A reveal-shaped tx carrying an inscription of `body` with `contentType`. */
function revealTx(body, contentType, key = Buffer.alloc(33, 2)) {
  const redeem = buildInscriptionScript({ pubkey: key, contentType: Buffer.from(contentType), body });
  return { txid: 'reveal', vin: [{ txid: 'prev', vout: 0, scriptSig: scriptSigPushing(redeem) }], vout: [] };
}

test('an asset etching is recovered from a real inscription envelope', () => {
  const etch = buildEtch({ ticker: 'SCAN', name: 'Scanner', divisibility: 2, supply: 5000, premine: 1000 },
    { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.ok(found, 'nothing detected');
  assert.strictEqual(found.ticker, 'SCAN');
  assert.strictEqual(found.supply, 5000);
  assert.strictEqual(found.premine, 1000);
  assert.strictEqual(found.divisibility, 2);
});

test('mint terms, royalty and allowlist survive the round trip through the envelope', () => {
  const root = Buffer.alloc(32, 0x5a);
  const etch = buildEtch({
    ticker: 'RICH', supply: 100000, premine: 0,
    terms: { amount: 100, cap: 7, openHeight: 10, closeHeight: 20 },
    royalty: { bps: 250, address: 'DPAYEE' },
    allowlistRoot: root,
  }, { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.deepStrictEqual(found.terms, { amount: 100, cap: 7, openHeight: 10, closeHeight: 20 });
  assert.deepStrictEqual(found.royalty, { bps: 250, address: 'DPAYEE' });
  assert.ok(Buffer.from(found.allowlistRoot).equals(root));
});

test('an inscription of some other content type is not an etching', () => {
  const found = detectEtching(revealTx(Buffer.from('hello'), 'image/webp'));
  assert.strictEqual(found, null);
});

test('a transaction with no inscription at all yields no etching', () => {
  assert.strictEqual(detectEtching({ vin: [{ txid: 'a', vout: 0, scriptSig: { hex: '00' } }] }), null);
  assert.strictEqual(detectEtching({ vin: [] }), null);
  assert.strictEqual(detectEtching({}), null);
});

test('a corrupt asset body is ignored rather than throwing', () => {
  const found = detectEtching(revealTx(Buffer.from([0xff, 0xff, 0xff]), ETCH_CONTENT_TYPE));
  assert.strictEqual(found, null); // unreadable CBOR must never be fatal
});

test('toIndexerTx discovers the etching without being told about it', () => {
  const etch = buildEtch({ ticker: 'AUTO', supply: 10, premine: 10 }, { address: 'D1' });
  const tx = revealTx(etch.body, etch.contentType);
  tx.vout = [{ value: 0.1, scriptPubKey: { hex: '76a900', addresses: ['D1'] } }];
  const out = toIndexerTx(tx, 500, 3);
  assert.ok(out.etching, 'etching not attached');
  assert.strictEqual(out.etching.ticker, 'AUTO');
  assert.strictEqual(out.height, 500);
  assert.strictEqual(out.txIndex, 3);
});

test('an etching supplied by the caller wins over one found in the transaction', () => {
  const etch = buildEtch({ ticker: 'ONCHAIN', supply: 10, premine: 10 }, { address: 'D1' });
  const tx = revealTx(etch.body, etch.contentType);
  tx.vout = [];
  const out = toIndexerTx(tx, 1, 0, { etching: { ticker: 'OVERRIDE', supply: 1, premine: 1 } });
  assert.strictEqual(out.etching.ticker, 'OVERRIDE');
});

test('OP_RETURN payloads are read back for both push forms', () => {
  const small = codec.encodeMint(131001);
  const direct = readOpReturn({ scriptPubKey: { hex: '6a' + small.length.toString(16).padStart(2, '0') + small.toString('hex') } });
  assert.ok(direct.equals(small));

  const big = codec.encodeCheckpoint(1, Buffer.alloc(32, 7)); // > 75 bytes, needs OP_PUSHDATA1
  const pushdata = readOpReturn({ scriptPubKey: { hex: '6a4c' + big.length.toString(16).padStart(2, '0') + big.toString('hex') } });
  assert.ok(pushdata.equals(big));
});

test('a non-OP_RETURN output reads as null, not as an empty message', () => {
  assert.strictEqual(readOpReturn({ scriptPubKey: { hex: '76a914aabb88ac' } }), null);
  assert.strictEqual(readOpReturn({}), null);
});

test('values convert to atomic units and a single-address output keeps its address', () => {
  const tx = { txid: 't', vin: [], vout: [{ value: 1.5, scriptPubKey: { hex: '76a900', addresses: ['DX'] } }] };
  const out = toIndexerTx(tx, 1, 0);
  assert.strictEqual(out.outputs[0].value, 1500000);
  assert.strictEqual(out.outputs[0].address, 'DX');
});

test('a coinbase input is dropped rather than treated as a spend', () => {
  const tx = { txid: 'cb', vin: [{ coinbase: 'abcd' }], vout: [] };
  assert.deepStrictEqual(toIndexerTx(tx, 1, 0).inputs, []);
});

console.log('\nassets scanner: ' + passed + ' passed');
