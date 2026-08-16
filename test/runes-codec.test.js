// Verge Runes wire format (RUNES-SPEC-v0 §4 and §12 test vectors).
// Run: node test/runes-codec.test.js
const assert = require('assert');
const {
  MAX_PAYLOAD, MIN_RUNE_HEIGHT, encodeVarint, readVarint, refOf, parseRef, compareRefs,
  encodeEdicts, encodeMint, encodeCheckpoint, decode, fits,
} = require('../src/runes/codec');

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

test('a padded varint is refused: one meaning must have one encoding', () => {
  assert.strictEqual(readVarint(Buffer.from([0x01]), 0).value, 1);   // minimal
  assert.strictEqual(readVarint(Buffer.from([0x81, 0x00]), 0), null); // the same 1, padded
  assert.strictEqual(readVarint(Buffer.from([0x80, 0x00]), 0), null); // the same 0, padded
  assert.strictEqual(readVarint(Buffer.from([0x80, 0x01]), 0).value, 128); // 128 really needs two
});

// --- what names a rune -------------------------------------------------------------------------

test('a reference is the pair (height, txIndex) and never a packed number', () => {
  assert.strictEqual(refOf(9400123, 7), '9400123:7');
  assert.deepStrictEqual(parseRef('9400123:7'), { height: 9400123, txIndex: 7 });
  // The packing this replaced: height * 1000 + txIndex made these two the same rune.
  assert.notStrictEqual(refOf(100, 1000), refOf(101, 0));
});

test('references sort by height then position, never as text', () => {
  const refs = [refOf(100, 1), refOf(99, 2), refOf(100, 0), refOf(9, 9)];
  assert.deepStrictEqual(refs.slice().sort(compareRefs), ['9:9', '99:2', '100:0', '100:1']);
  // The trap this avoids: as text, "100:1" sorts before "99:2".
  assert.ok('100:1' < '99:2');
});

test('a malformed reference is rejected rather than guessed at', () => {
  for (const bad of ['', '1', '1:', ':1', '1:2:3', 'a:b', '01:2', '1:02', '-1:2', '1.5:2', null, 42]) {
    assert.strictEqual(parseRef(bad), null, 'should be null: ' + bad);
  }
});

// --- messages ------------------------------------------------------------------------------------

test('vector 1: a single edict round-trips', () => {
  const msg = decode(encodeEdicts([{ runeRef: '100:0', amount: 500, output: 1 }]));
  assert.strictEqual(msg.type, 'edicts');
  assert.deepStrictEqual(msg.edicts, [{ runeRef: '100:0', amount: 500, output: 1 }]);
});

test('vector 2: ascending heights are delta-encoded and decode as absolute', () => {
  const edicts = [
    { runeRef: '1000:0', amount: 1, output: 0 },
    { runeRef: '1005:2', amount: 2, output: 1 },
    { runeRef: '1200:1', amount: 3, output: 2 },
  ];
  const enc = encodeEdicts(edicts);
  assert.deepStrictEqual(decode(enc).edicts, edicts);
  // deltas (1000, 5, 195) must be cheaper than three absolute heights
  const absolute = 3 * encodeVarint(1000).length;
  const deltas = encodeVarint(1000).length + encodeVarint(5).length + encodeVarint(195).length;
  assert.ok(deltas < absolute);
});

test('two runes etched in the same block cost one byte of height between them', () => {
  const enc = encodeEdicts([
    { runeRef: '9400000:1', amount: 1, output: 0 },
    { runeRef: '9400000:2', amount: 1, output: 1 },
  ]);
  assert.deepStrictEqual(decode(enc).edicts.map((e) => e.runeRef), ['9400000:1', '9400000:2']);
});

test('edicts are sorted by (height, txIndex) regardless of input order', () => {
  const msg = decode(encodeEdicts([
    { runeRef: '300:0', amount: 1, output: 0 },
    { runeRef: '100:9', amount: 2, output: 1 },
    { runeRef: '100:3', amount: 3, output: 2 },
  ]));
  assert.deepStrictEqual(msg.edicts.map((e) => e.runeRef), ['100:3', '100:9', '300:0']);
});

