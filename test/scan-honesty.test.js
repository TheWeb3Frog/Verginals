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

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

test('THE APP ASKS THE SAME QUESTION, rather than drawing Loading for twenty minutes', () => {
  // Every restart costs a full rescan. During it the market and the explore grid answer with
  // partial lists, and both used to show a spinner or claim the chain was empty. The site looked
  // broken after every deploy, and it was not broken: it was reading.
  assert.match(app, /async function indexProgress\(\)/, 'the app needs one place that asks');
  assert.match(app, /behind > 2/, 'with the same two blocks of slack the endpoint uses');
  assert.match(app, /function scanningNotice\(/, 'and one notice it draws');
});

test('an unreachable node is null in the app too, not "finished"', () => {
  assert.match(app, /catch \{ return null; \}/, 'indexProgress must answer null when it cannot ask');
});

test('the market checks before it claims nobody is selling', () => {
  const at = app.indexOf('Nobody is selling right now');
  assert.ok(at > 0, 'the sentence exists for the case where it is true');
  const before = app.slice(Math.max(0, at - 500), at);
  assert.match(before, /prog && prog\.scanning/, 'the scanning branch must come first');
});

test('and explore checks before it claims nothing is inscribed', () => {
  const at = app.indexOf('Nothing inscribed in the indexed range yet');
  assert.ok(at > 0);
  const before = app.slice(Math.max(0, at - 400), at);
  assert.match(before, /prog && prog\.scanning/);
});

test('both come back on their own', () => {
  assert.match(app, /scanningNotice\(prog, loadMarket\)/);
  assert.match(app, /scanningNotice\(prog, loadInscriptions\)/);
  assert.match(app, /setTimeout\(again, 15000\)/, 'the notice reschedules the caller');
});

console.log(`\n${passed} scan honesty tests passed`);
