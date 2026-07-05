// Promo controller tests: eligibility gates, per-address / per-IP caps, slot lifecycle, persistence.
// Run: node test/promo.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PromoController } = require('../src/promo');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vpromo-'));
}
function make(opts = {}) {
  return new PromoController(Object.assign({
    dataDir: freshDir(), enabled: true, hasKey: true, limit: 3, maxPerAddr: 1, maxPerIp: 2,
  }, opts)).load();
}

// --- inactivity gates --------------------------------------------------------------------
test('inactive when disabled', () => {
  const p = make({ enabled: false });
  assert.strictEqual(p.active(), false);
  assert.strictEqual(p.eligible('1.2.3.4', 'Daddr'), false);
});

test('inactive without a key', () => {
  const p = make({ hasKey: false });
  assert.strictEqual(p.active(), false);
  assert.strictEqual(p.eligible('1.2.3.4', 'Daddr'), false);
});

// --- basic hold / remaining --------------------------------------------------------------
test('a hold consumes exactly one slot', () => {
  const p = make({ limit: 3, maxPerAddr: 9, maxPerIp: 9 });
  assert.strictEqual(p.remaining(), 3);
  assert.strictEqual(p.hold('job1', '1.1.1.1', 'A'), true);
  assert.strictEqual(p.remaining(), 2);
  assert.strictEqual(p.usedCount(), 1);
});

test('hold is idempotent for the same job id', () => {
  const p = make({ limit: 3, maxPerAddr: 9, maxPerIp: 9 });
  assert.strictEqual(p.hold('job1', '1.1.1.1', 'A'), true);
  assert.strictEqual(p.hold('job1', '1.1.1.1', 'A'), true);
  assert.strictEqual(p.usedCount(), 1);
});

// --- caps --------------------------------------------------------------------------------
test('per-address cap blocks a second claim to the same address', () => {
  const p = make({ limit: 9, maxPerAddr: 1, maxPerIp: 9 });
  assert.strictEqual(p.hold('j1', '1.1.1.1', 'SAME'), true);
  assert.strictEqual(p.eligible('2.2.2.2', 'SAME'), false);
  assert.strictEqual(p.hold('j2', '2.2.2.2', 'SAME'), false);
  assert.strictEqual(p.usedCount(), 1);
});

test('per-IP cap blocks once the IP hits its limit', () => {
  const p = make({ limit: 9, maxPerAddr: 9, maxPerIp: 2 });
  assert.strictEqual(p.hold('j1', '9.9.9.9', 'A'), true);
  assert.strictEqual(p.hold('j2', '9.9.9.9', 'B'), true);
  assert.strictEqual(p.eligible('9.9.9.9', 'C'), false);
  assert.strictEqual(p.hold('j3', '9.9.9.9', 'C'), false);
  assert.strictEqual(p.usedCount(), 2);
});

// --- global limit ------------------------------------------------------------------------
test('global limit caps total claims and flips active() off', () => {
  const p = make({ limit: 2, maxPerAddr: 9, maxPerIp: 9 });
  assert.strictEqual(p.hold('j1', '1.1.1.1', 'A'), true);
  assert.strictEqual(p.hold('j2', '2.2.2.2', 'B'), true);
  assert.strictEqual(p.active(), false);
  assert.strictEqual(p.remaining(), 0);
  assert.strictEqual(p.hold('j3', '3.3.3.3', 'C'), false);
});

// --- release frees a slot; confirm keeps it consumed -------------------------------------
test('release returns the slot to the pool', () => {
  const p = make({ limit: 1, maxPerAddr: 9, maxPerIp: 9 });
  assert.strictEqual(p.hold('j1', '1.1.1.1', 'A'), true);
  assert.strictEqual(p.active(), false);
  p.release('j1');
  assert.strictEqual(p.remaining(), 1);
  assert.strictEqual(p.hold('j2', '2.2.2.2', 'B'), true);
});

test('confirm keeps the slot consumed permanently', () => {
  const p = make({ limit: 2, maxPerAddr: 9, maxPerIp: 9 });
  p.hold('j1', '1.1.1.1', 'A');
  p.confirm('j1');
  assert.strictEqual(p.confirmedCount(), 1);
  assert.strictEqual(p.usedCount(), 1);
  assert.strictEqual(p.remaining(), 1);
});

// --- persistence across restart ----------------------------------------------------------
test('state and salt survive a reload', () => {
  const dir = freshDir();
  const a = new PromoController({ dataDir: dir, enabled: true, hasKey: true, limit: 3, maxPerAddr: 1, maxPerIp: 2 }).load();
  a.hold('j1', '1.1.1.1', 'A');
  a.confirm('j1');
  const salt = a.state.salt;
  const b = new PromoController({ dataDir: dir, enabled: true, hasKey: true, limit: 3, maxPerAddr: 1, maxPerIp: 2 }).load();
  assert.strictEqual(b.usedCount(), 1);
  assert.strictEqual(b.confirmedCount(), 1);
  assert.strictEqual(b.state.salt, salt); // same salt so IP hashes stay comparable
  assert.strictEqual(b.eligible('2.2.2.2', 'A'), false); // per-address cap still enforced after reload
});

// --- privacy: raw IP is never stored -----------------------------------------------------
test('promo.json stores a hash, never the raw IP', () => {
  const dir = freshDir();
  const p = new PromoController({ dataDir: dir, enabled: true, hasKey: true, limit: 3, maxPerAddr: 1, maxPerIp: 2 }).load();
  p.hold('j1', '203.0.113.7', 'A');
  const disk = fs.readFileSync(path.join(dir, 'promo.json'), 'utf8');
  assert.ok(!disk.includes('203.0.113.7'), 'raw IP must not appear on disk');
});

console.log(`\n${passed} promo tests passed`);
