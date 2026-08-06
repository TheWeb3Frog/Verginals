// Alpha fertility: the two-day carrier rest, measured off the chain's own nTime (§1.1).
// Run: node test/fertility.test.js
const assert = require('assert');
const { DAY, REST_SECONDS, fertility, afterBreeding, describe, canPair } = require('../src/fertility');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const T0 = 1_770_000_000; // an arbitrary but fixed "now"
const carrier = (agoSeconds, confirmations = 6) => ({ time: T0 - agoSeconds, confirmations });

test('the rest is two days', () => {
  assert.strictEqual(REST_SECONDS, 2 * DAY);
});

test('a carrier that has not moved for two days is fertile', () => {
  const s = fertility(carrier(2 * DAY), T0);
  assert.strictEqual(s.fertile, true);
  assert.strictEqual(s.remaining, 0);
  assert.strictEqual(s.reason, null);
});

test('one second short of two days is not fertile, and says how long is left', () => {
  const s = fertility(carrier(2 * DAY - 1), T0);
  assert.strictEqual(s.fertile, false);
  assert.strictEqual(s.reason, 'resting');
  assert.strictEqual(s.remaining, 1);
  assert.strictEqual(s.readyAt, T0 + 1);
});

test('a freshly moved carrier waits the full two days', () => {
  const s = fertility(carrier(0), T0);
  assert.strictEqual(s.fertile, false);
  assert.strictEqual(s.remaining, 2 * DAY);
});

test('an unconfirmed carrier is not fertile even if its nTime is old enough', () => {
  const s = fertility({ time: T0 - 10 * DAY, confirmations: 0 }, T0);
  assert.strictEqual(s.fertile, false);
  assert.strictEqual(s.reason, 'unconfirmed');
});

test('a carrier with no confirmation count reported is judged on time alone', () => {
  assert.strictEqual(fertility({ time: T0 - 3 * DAY }, T0).fertile, true);
});

test('a carrier timestamped in the future is treated as brand new, never as extra-rested', () => {
  // R1 allows a small forward skew; a slow local clock must not manufacture fertility.
  const s = fertility(carrier(-3600), T0);
  assert.strictEqual(s.restedFor, 0);
  assert.strictEqual(s.fertile, false);
});

test('the rest length is overridable, so the rule can be tuned without touching callers', () => {
  assert.strictEqual(fertility(carrier(DAY), T0, { restSeconds: DAY }).fertile, true);
  assert.strictEqual(fertility(carrier(DAY), T0, { restSeconds: 3 * DAY }).fertile, false);
});

test('a missing or malformed carrier time is an error, never a silent pass', () => {
  assert.throws(() => fertility({}, T0), /carrier\.time/);
  assert.throws(() => fertility({ time: NaN }, T0), /carrier\.time/);
  assert.throws(() => fertility(null, T0), /carrier\.time/);
  assert.throws(() => fertility(carrier(0), undefined), /unix timestamp/);
});

test('breeding spends the carrier, so it resets the rest — no cooldown table needed (§1.1)', () => {
  const after = afterBreeding(T0);
  assert.strictEqual(after.readyAt, T0 + REST_SECONDS);
  assert.strictEqual(fertility({ time: after.time, confirmations: 1 }, T0).fertile, false);
  assert.strictEqual(fertility({ time: after.time, confirmations: 1 }, T0 + REST_SECONDS).fertile, true);
});

test('selling an Alpha resets its rest, because the transfer moves the same carrier', () => {
  const sold = afterBreeding(T0); // a transfer spends the carrier exactly as breeding does
  assert.strictEqual(fertility({ time: sold.time, confirmations: 3 }, T0 + DAY).fertile, false);
  assert.strictEqual(fertility({ time: sold.time, confirmations: 3 }, T0 + 2 * DAY).fertile, true);
});

test('a pairing is gated on the slower of the two parents, and names who is blocking', () => {
  const mother = { id: 'alpha:6', carrier: carrier(3 * DAY) };
  const father = { id: 'alpha:15', carrier: carrier(6 * 3600) };
  const r = canPair(mother, father, T0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked.length, 1);
  assert.strictEqual(r.blocked[0].side, 'father');
  assert.strictEqual(r.blocked[0].id, 'alpha:15');
  assert.strictEqual(r.readyAt, father.carrier.time + REST_SECONDS);
});

test('two rested parents pair', () => {
  const r = canPair({ id: 'a', carrier: carrier(5 * DAY) }, { id: 'b', carrier: carrier(2 * DAY) }, T0);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.blocked, []);
});

test('both parents resting are both reported, not just the first', () => {
  const r = canPair({ id: 'a', carrier: carrier(0) }, { id: 'b', carrier: carrier(3600) }, T0);
  assert.strictEqual(r.blocked.length, 2);
  assert.deepStrictEqual(r.blocked.map((b) => b.side), ['mother', 'father']);
});

test('the player-facing line states the wait plainly and never rounds it away', () => {
  assert.strictEqual(describe(fertility(carrier(3 * DAY), T0)), 'Ready to breed');
  assert.strictEqual(describe(fertility(carrier(0), T0)), 'Resting — ready in 2 days');
  assert.strictEqual(describe(fertility(carrier(2 * DAY - 5 * 3600), T0)), 'Resting — ready in 5 hours');
  assert.strictEqual(describe(fertility(carrier(2 * DAY - 600), T0)), 'Resting — ready within the hour');
  assert.strictEqual(
    describe(fertility({ time: T0 - 9 * DAY, confirmations: 0 }, T0)),
    'Waiting for the carrier to confirm',
  );
});

console.log(`\n${passed} fertility tests passed`);
