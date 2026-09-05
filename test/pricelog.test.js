// The price history, and every case where a percentage would be a lie.
//
// A change figure is the most trusted number on a marketplace and the easiest one to fake without
// meaning to. The three ways it goes wrong are all silent:
//
//   Answering a 24h window from a log that started an hour ago. The maths works, the number is
//   confident, and it describes a completely different period from the one on the label.
//   Treating "nothing was for sale" as a price of zero, which makes the first listing of the week
//   an infinite gain.
//   Printing 0.00% for a market that has no history at all, which reads as "flat" rather than
//   "unknown".
//
// So most of this file is about what must come back NULL.
//
// Run: node test/pricelog.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PriceLog, collectionKey, coinKey, DAY } = require('../src/pricelog');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const T0 = 1788000000; // a fixed Tuesday, so nothing here depends on when it runs
function fresh(start = T0) {
  const clock = { t: start };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelog-'));
  const log = new PriceLog({ file: path.join(dir, 'p.json'), now: () => clock.t });
  return { log, clock, dir };
}
const K = 'collection:alpha';

// --- recording -----------------------------------------------------------------------------------

test('a reading is kept, and reading the same price again writes nothing', () => {
  const { log, clock } = fresh();
  assert.strictEqual(log.record(K, 1000), true);
  clock.t += 300;
  assert.strictEqual(log.record(K, 1000), false, 'an unchanged price is not a new point');
  clock.t += 300;
  assert.strictEqual(log.record(K, 1200), true);
  assert.strictEqual(log.state.series[K].pts.length, 2);
});

test('NOTHING FOR SALE IS A READING, and it is not a price of zero', () => {
  const { log, clock } = fresh();
  log.record(K, null);
  clock.t += 600;
  log.record(K, 1000);
  assert.deepStrictEqual(log.state.series[K].pts.map((p) => p[1]), [null, 1000]);
  assert.notStrictEqual(log.at(K, T0), 0, 'an empty book must never read back as zero');
  assert.strictEqual(log.at(K, T0), null);
});

test('a price must be a number or null, and a key must be a string', () => {
  const { log } = fresh();
  assert.throws(() => log.record(K, 'cheap'), /must be a number or null/);
  assert.throws(() => log.record(K, -5), /must be a number or null/);
  assert.throws(() => log.record('', 5), /non-empty string/);
});

// --- reading back ---------------------------------------------------------------------------------

test('the price at a moment is the last reading at or before it', () => {
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += DAY; log.record(K, 2000);
  clock.t += DAY; log.record(K, 3000);
  assert.strictEqual(log.at(K, T0), 1000);
  assert.strictEqual(log.at(K, T0 + DAY - 1), 1000, 'still yesterday until the new reading lands');
  assert.strictEqual(log.at(K, T0 + DAY), 2000);
  assert.strictEqual(log.at(K, T0 + 3 * DAY), 3000, 'the last one holds into the future');
  assert.strictEqual(log.at(K, T0 - 1), undefined, 'before the log began there is no answer');
});

// --- the change, and everything it must refuse -----------------------------------------------------

test('a real move over a real window', () => {
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += 2 * DAY;
  log.record(K, 1500);
  const c = log.changeOver(K, DAY);
  assert.strictEqual(c.from, 1000);
  assert.strictEqual(c.to, 1500);
  assert.ok(Math.abs(c.pct - 50) < 1e-9);
});

test('a fall is negative, and a flat market really is zero once the history is there', () => {
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += 2 * DAY;
  log.record(K, 800);
  assert.ok(Math.abs(log.changeOver(K, DAY).pct + 20) < 1e-9);
  clock.t += 2 * DAY;
  assert.strictEqual(log.changeOver(K, DAY).pct, 0, 'unchanged for two days IS a zero, and it is known');
});

