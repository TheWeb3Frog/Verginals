// Scanner: the boundary between real chain data and the pure state machine (RUNES-PLAN §2.1).
// Run: node test/runes-scanner.test.js
const assert = require('assert');
const {
  ETCH_CONTENT_TYPE, readOpReturn, detectEtching, toIndexerTx, resolveFee, mintedRuneRef,
} = require('../src/runes/scanner');
const { buildEtch } = require('../src/runes/builder');
const { buildInscriptionScript } = require('../src/envelope');
const codec = require('../src/runes/codec');

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

test('a rune etching is recovered from a real inscription envelope', () => {
  const etch = buildEtch({ ticker: 'SCAN', name: 'Scanner', divisibility: 2, supply: 5000, premine: 1000 },
    { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.ok(found, 'nothing detected');
  assert.strictEqual(found.ticker, 'SCAN');
  assert.strictEqual(found.supply, 5000);
  assert.strictEqual(found.premine, 1000);
  assert.strictEqual(found.divisibility, 2);
});

test('mint terms and allowlist survive the round trip through the envelope', () => {
  const root = Buffer.alloc(32, 0x5a);
  const etch = buildEtch({
    ticker: 'RICH', supply: 100000, premine: 0,
    terms: { amount: 100, cap: 7, openHeight: 10, closeHeight: 20 },
    allowlistRoot: root,
  }, { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.deepStrictEqual(found.terms, { amount: 100, cap: 7, openHeight: 10, closeHeight: 20 });
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

test('a corrupt rune body is ignored rather than throwing', () => {
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

// §7.2 and §2.2: the fields the two prices ride in, and the fee an indexer has to compute itself
// because Verge Core will not hand it over.

const KEY = Buffer.from('02' + '11'.repeat(32), 'hex');

test('the price lock and the mint price survive the round trip through an inscription', () => {
  const etch = buildEtch({
    ticker: 'PRICED', supply: 100000, premine: 0,
    terms: { amount: 1000, price: 20 * 1e6 },
    lock: { locktime: 1700000000 + 126144000, pubkey: KEY },
  }, { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.strictEqual(found.terms.price, 20 * 1e6);
  assert.strictEqual(found.lock.t, 1700000000 + 126144000);
  assert.ok(found.lock.k.equals(KEY));
});

test('an unreadable mint price makes the whole etching unreadable', () => {
  // dropping it would quietly turn a priced mint into a free one, which is the expensive direction
  // to be wrong in
  const cbor = require('../src/cbor');
  const body = cbor.encode({ t: 'BADFEE', n: 'x', d: 0, s: 1000, p: 0, m: { a: 10, f: 'twenty' } });
  assert.strictEqual(detectEtching(revealTx(body, ETCH_CONTENT_TYPE)), null);
});

test('a name etched with separators comes back off the chain with them', () => {
  const B = '\u2022';
  const etch = buildEtch({ ticker: 'DOG' + B + 'GO' + B + 'TO' + B + 'THE' + B + 'MOON',
    supply: 1000, premine: 1000 }, { address: 'D1' });
  const found = detectEtching(revealTx(etch.body, etch.contentType));
  assert.strictEqual(found.ticker, 'DOGGOTOTHEMOON');
  assert.strictEqual(found.spacers, etch.spacers);
});

test('an unreadable separator mask is dropped rather than made fatal', () => {
  // it decides where a bullet is drawn, so it must never cost somebody the name they paid for
  const cbor = require('../src/cbor');
  const body = cbor.encode({ t: 'BADMASK', n: 'x', d: 0, s: 10, p: 10, x: 'lots' });
  const found = detectEtching(revealTx(body, ETCH_CONTENT_TYPE));
  assert.ok(found, 'the whole etching was thrown away over a display field');
  assert.strictEqual(found.ticker, 'BADMASK');
  assert.strictEqual(found.spacers, undefined);
});

test('the fee is what the inputs held minus what the outputs hold', async () => {
  const chain = {
    getRawTransaction: async (txid) => ({ vout: [{ value: 100 }, { value: 50 }] }),
  };
  const tx = { vin: [{ txid: 'a', vout: 0 }, { txid: 'b', vout: 1 }], vout: [{ value: 120 }] };
  assert.strictEqual(await resolveFee(chain, tx), Math.round(30 * 1e6));
});

test('an input nobody can resolve gives no fee at all, rather than a wrong one', async () => {
  const chain = { getRawTransaction: async () => { throw new Error('no txindex'); } };
  const tx = { vin: [{ txid: 'a', vout: 0 }], vout: [{ value: 1 }] };
  assert.strictEqual(await resolveFee(chain, tx), null);
  // and a coinbase, which has no previous output to look up, is not a fee payer either
  assert.strictEqual(await resolveFee(chain, { vin: [{ coinbase: 'ab' }], vout: [] }), null);
});

test('resolving a fee asks about each outpoint once, however often it comes back', async () => {
  let calls = 0;
  const chain = { getRawTransaction: async () => { calls += 1; return { vout: [{ value: 10 }] }; } };
  const cache = new Map();
  const tx = { vin: [{ txid: 'a', vout: 0 }], vout: [{ value: 9 }] };
  await resolveFee(chain, tx, cache);
  await resolveFee(chain, tx, cache);
  assert.strictEqual(calls, 1);
});

test('a mint is spotted from its OP_RETURN alone, so the fee lookup can be skipped otherwise', () => {
  const mint = { vout: [{ scriptPubKey: { hex: '6a' + Buffer.concat([
    Buffer.from([codec.encodeMint(131001).length]), codec.encodeMint(131001)]).toString('hex') } }] };
  assert.strictEqual(mintedRuneRef(mint), 131001);
  assert.strictEqual(mintedRuneRef({ vout: [{ scriptPubKey: { hex: '76a914' } }] }), null);
});

console.log('\nrunes scanner: ' + passed + ' passed');
