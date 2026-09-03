// The collection's activity feed, and the two bugs one inconsistent unit caused.
//
// A sale was stamped with Date.now(), a listing with seconds, and the two were concat'd and sorted
// against each other. Both consequences were visible on the page and neither looked like a bug:
//
//   Every sale sorted above every listing FOR EVER, because a millisecond stamp is a thousand times
//   the number a second stamp is, so the sort compared magnitudes rather than time. A sale from July
//   sat above listings from the same morning.
//
//   And the page reads seconds, so a sale aged to a huge negative number, which Math.max(0, ...)
//   turned into "0s ago". Every sale in the history claimed to have just happened, permanently.
//
// Run: node test/activity-time.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

// The normaliser the feed applies, mirrored so the assertions are about the shipped rule.
const secs = (t) => (Number(t) > 1e11 ? Math.round(Number(t) / 1000) : Number(t)) || 0;

const JULY = 1784676092;          // a real sale, in seconds
const SEPT = 1788447471;          // a real listing, later, in seconds

test('a millisecond stamp and a second stamp land on the same instant', () => {
  assert.strictEqual(secs(JULY * 1000), JULY);
  assert.strictEqual(secs(SEPT), SEPT);
});

test('THE OLDER EVENT SORTS BELOW THE NEWER ONE, whichever unit it was written in', () => {
  const feed = [
    { type: 'sale', at: secs(JULY * 1000) },   // written in milliseconds
    { type: 'list', at: secs(SEPT) },          // written in seconds
  ].sort((a, b) => b.at - a.at);
  assert.strictEqual(feed[0].type, 'list', 'September must come before July');
});

test('CONTROL: without the normaliser the July sale wins, which is the bug', () => {
  const feed = [
    { type: 'sale', at: JULY * 1000 },
    { type: 'list', at: SEPT },
  ].sort((a, b) => b.at - a.at);
  assert.strictEqual(feed[0].type, 'sale',
    'if raw stamps already sorted correctly there would have been nothing to fix');
});

test('a missing or unreadable stamp becomes zero rather than NaN', () => {
  for (const bad of [undefined, null, '', 'yesterday', NaN]) {
    assert.strictEqual(secs(bad), 0, JSON.stringify(bad) + ' should normalise to 0');
  }
});

// --- what the page does with it ---------------------------------------------------------------

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

test('the page normalises the unit too, so one bad record cannot lie again', () => {
  assert.match(app, /Number\(ts\) > 1e11 \? Math\.round\(Number\(ts\) \/ 1000\) : Number\(ts\)/);
});

test('AND IT NO LONGER CLAMPS A FUTURE STAMP TO ZERO', () => {
  // The clamp is what made a wrong number look like a right one. Saying nothing beats "0s ago".
  assert.ok(!/Math\.max\(0, Math\.floor\(Date\.now\(\) \/ 1000\) - ts\)/.test(app),
    'the old clamp is still there and will keep hiding bad data');
  assert.match(app, /if \(s < 0\) return '';/);
});

// --- the feed itself ----------------------------------------------------------------------------

const book = fs.readFileSync(path.join(__dirname, '..', 'src', 'orderbook.js'), 'utf8');

test('the server emits one unit, so the client is a second line of defence and not the only one', () => {
  const fn = /activity\(limit = 50\) \{([\s\S]*?)\n  \}/.exec(book);
  assert.ok(fn, 'activity() should still exist');
  assert.match(fn[1], /const secs =/, 'the feed should normalise before it sorts');
  assert.ok(!/at: s\.at\b/.test(fn[1]), 'a raw sale stamp is still being passed through');
  assert.ok(!/at: l\.at\b/.test(fn[1]), 'a raw listing stamp is still being passed through');
});

console.log('\n' + passed + ' activity time tests passed');
