// CBOR codec tests: known-vector encoding + round-trips. Run: node test/cbor.test.js
const assert = require('assert');
const { encode, decode } = require('../src/cbor');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const hex = (b) => Buffer.from(b).toString('hex');

test('encodes RFC 8949 known vectors', () => {
  assert.strictEqual(hex(encode(0)), '00');
  assert.strictEqual(hex(encode(23)), '17');
  assert.strictEqual(hex(encode(24)), '1818');
  assert.strictEqual(hex(encode(1000)), '1903e8');
  assert.strictEqual(hex(encode('a')), '6161');
  assert.strictEqual(hex(encode([1, 2, 3])), '83010203');
});

test('encodes small string-keyed maps', () => {
  assert.strictEqual(hex(encode({ a: 1 })), 'a1616101');
  assert.strictEqual(hex(encode({ a: 1, b: [2, 3] })), 'a26161016162820203');
});

test('round-trips a realistic trait object', () => {
  const meta = {
    name: 'Verginals #123',
    collection: 'Alpha Verginals',
    attributes: [
      { trait_type: 'House', value: 'Fire' },
      { trait_type: 'Rune', value: 'Ember' },
    ],
  };
  const decoded = decode(encode(meta));
  assert.deepStrictEqual(decoded, meta);
});

test('round-trips values spanning each length encoding', () => {
  for (const s of ['', 'x', 'y'.repeat(23), 'z'.repeat(24), 'w'.repeat(300)]) {
    assert.strictEqual(decode(encode(s)), s);
  }
  for (const n of [0, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296]) {
    assert.strictEqual(decode(encode(n)), n);
  }
});

test('rejects unsupported inputs', () => {
  assert.throws(() => encode(-1), /non-negative/);
  assert.throws(() => encode(1.5), /non-negative/);
  assert.throws(() => encode(null), /unsupported/);
  assert.throws(() => decode(Buffer.from('0000', 'hex')), /trailing/);
});

console.log(`cbor: ${passed} tests passed`);
