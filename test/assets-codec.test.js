// Verge Assets wire format (ASSETS-SPEC-v0 §4 and §12 test vectors).
// Run: node test/assets-codec.test.js
const assert = require('assert');
const {
  MAX_PAYLOAD, MIN_ASSET_REF, encodeVarint, readVarint,
  encodeEdicts, encodeMint, encodeCheckpoint, decode, fits,
} = require('../src/assets/codec');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

test('varints round-trip across byte boundaries', () => {
  for (const n of [0, 1, 127, 128, 255, 16383, 16384, 1e6, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const enc = encodeVarint(n);
    const dec = readVarint(enc, 0);
    assert.strictEqual(dec.value, n, 'failed at ' + n);
    assert.strictEqual(dec.next, enc.length);
  }
});

test('a truncated varint decodes to null instead of throwing', () => {
  assert.strictEqual(readVarint(Buffer.from([0x80]), 0), null); // continuation bit, no next byte
  assert.strictEqual(readVarint(Buffer.from([]), 0), null);
});

test('vector 1: a single edict round-trips', () => {
  const msg = decode(encodeEdicts([{ assetRef: 100, amount: 500, output: 1 }]));
  assert.strictEqual(msg.type, 'edicts');
  assert.deepStrictEqual(msg.edicts, [{ assetRef: 100, amount: 500, output: 1 }]);
});

test('vector 2: three ascending references are delta-encoded and decode as absolute', () => {
  const edicts = [
    { assetRef: 1000, amount: 1, output: 0 },
    { assetRef: 1005, amount: 2, output: 1 },
    { assetRef: 1200, amount: 3, output: 2 },
  ];
  const enc = encodeEdicts(edicts);
  assert.deepStrictEqual(decode(enc).edicts, edicts);
  // deltas (1000, 5, 195) must be cheaper than three absolute references
  const absolute = edicts.reduce((s, e) => s + encodeVarint(e.assetRef).length, 0);
  const deltas = encodeVarint(1000).length + encodeVarint(5).length + encodeVarint(195).length;
  assert.ok(deltas < absolute);
});

test('edicts are sorted by asset reference regardless of input order', () => {
  const msg = decode(encodeEdicts([
    { assetRef: 300, amount: 1, output: 0 },
    { assetRef: 100, amount: 2, output: 1 },
  ]));
  assert.deepStrictEqual(msg.edicts.map((e) => e.assetRef), [100, 300]);
});

test('vector 3: amount 0 survives the round-trip (it means "all of it")', () => {
  const msg = decode(encodeEdicts([{ assetRef: 7, amount: 0, output: 0 }]));
  assert.strictEqual(msg.edicts[0].amount, 0);
});

test('vector 1b: the maximum batch that fits is accepted, one more is refused', () => {
  const batch = [];
  for (let i = 0; i < 100; i++) {
    batch.push({ assetRef: 1000 + i, amount: 1, output: 0 });
    if (!fits(batch)) { batch.pop(); break; }
  }
  assert.ok(batch.length >= 8, 'expected at least 8 edicts to fit, got ' + batch.length);
  const enc = encodeEdicts(batch);
  assert.ok(enc.length <= MAX_PAYLOAD);
  assert.strictEqual(decode(enc).edicts.length, batch.length);
  assert.throws(() => encodeEdicts(batch.concat([{ assetRef: 99999, amount: 1, output: 0 }])));
});

test('a mint message round-trips, with and without an allowlist proof', () => {
  assert.deepStrictEqual(decode(encodeMint(42)), { type: 'mint', assetRef: 42, proofIndex: null });
  assert.deepStrictEqual(decode(encodeMint(42, 7)), { type: 'mint', assetRef: 42, proofIndex: 7 });
});

test('a checkpoint message round-trips its height and 32-byte root', () => {
  const root = Buffer.alloc(32, 0xab);
  const msg = decode(encodeCheckpoint(9363580, root));
  assert.strictEqual(msg.type, 'checkpoint');
  assert.strictEqual(msg.height, 9363580);
  assert.ok(msg.root.equals(root));
  assert.throws(() => encodeCheckpoint(1, Buffer.alloc(31)));
});

test('vector 6: hostile input decodes to null, never throws', () => {
  const cases = [
    null, undefined, Buffer.alloc(0), Buffer.from('hello'),
    Buffer.from([0x56, 0x41]),                       // header only
    Buffer.from([0x56, 0x41, 0x99, 0x01]),           // unknown version
    Buffer.from([0x00, 0x00, 0x00, 0x01]),           // wrong magic
    Buffer.from([0x56, 0x41, 0x00, 0x80]),           // truncated varint
    Buffer.from([0x56, 0x41, 0x00, 0x05, 0x01, 0x00]), // edict missing its flags
    Buffer.alloc(MAX_PAYLOAD + 1, 0x56),             // over the OP_RETURN limit
  ];
  for (const c of cases) assert.strictEqual(decode(c), null, 'should be null: ' + c);
});

test('reserved flag bits invalidate the whole message', () => {
  const good = encodeEdicts([{ assetRef: 10, amount: 1, output: 0 }]);
  const bad = Buffer.from(good);
  bad[bad.length - 1] = 3; // flags = 3 sets a reserved bit
  assert.strictEqual(decode(bad), null);
});

test('trailing bytes after the terminator invalidate the message', () => {
  const enc = encodeEdicts([{ assetRef: 10, amount: 1, output: 0 }]);
  assert.strictEqual(decode(Buffer.concat([enc, Buffer.from([0x00])])), null);
});

test('every encoded message stays inside the OP_RETURN limit', () => {
  assert.ok(encodeMint(2 ** 32).length <= MAX_PAYLOAD);
  assert.ok(encodeCheckpoint(2 ** 32, Buffer.alloc(32)).length <= MAX_PAYLOAD);
});

test('reserved low asset references cannot be encoded (they would decode as a control message)', () => {
  // assetRef 1 would emit a leading 0x01 and be mis-read as a mint, 2 as a checkpoint
  assert.throws(() => encodeEdicts([{ assetRef: 1, amount: 5, output: 0 }]), /reserved/);
  assert.throws(() => encodeEdicts([{ assetRef: 2, amount: 5, output: 0 }]), /reserved/);
  // the first valid reference encodes and decodes as an edict stream, not as a control message
  assert.strictEqual(decode(encodeEdicts([{ assetRef: MIN_ASSET_REF, amount: 5, output: 0 }])).type, 'edicts');
});

test('negative or fractional values are rejected at encode time', () => {
  assert.throws(() => encodeVarint(-1));
  assert.throws(() => encodeVarint(1.5));
  assert.throws(() => encodeEdicts([{ assetRef: -1, amount: 1, output: 0 }]));
  assert.throws(() => encodeEdicts([]));
});

console.log('\nassets codec: ' + passed + ' passed');
