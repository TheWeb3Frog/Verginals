// An unfinished scan and an empty chain must never look the same.
//
// A restart costs a full rescan of the chain, and during it the coins endpoint answers with an
// empty list. The list is true. The sentence the page drew from it, "No coin has been etched yet",
// was not: five coins were on the chain at the time, and the page said that to anybody who loaded
// it for the twenty minutes the scan took.
//
// The endpoint now reports whether it has finished, so the two states are distinguishable by
// something other than a guess.
//
// Run: node test/scan-honesty.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'runes-market.js'), 'utf8');

/** The reply shape, extracted and run rather than described. */
function reply({ tip, scanned }) {
  // Mirrors handleRuneCoins: the same two lines, kept in step by the test below.
  return { tip, scannedThrough: scanned, scanning: tip === null ? null : tip - scanned > 2 };
}

test('THE ENDPOINT SAYS WHETHER IT HAS FINISHED', () => {
  assert.match(server, /scanning: tip === null \? null : tip - scanned > 2/,
    'handleRuneCoins must report a scanning flag');
  assert.match(server, /scannedThrough: scanned/, 'and how far it has got');
});

test('a fresh restart reads as scanning, not as an empty chain', () => {
  // The exact state that produced the wrong sentence: nothing scanned, a live tip.
  const r = reply({ tip: 9424599, scanned: 0 });
  assert.strictEqual(r.scanning, true);
});

test('a caught-up index is not scanning', () => {
  assert.strictEqual(reply({ tip: 9424599, scanned: 9424599 }).scanning, false);
  assert.strictEqual(reply({ tip: 9424599, scanned: 9424598 }).scanning, false, 'one behind is caught up');
});

test('two blocks of slack, because a tip moves while the answer is built', () => {
  assert.strictEqual(reply({ tip: 9424599, scanned: 9424597 }).scanning, false);
  assert.strictEqual(reply({ tip: 9424599, scanned: 9424596 }).scanning, true);
});

test('an unreachable node is null, which is neither true nor false', () => {
  // "I could not ask" is a third state and must not collapse into "finished".
  assert.strictEqual(reply({ tip: null, scanned: 0 }).scanning, null);
});

test('THE PAGE NEVER CLAIMS AN EMPTY CHAIN WHILE SCANNING', () => {
  // The sentence and the guard that has to sit in front of it.
  const at = page.indexOf('No coin has been etched yet');
  assert.ok(at > 0, 'the sentence still exists for the case where it is true');
  const before = page.slice(Math.max(0, at - 900), at);
  assert.match(before, /else if \(scanning\)/,
    'the scanning branch must come before the empty claim, or the claim is made too early');
});

test('and it comes back on its own rather than telling somebody to refresh', () => {
  assert.match(page, /setTimeout\(load,/, 'an unfinished scan schedules another look');
});

console.log(`\n${passed} scan honesty tests passed`);