test('A WINDOW LONGER THAN THE LOG IS REFUSED, rather than answered from the beginning', () => {
  // The one that matters. Right after a deploy the log is minutes old, and every market on the
  // site would otherwise report a confident 24h change measured over four minutes.
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += 3600;
  log.record(K, 2000);
  assert.strictEqual(log.changeOver(K, DAY), null, 'an hour of history cannot answer for a day');
  clock.t += DAY;
  assert.ok(log.changeOver(K, DAY), 'and once a day has passed it can');
});

test('a window that starts with nothing for sale is refused', () => {
  const { log, clock } = fresh();
  log.record(K, null);
  clock.t += 2 * DAY;
  log.record(K, 1000);
  assert.strictEqual(log.changeOver(K, DAY), null, 'a first listing is not an infinite gain');
});

test('a window that ends with nothing for sale is refused too', () => {
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += 2 * DAY;
  log.record(K, null);
  assert.strictEqual(log.changeOver(K, DAY), null, 'delisting everything is not a 100% fall');
});

test('a market never seen has no change, and asking does not create one', () => {
  const { log } = fresh();
  assert.strictEqual(log.changeOver('coin:1:1', DAY), null);
  assert.deepStrictEqual(log.keys(), []);
});

test('CONTROL: computing it without the age check would have produced a number', () => {
  // Proves the refusals above are doing work rather than describing an impossible case.
  const { log, clock } = fresh();
  log.record(K, 1000);
  clock.t += 3600;
  log.record(K, 2000);
  const naive = ((log.latest(K) - log.state.series[K].pts[0][1]) / log.state.series[K].pts[0][1]) * 100;
  assert.strictEqual(naive, 100, 'the naive version reports +100% over a day it never saw');
  assert.strictEqual(log.changeOver(K, DAY), null);
});

// --- keeping it small ------------------------------------------------------------------------------

test('old points go, but the one holding the far edge stays', () => {
  const { log, clock } = fresh();
  log.record(K, 100);
  clock.t += 60 * DAY;
  log.record(K, 200);
  const pts = log.state.series[K].pts;
  assert.strictEqual(pts.length, 2, 'the old reading is what a 45-day lookup lands on, so it stays');
  clock.t += 60 * DAY;
  log.record(K, 300);
  assert.strictEqual(log.state.series[K].pts.length, 2, 'and now the first one is genuinely unreachable');
  assert.strictEqual(log.at(K, log.now() - DAY), 200);
});

// --- persistence and keys ----------------------------------------------------------------------------

test('it survives a restart, which is the only reason it exists', () => {
  const { log, clock, dir } = fresh();
  log.record(K, 1000);
  clock.t += 2 * DAY;
  log.record(K, 1500);
  assert.strictEqual(log.save(), true);
  assert.strictEqual(log.save(), false, 'a second save with nothing new writes nothing');

  const again = new PriceLog({ file: path.join(dir, 'p.json'), now: () => clock.t }).load();
  assert.strictEqual(again.latest(K), 1500);
  assert.ok(Math.abs(again.changeOver(K, DAY).pct - 50) < 1e-9);
});

test('an unreadable log starts empty rather than throwing on boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelog-'));
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, 'not json at all');
  const log = new PriceLog({ file }).load();
  assert.deepStrictEqual(log.keys(), []);
});

test('THE KEYS CARRY NO KNOWLEDGE OF WHAT A MARKET IS', () => {
  // A new collection or a new coin must need no change in this module.
  assert.strictEqual(collectionKey(null), 'collection:alpha');
  assert.strictEqual(collectionKey('verge-frogs'), 'collection:verge-frogs');
  assert.strictEqual(coinKey('9420444:2'), 'coin:9420444:2');
  const { log } = fresh();
  log.record(collectionKey('anything-at-all'), 7);
  log.record(coinKey('1:1'), 8);
  assert.deepStrictEqual(log.keys().sort(), ['coin:1:1', 'collection:anything-at-all']);
});

test('a market can be forgotten', () => {
  const { log } = fresh();
  log.record(K, 1);
  assert.strictEqual(log.forget(K), true);
  assert.strictEqual(log.forget(K), false);
  assert.deepStrictEqual(log.keys(), []);
});

console.log('\n' + passed + ' price log tests passed');
