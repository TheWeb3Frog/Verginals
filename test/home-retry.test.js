// The front door has to survive a server that is still waking up.
//
// Every request loadHome makes swallows its own failure, so one slow endpoint cannot take the page
// down. That is right, and it had a consequence: a TOTAL failure painted an empty page and then
// never tried again, because the "already loaded" flag was set before the work rather than after it.
//
// A restart costs a full rescan, and during one the inscriptions endpoint is slow enough for the
// proxy to answer 504. So the page went blank on exactly the occasions somebody was most likely to
// be looking at it: right after a deploy.
//
// Run: node test/home-retry.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const fn = /async function loadHome\(\) \{([\s\S]*?)\n\}\n/.exec(app);

test('the harness found loadHome, so an empty check is not a pass', () => {
  assert.ok(fn, 'loadHome should exist');
  assert.ok(fn[1].length > 400, 'and it should be the real one');
});

test('THE LOADED FLAG IS NOT SET BEFORE THE WORK', () => {
  const body = fn[1];
  const guard = body.indexOf('if (homeLoaded || homeLoading) return;');
  const fetches = body.indexOf('await Promise.all');
  const marked = body.indexOf('homeLoaded = true;');
  assert.ok(guard >= 0, 'it should still refuse to run twice');
  assert.ok(fetches >= 0, 'it should still fetch');
  assert.ok(marked > fetches,
    'homeLoaded is set before the fetches, so one failure blanks the page for the whole visit');
});

test('a total failure schedules another go rather than giving up', () => {
  assert.match(fn[1], /if \(!ins && !mint && !coins\) \{[\s\S]*?setTimeout\(loadHome, \d+\)/);
});

test('and a second call while one is in flight does not start a third', () => {
  // Without this the retry and a tab click could both be fetching, and the later one would paint
  // over the earlier one's work halfway through.
  assert.match(app, /let homeLoading = false;/);
  assert.match(fn[1], /homeLoading = true;/);
  assert.match(fn[1], /homeLoading = false;/);
});

test('CONTROL: the old shape would fail this check', () => {
  const oldShape = `
    if (homeLoaded) return;
    homeLoaded = true;
    const x = await Promise.all([]);
  `;
  const marked = oldShape.indexOf('homeLoaded = true;');
  const fetches = oldShape.indexOf('await Promise.all');
  assert.ok(!(marked > fetches), 'the comparison would not have caught the original bug');
});

console.log('\n' + passed + ' home retry tests passed');
