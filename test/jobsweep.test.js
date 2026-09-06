// Finishing what somebody paid for and walked away from.
//
// A quote is driven by the buyer's own browser. Pay, close the tab, and nobody ever builds the
// commit or the reveal: the money sits at a deposit address that will never be spent, and thirty
// days later the job file is deleted and the record of it goes too. On the day this was written
// there was one such inscription on the live chain, twelve days old, with eighteen days left before
// the only trace of it disappeared.
//
// Collection mints were never in this hole, because they hold a reservation and the reaper walks
// reservations. Plain inscriptions hold nothing.
//
// Every rule below is a rule about somebody's money, which is why the selection is a pure function
// away from the RPC and the filesystem, and why most of this file is about what must NOT be picked.
//
// Run: node test/jobsweep.test.js
const assert = require('assert');
const { pickAbandoned } = require('../src/jobsweep');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const T = 1788000000000;
let n = 0;
const job = (over = {}) => Object.assign({
  id: 'a'.repeat(16) + (n++), depositAddress: 'D' + String(n).padStart(33, 'x'),
  status: 'awaiting_payment', total: 5_000_000, createdAt: T, driveAttempts: 0,
}, over);
const pick = (jobs, over = {}) => pickAbandoned(jobs, Object.assign({
  paid: new Map(jobs.map((j) => [j.depositAddress, j.total])), // paid in full unless overridden
  processing: new Set(), maxAttempts: 12, limit: 3,
}, over));

test('A PAID, ABANDONED INSCRIPTION IS PICKED UP', () => {
  const j = job();
  assert.deepStrictEqual(pick([j]).map((x) => x.id), [j.id]);
});

// --- what must never be picked -------------------------------------------------------------------

test('a job that finished, or already failed, is left alone', () => {
  assert.deepStrictEqual(pick([job({ status: 'done' }), job({ status: 'error' })]), []);
});

test('A COLLECTION MINT IS NOT OURS: the reservation reaper finishes those', () => {
  // Picking them up here too would race the reaper, and every parented reveal spends the single
  // collection parent tip, which is exactly the contention that makes reveals fail.
  assert.deepStrictEqual(pick([job({ mint: { number: 412 } })]), []);
});

test('NOTHING PAST THE COMMIT IS TOUCHED', () => {
  // drivePayout rebuilds the funding transaction from the deposit outputs unconditionally. Run it
  // again on a job whose commit already spent them and it throws, or signs something different.
  assert.deepStrictEqual(pick([job({ splitTxid: 'ab'.repeat(32) })]), []);
  assert.deepStrictEqual(pick([job({ revealTxid: 'cd'.repeat(32) })]), []);
});

test('a job a request is driving right now is left to it', () => {
  const j = job();
  assert.deepStrictEqual(pick([j], { processing: new Set([j.id]) }), []);
});

test('a job that has been tried too often stops being tried', () => {
  assert.deepStrictEqual(pick([job({ driveAttempts: 12 })]), []);
  assert.strictEqual(pick([job({ driveAttempts: 11 })]).length, 1, 'and one below the limit still is');
});

test('PARTIAL PAYMENT IS NOT PAYMENT', () => {
  // A commit built against half the money produces outputs the plan cannot cover.
  const j = job({ total: 5_000_000 });
  assert.deepStrictEqual(pick([j], { paid: new Map([[j.depositAddress, 4_999_999]]) }), []);
  assert.strictEqual(pick([j], { paid: new Map([[j.depositAddress, 5_000_000]]) }).length, 1, 'exactly is enough');
  assert.strictEqual(pick([j], { paid: new Map([[j.depositAddress, 9_000_000]]) }).length, 1, 'and overpaying is too');
});

test('nothing received at all is not a job to finish', () => {
  assert.deepStrictEqual(pick([job()], { paid: new Map() }), []);
});

test('a job with no total, or a total of nothing, is refused', () => {
  assert.deepStrictEqual(pick([job({ total: 0 }), job({ total: undefined })]), []);
});

test('malformed files on disk do not throw', () => {
  assert.deepStrictEqual(pickAbandoned([null, {}, { id: 'x' }, undefined],
    { paid: new Map(), processing: new Set() }), []);
});

// --- the order, and the cap ------------------------------------------------------------------------

test('LEAST TRIED FIRST, so one failing job cannot starve the ones behind it', () => {
  const a = job({ driveAttempts: 4 });
  const b = job({ driveAttempts: 0 });
  const c = job({ driveAttempts: 2 });
  assert.deepStrictEqual(pick([a, b, c]).map((x) => x.driveAttempts), [0, 2, 4]);
});

test('and the oldest first among equals, so nobody waits longer for having paid earlier', () => {
  const late = job({ createdAt: T + 90000 });
  const early = job({ createdAt: T });
  assert.deepStrictEqual(pick([late, early]).map((x) => x.id), [early.id, late.id]);
});

test('only a few are handed back per sweep', () => {
  const many = Array.from({ length: 10 }, () => job());
  assert.strictEqual(pick(many).length, 3);
  assert.strictEqual(pick(many, { limit: 1 }).length, 1);
});

// --- controls ---------------------------------------------------------------------------------------

test('CONTROL: without the commit guard, a half-driven job would be picked', () => {
  const committed = job({ splitTxid: 'ab'.repeat(32) });
  const naive = [committed].filter((j) => j.status !== 'done' && j.status !== 'error');
  assert.strictEqual(naive.length, 1, 'a check on status alone lets it through');
  assert.strictEqual(pick([committed]).length, 0, 'and the real selector does not');
});

test('CONTROL: without the mint guard, a mint would be driven twice', () => {
  const m = job({ mint: { number: 7 } });
  const naive = [m].filter((j) => !j.splitTxid);
  assert.strictEqual(naive.length, 1);
  assert.strictEqual(pick([m]).length, 0);
});

test('the real shape: one paid inscription among many unpaid quotes', () => {
  // What the live server actually holds: hundreds of quotes nobody paid, and one that was.
  const noise = Array.from({ length: 280 }, () => job());
  const real = job({ createdAt: T - 12 * 86400000 });
  const paid = new Map([[real.depositAddress, real.total]]);
  const out = pickAbandoned([...noise, real], { paid, processing: new Set(), maxAttempts: 12, limit: 3 });
  assert.deepStrictEqual(out.map((x) => x.id), [real.id]);
});

console.log('\n' + passed + ' job sweep tests passed');
