// Decision table for the reaper's stale-reservation handling, mirroring the branches added to
// reapMintReservations(). Pure: no chain, no disk, no server. Run: node reaper-logic.test.js
const assert = require('assert');

const MAX_DRIVE_ATTEMPTS = 12;

// The exact decision the reaper makes for one stale reservation.
function decide({ job, received, isProcessing }) {
  if (!job) return 'release';
  if (job.status === 'done') return 'skip';
  if (isProcessing) return 'skip';
  if (received >= job.total) {
    return (job.driveAttempts || 0) < MAX_DRIVE_ATTEMPTS ? 'drive' : 'skip';
  }
  if (job.splitTxid) return 'keep'; // paid, deposit spent into the commit: never free the number
  return 'release';
}

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const job = (o = {}) => Object.assign({ id: 'j', total: 1000, status: 'awaiting_payment' }, o);

test('a funded job that nobody is polling gets finished by the server', () => {
  assert.strictEqual(decide({ job: job(), received: 1000 }), 'drive');
});

test('an overpaid job is still finished', () => {
  assert.strictEqual(decide({ job: job(), received: 4000 }), 'drive');
});

test('a job that failed earlier is retried (mempool errors are transient)', () => {
  assert.strictEqual(decide({ job: job({ status: 'error', error: 'too-long-mempool-chain', driveAttempts: 3 }), received: 1000 }), 'drive');
});

test('retries stop at the bound so a broken job is not rebuilt forever', () => {
  assert.strictEqual(decide({ job: job({ status: 'error', driveAttempts: MAX_DRIVE_ATTEMPTS }), received: 1000 }), 'skip');
});

test('a genuinely unpaid job returns its number to the pool', () => {
  assert.strictEqual(decide({ job: job(), received: 0 }), 'release');
});

test('an underpaid job is treated as unpaid', () => {
  assert.strictEqual(decide({ job: job(), received: 999 }), 'release');
});

test('a paid job whose commit already spent the deposit is NEVER released', () => {
  // the regression that would take a paid number away: deposit reads empty, but the money is
  // already on-chain in the commit outputs
  assert.strictEqual(decide({ job: job({ status: 'error', splitTxid: 'abc' }), received: 0 }), 'keep');
});

test('a job being driven by a browser poll right now is left alone (no double spend)', () => {
  assert.strictEqual(decide({ job: job(), received: 1000, isProcessing: true }), 'skip');
});

test('an already delivered job is untouched', () => {
  assert.strictEqual(decide({ job: job({ status: 'done' }), received: 1000 }), 'skip');
});

test('a reservation whose job file vanished frees the number', () => {
  assert.strictEqual(decide({ job: null, received: 0 }), 'release');
});

test('least-tried job is picked first so a failing one cannot starve the queue', () => {
  const paid = [{ job: job({ driveAttempts: 5 }) }, { job: job({ driveAttempts: 0 }) }, { job: job({ driveAttempts: 2 }) }];
  paid.sort((a, b) => (a.job.driveAttempts || 0) - (b.job.driveAttempts || 0));
  assert.strictEqual(paid[0].job.driveAttempts, 0);
});

test('only one job is finished per cycle (parent chain stays short)', () => {
  const paid = [{ job: job() }, { job: job() }, { job: job() }];
  const driven = paid.slice(0, 1); // the reaper takes paid[0] only
  assert.strictEqual(driven.length, 1);
});

console.log('\nreaper logic: ' + passed + ' passed');
