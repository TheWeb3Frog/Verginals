// Mint controller tests: provably-fair order, reservation/mint/release lifecycle, persistence.
// Run: node test/mint.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { MintController, deriveOrder, sha256hex } = require('../src/mint');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Build a tiny synthetic collection on disk so the tests are hermetic.
function makeCollection(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmint-'));
  fs.mkdirSync(path.join(root, 'images'));
  const designs = [];
  const metadata = [];
  for (let i = 1; i <= n; i++) {
    const filename = `Verginals_${String(i).padStart(4, '0')}.webp`;
    fs.writeFileSync(path.join(root, 'images', filename), Buffer.from(`img-${i}`));
    designs.push({ filename, name: `Verginals #${i}`, house: ['fire', 'water', 'earth'][i % 3], number: i });
    metadata.push({ number: i, name: `Verginals #${i}`, attributes: [{ trait_type: 'House', value: 'Fire' }] });
  }
  fs.writeFileSync(path.join(root, 'designs.json'), JSON.stringify(designs));
  fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify(metadata));
  fs.writeFileSync(
    path.join(root, 'collection_manifest.json'),
    JSON.stringify({ name: 'Verginals', symbol: 'VERG', supply: n, provenance_hash: 'deadbeef' }),
  );
  return root;
}
function freshData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vdata-'));
}

test('deriveOrder is a permutation of [1..n], reproducible, seed-sensitive', () => {
  const a = deriveOrder('00'.repeat(32), 50);
  assert.deepStrictEqual([...a].sort((x, y) => x - y), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.deepStrictEqual(deriveOrder('00'.repeat(32), 50), a); // reproducible
  assert.notDeepStrictEqual(deriveOrder('11'.repeat(32), 50), a); // different seed → different order
});

test('commitment = SHA256(seed bytes), stable across reloads', () => {
  const col = makeCollection(10);
  const data = freshData();
  const m1 = new MintController({ collectionDir: col, dataDir: data }).load();
  const seed = fs.readFileSync(path.join(data, 'mint.secret'), 'utf8').trim();
  assert.strictEqual(m1.commitment, sha256hex(Buffer.from(seed, 'hex')));
  const m2 = new MintController({ collectionDir: col, dataDir: data }).load(); // reload, same seed
  assert.strictEqual(m2.commitment, m1.commitment);
});

test('reserve serves numbers in the committed order and never twice', () => {
  const col = makeCollection(20);
  const m = new MintController({ collectionDir: col, dataDir: freshData() }).load();
  const seen = new Set();
  for (let k = 0; k < 20; k++) {
    const a = m.reserve('job' + k);
    assert.ok(a && a.number >= 1 && a.number <= 20, 'got an assignment');
    assert.strictEqual(a.number, m.order[k], 'follows committed order');
    assert.ok(!seen.has(a.number), 'no duplicate');
    seen.add(a.number);
  }
  assert.strictEqual(m.reserve('overflow'), null, 'sold out / fully reserved → null');
});

test('confirmMinted + release lifecycle and counters', () => {
  const col = makeCollection(5);
  const m = new MintController({ collectionDir: col, dataDir: freshData() }).load();
  const a = m.reserve('jobA');
  assert.strictEqual(m.reservedCount(), 1);
  assert.strictEqual(m.reservationOf('jobA'), a.number);
  m.confirmMinted(a.number, { revealTxid: 'tx'.repeat(32), owner: 'DAddr' });
  assert.strictEqual(m.mintedCount(), 1);
  assert.strictEqual(m.reservedCount(), 0);

  const b = m.reserve('jobB');
  assert.notStrictEqual(b.number, a.number, 'minted number not re-served');
  m.release(b.number); // unpaid → back to pool
  assert.strictEqual(m.reservedCount(), 0);
  const c = m.reserve('jobC');
  assert.strictEqual(c.number, b.number, 'released number is offered again at its priority');
});

test('reveal requires sold out unless forced; verifies against commitment', () => {
  const col = makeCollection(3);
  const m = new MintController({ collectionDir: col, dataDir: freshData() }).load();
  assert.throws(() => m.reveal(), /not sold out/);
  for (let k = 0; k < 3; k++) {
    const a = m.reserve('j' + k);
    m.confirmMinted(a.number, { revealTxid: 't' + k, owner: 'o' + k });
  }
  assert.ok(m.soldOut());
  const seed = m.reveal();
  assert.strictEqual(sha256hex(Buffer.from(seed, 'hex')), m.commitment, 'revealed seed matches commitment');
  assert.deepStrictEqual(deriveOrder(seed, 3), m.order, 'order recomputes from revealed seed');
  assert.strictEqual(m.status().revealed, true);
});

test('state persists across controller reloads', () => {
  const col = makeCollection(8);
  const data = freshData();
  const m1 = new MintController({ collectionDir: col, dataDir: data }).load();
  const a = m1.reserve('jobX');
  m1.confirmMinted(a.number, { revealTxid: 'zz', owner: 'D1' });
  const b = m1.reserve('jobY'); // left reserved

  const m2 = new MintController({ collectionDir: col, dataDir: data }).load();
  assert.strictEqual(m2.mintedCount(), 1, 'minted survives reload');
  assert.strictEqual(m2.reservedCount(), 1, 'reservation survives reload');
  assert.strictEqual(m2.reservationOf('jobY'), b.number);
  assert.ok(m2.state.minted[a.number], 'minted entry present');
});

test('staleReservations reports old reservations for the server to vet', () => {
  const col = makeCollection(4);
  const m = new MintController({ collectionDir: col, dataDir: freshData() }).load();
  const a = m.reserve('jobOld');
  m.state.reserved[a.number].at = Date.now() - 60_000; // backdate 1 min
  const stale = m.staleReservations(30_000);
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].number, a.number);
  assert.strictEqual(stale[0].jobId, 'jobOld');
});

test('metadataCbor embeds the item name, collection, and traits (ord tag 5)', () => {
  const cbor = require('../src/cbor');
  const col = makeCollection(3);
  const m = new MintController({ collectionDir: col, dataDir: freshData() }).load();
  const buf = m.metadataCbor(2);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'returns non-empty CBOR bytes');
  const decoded = cbor.decode(buf);
  assert.strictEqual(decoded.name, 'Verginals #2');
  assert.strictEqual(decoded.collection, 'Verginals');
  assert.deepStrictEqual(decoded.attributes, [{ trait_type: 'House', value: 'Fire' }]);
  assert.strictEqual(m.metadataCbor(9999), null, 'unknown number returns null');
});

console.log(`\n${passed} mint tests passed`);
