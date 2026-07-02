// Round-trip and limit tests for the Verginals envelope. Run: node test/envelope.test.js
const assert = require('assert');
const {
  buildInscriptionScript,
  parseInscriptionScript,
  planInputs,
  parentIdToBuffer,
  bufferToParentId,
} = require('../src/envelope');
const { limits } = require('../src/networks');

// A throwaway 33-byte compressed pubkey (0x02 prefix + 32 bytes).
const pubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xab)]);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('round-trip small text inscription', () => {
  const contentType = 'text/plain;charset=utf-8';
  const body = Buffer.from('Hello, Verge!', 'utf8');
  const script = buildInscriptionScript({ pubkey, contentType, body });
  const parsed = parseInscriptionScript(script);
  assert.strictEqual(parsed.contentType.toString('utf8'), contentType);
  assert.strictEqual(parsed.body.toString('utf8'), 'Hello, Verge!');
  assert.strictEqual(parsed.metadata.length, 0);
});

test('round-trip with metadata', () => {
  const body = Buffer.from('x');
  const metadata = Buffer.from([0xa1, 0x61, 0x6b, 0x61, 0x76]); // arbitrary CBOR-ish bytes
  const script = buildInscriptionScript({ pubkey, contentType: 'application/json', body, metadata });
  const parsed = parseInscriptionScript(script);
  assert.strictEqual(parsed.contentType.toString('utf8'), 'application/json');
  assert.strictEqual(parsed.metadata.length, 1);
  assert.deepStrictEqual(parsed.metadata[0], metadata);
});

test('round-trip body that fills a single standard P2SH redeemScript', () => {
  // ~400 bytes -> one push, comfortably under the 520-byte P2SH redeemScript limit.
  const body = Buffer.alloc(400);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
  const script = buildInscriptionScript({ pubkey, contentType: 'application/octet-stream', body });
  assert.ok(script.length <= limits.MAX_STANDARD_P2SH_SCRIPT_SIZE, 'stays standard');
  const parsed = parseInscriptionScript(script);
  assert.deepStrictEqual(parsed.body, body);
});

test('oversized single-input body is rejected with guidance', () => {
  const body = Buffer.alloc(5000); // > 520-byte standard P2SH redeemScript limit
  assert.throws(() => buildInscriptionScript({ pubkey, contentType: 'image/png', body }), /split body across inputs/);
});

test('planInputs splits a large payload into multiple standard inputs', () => {
  const body = Buffer.alloc(10_000);
  const plan = planInputs(body, { contentType: 'image/png' });
  assert.ok(plan.inputs >= 3, `expected multiple inputs, got ${plan.inputs}`);
  const total = plan.perInputBody.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, body.length, 'plan covers the whole body');
  // Verify each planned chunk actually builds a standard redeemScript.
  let off = 0;
  plan.perInputBody.forEach((n, idx) => {
    const slice = body.subarray(off, off + n);
    off += n;
    const script = buildInscriptionScript({
      pubkey,
      contentType: idx === 0 ? 'image/png' : undefined,
      body: slice,
      bodyOnly: idx !== 0,
    });
    assert.ok(
      script.length <= limits.MAX_STANDARD_P2SH_SCRIPT_SIZE,
      `input ${idx} script ${script.length}B exceeds standard limit`
    );
  });
});

test('parent id <-> buffer round-trips (i0 is bare 32-byte txid, iN appends LE index)', () => {
  const txidHex = 'a'.repeat(64);
  // i0: buffer is exactly the 32-byte txid in internal (reversed) order, no index bytes.
  const b0 = parentIdToBuffer(`${txidHex}i0`);
  assert.strictEqual(b0.length, 32, 'i0 encodes to a bare 32-byte txid');
  assert.strictEqual(bufferToParentId(b0), `${txidHex}i0`);
  // iN: index appended little-endian with trailing zeros stripped.
  const b5 = parentIdToBuffer(`${txidHex}i5`);
  assert.strictEqual(b5.length, 33, 'i5 appends a single index byte');
  assert.strictEqual(b5[32], 5);
  assert.strictEqual(bufferToParentId(b5), `${txidHex}i5`);
  // Multi-byte index round-trips too.
  const bBig = parentIdToBuffer(`${txidHex}i258`); // 258 = 0x0102 -> LE [0x02, 0x01]
  assert.deepStrictEqual([bBig[32], bBig[33]], [0x02, 0x01]);
  assert.strictEqual(bufferToParentId(bBig), `${txidHex}i258`);
});

test('round-trip with tag-3 parent', () => {
  const parentId = `${'b'.repeat(64)}i0`;
  const parent = parentIdToBuffer(parentId);
  const body = Buffer.from('child');
  const script = buildInscriptionScript({ pubkey, contentType: 'image/webp', body, parent });
  const parsed = parseInscriptionScript(script);
  assert.strictEqual(parsed.parents.length, 1, 'one parent recovered');
  assert.strictEqual(bufferToParentId(parsed.parents[0]), parentId);
  assert.strictEqual(parsed.body.toString('utf8'), 'child');
});

test('planInputs accounts for the parent field on the first input', () => {
  const parent = parentIdToBuffer(`${'c'.repeat(64)}i0`);
  const body = Buffer.alloc(10_000);
  const plan = planInputs(body, { contentType: 'image/png', parent });
  const total = plan.perInputBody.reduce((a, b) => a + b, 0);
  assert.strictEqual(total, body.length, 'plan covers the whole body');
  // First input carries content-type + parent, so it fits strictly less body than a bare input.
  const bare = planInputs(body, {});
  assert.ok(plan.perInputBody[0] <= bare.perInputBody[0], 'parent shrinks first-input budget');
});

test('non-envelope script parses as null', () => {
  const notEnvelope = Buffer.from([0x21, ...Buffer.alloc(33, 1), 0xac]); // <pubkey> CHECKSIG
  assert.strictEqual(parseInscriptionScript(notEnvelope), null);
});

console.log(`\n${passed} tests passed`);