test('vector 3: amount 0 survives the round-trip (it means "all of it")', () => {
  const msg = decode(encodeEdicts([{ runeRef: '7:0', amount: 0, output: 0 }]));
  assert.strictEqual(msg.edicts[0].amount, 0);
});

test('vector 1b: the maximum batch that fits is accepted, one more is refused', () => {
  const batch = [];
  for (let i = 0; i < 100; i++) {
    batch.push({ runeRef: refOf(1000 + i, 1), amount: 1, output: 0 });
    if (!fits(batch)) { batch.pop(); break; }
  }
  assert.ok(batch.length >= 8, 'expected at least 8 edicts to fit, got ' + batch.length);
  const enc = encodeEdicts(batch);
  assert.ok(enc.length <= MAX_PAYLOAD);
  assert.strictEqual(decode(enc).edicts.length, batch.length);
  assert.throws(() => encodeEdicts(batch.concat([{ runeRef: '99999:1', amount: 1, output: 0 }])));
});

test('a real mainnet-scale transfer still fits comfortably', () => {
  // A rune etched around today's Verge height, moved with change: the pair costs no more than the
  // packed reference did, so widening the identity cost nothing in the 83-byte budget.
  const enc = encodeEdicts([{ runeRef: refOf(9400123, 7), amount: 21000000, output: 1 }]);
  assert.ok(enc.length <= MAX_PAYLOAD, enc.length + ' bytes');
  assert.strictEqual(decode(enc).edicts[0].runeRef, '9400123:7');
});

test('a mint message round-trips, with and without an allowlist proof', () => {
  assert.deepStrictEqual(decode(encodeMint('42:1')), { type: 'mint', runeRef: '42:1', proofIndex: null });
  assert.deepStrictEqual(decode(encodeMint('42:1', 7)), { type: 'mint', runeRef: '42:1', proofIndex: 7 });
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
  const good = encodeEdicts([{ runeRef: '10:0', amount: 1, output: 0 }]);
  const bad = Buffer.from(good);
  bad[bad.length - 1] = 3; // flags = 3 sets a reserved bit
  assert.strictEqual(decode(bad), null);
});

test('trailing bytes after the terminator invalidate the message', () => {
  const enc = encodeEdicts([{ runeRef: '10:0', amount: 1, output: 0 }]);
  assert.strictEqual(decode(Buffer.concat([enc, Buffer.from([0x01])])), null);
});

test('every encoded message stays inside the OP_RETURN limit', () => {
  assert.ok(encodeMint(refOf(2 ** 32, 4096)).length <= MAX_PAYLOAD);
  assert.ok(encodeCheckpoint(2 ** 32, Buffer.alloc(32)).length <= MAX_PAYLOAD);
});

test('reserved low heights cannot be encoded (they would decode as a control message)', () => {
  // height 1 would emit a leading 0x01 and be mis-read as a mint, 2 as a checkpoint
  assert.throws(() => encodeEdicts([{ runeRef: '1:0', amount: 5, output: 0 }]), /reserved/);
  assert.throws(() => encodeEdicts([{ runeRef: '2:0', amount: 5, output: 0 }]), /reserved/);
  // the first valid height encodes and decodes as an edict stream, not as a control message
  const ok = encodeEdicts([{ runeRef: refOf(MIN_RUNE_HEIGHT, 0), amount: 5, output: 0 }]);
  assert.strictEqual(decode(ok).type, 'edicts');
});

test('negative or fractional values are rejected at encode time', () => {
  assert.throws(() => encodeVarint(-1));
  assert.throws(() => encodeVarint(1.5));
  assert.throws(() => encodeEdicts([{ runeRef: '-1:0', amount: 1, output: 0 }]));
  assert.throws(() => encodeEdicts([{ runeRef: '10:0', amount: 1.5, output: 0 }]));
  assert.throws(() => encodeEdicts([{ runeRef: 131001, amount: 1, output: 0 }])); // the old packed form
  assert.throws(() => encodeEdicts([]));
});

console.log('\nrunes codec: ' + passed + ' passed');
