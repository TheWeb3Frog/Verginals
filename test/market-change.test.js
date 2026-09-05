// Volume and price change, and the places a "0" would be a lie.
//
// The site could say what things cost right now and nothing else, because nothing anywhere
// remembered yesterday. Two figures fix that, and they come from completely different places:
//
//   VOLUME is read off the sales log, which already carried a price and a timestamp. It is what
//   actually traded, the one number on a marketplace that wishful listing cannot produce.
//
//   CHANGE needs a history, so a sweep writes the floor down on a clock. That sweep has one rule
//   worth a test of its own: it must not record while the index is behind, because during a rescan
//   every market reads as having no price, and writing that down would carve a fictional crash and
//   recovery into every history on the site after every restart.
//
// The null contract itself is tested in test/pricelog.test.js. This file is about the wiring:
// that the server passes it through, and that neither page turns a null into a zero on the way
// to the screen.
//
// Run: node test/market-change.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const WEB = path.join(__dirname, '..', 'web');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const rm = fs.readFileSync(path.join(WEB, 'runes-market.js'), 'utf8');

test('the harness found all three files, so an empty check is not a pass', () => {
  assert.ok(server.length > 100000 && app.length > 80000 && rm.length > 8000);
});

// --- the sweep -----------------------------------------------------------------------------------

test('THE SWEEP REFUSES TO RECORD WHILE THE INDEX IS BEHIND', () => {
  // The rule that keeps every history on the site honest across a restart. A missing sample is a
  // hole; a wrong one is a lie that shows up later as a crash that never happened.
  const fn = /async function snapshotPrices\(\) \{[\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'snapshotPrices should exist');
  const guard = fn[0].indexOf('service.scannedThrough');
  const record = fn[0].indexOf('pricelog.record(');
  assert.ok(guard > 0 && record > guard, 'the scan check must come before the first recording');
  assert.match(fn[0], /return; \/\/ still reading/);
});

test('it runs on a clock, so a market nobody visits still gets a history', () => {
  assert.match(server, /setInterval\(snapshotPrices, 5 \* 60 \* 1000\)/);
  assert.match(server, /^\s*snapshotPrices\(\);$/m, 'and once at boot');
});

test('a sweep that throws does not take the server with it', () => {
  const fn = /async function snapshotPrices\(\) \{[\s\S]*?\n\}\n/.exec(server)[0];
  assert.match(fn, /catch \(e\) \{[\s\S]*?console\.warn/);
});

// --- what the endpoints promise --------------------------------------------------------------------

test('the collection endpoint sends the window figures and the change', () => {
  const fn = /async function handleCollectionMarket\([\s\S]*?\n\}\n/.exec(server)[0];
  for (const field of ['dayVolumeUnits', 'daySales', 'weekVolumeUnits', 'floorChange', 'trackedSince']) {
    assert.ok(fn.includes(field), 'missing ' + field);
  }
  assert.match(fn, /orderbook\.window\(DAY, slug\)/, 'the day figure comes from the sales log');
});

test('AND IT TAKES A SLUG, so a launchpad collection asks the same questions', () => {
  const fn = /async function handleCollectionMarket\([\s\S]*?\n\}\n/.exec(server)[0];
  assert.match(fn, /handleCollectionMarket\(res, slugParam\)/);
  assert.match(fn, /orderbook\.stats\(slug\)/);
  assert.match(fn, /pricelog\.changeOver\(collectionKey\(slug\), DAY\)/);
  assert.match(server, /handleCollectionMarket\(res, url\.searchParams\.get\('slug'\)\)/,
    'and the route has to pass it through');
});

test('the coin endpoint names its change for what it MEASURES', () => {
  // Coin swaps settle in the counterparty's own wallet and never touch this server, so a traded
  // price is not ours to report. Calling it a price change would claim otherwise.
  assert.match(server, /askChange24h/);
  assert.ok(!/priceChange24h/.test(server), 'that name would claim trades this server never saw');
  const fn = /async function handleRuneCoins\([\s\S]*?\n\}\n/.exec(server)[0];
  assert.match(fn, /c\.holders = coinHolders\.has/);
});

// --- holders are people, not outputs -------------------------------------------------------------------

test('HOLDERS COUNTS ADDRESSES, and says nothing when it has not looked yet', () => {
  // The directory has only ever counted carriers, so one wallet splitting a balance across ten
  // outputs read as ten holders. On the live chain one coin showed 108 and really had 17.
  const fn = /async function sweepHolders\(\) \{[\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'sweepHolders should exist');
  assert.match(fn[0], /new Set\(\)/, 'distinct addresses, not a count of outputs');
  assert.match(fn[0], /gettxout/, 'the address comes from the node, which is the only place it is');
  assert.match(fn[0], /if \(addrs\.size \|\| !looked\)/,
    'a node that answered nothing must not overwrite a true count with zero');
  assert.match(fn[0], /budget-- <= 0/, 'and one sweep is bounded');
});

// --- neither page turns a null into a zero -------------------------------------------------------------

test('THE VERGINALS MARKET DRAWS NOTHING WHEN THERE IS NO ANSWER', () => {
  const fn = /function changeChip\(change, since\) \{[\s\S]*?\n\}\n/.exec(app);
  assert.ok(fn, 'changeChip should exist');
  assert.match(fn[0], /if \(!change \|\| typeof change\.pct !== 'number'\) return null;/,
    'a null change must produce no element at all');
});

test('and the coin market draws a dash, never a percentage it does not have', () => {
  const fn = /function changeCell\(host, change\) \{[\s\S]*?\n\}\n/.exec(rm);
  assert.ok(fn, 'changeCell should exist');
  assert.match(fn[0], /box\.textContent = '-';/);
  assert.match(fn[0], /not enough price history yet/, 'and says why on hover');
});

test('a real zero is still shown, because a flat market is a fact', () => {
  const cell = /function changeCell\(host, change\) \{[\s\S]*?\n\}\n/.exec(rm)[0];
  assert.match(cell, /Math\.abs\(change\.pct\) < 0\.005/, 'flat is a case, not a missing value');
  assert.match(cell, /toFixed\(2\) \+ '%'/);
});

test('CONTROL: the sort puts coins with no change last rather than treating them as flat', () => {
  const fn = /if \(sort === 'change'\) \{[\s\S]*?\n  \}/.exec(rm);
  assert.ok(fn, 'the movers sort should exist');
  assert.match(fn[0], /if \(x === null\) return 1;/);
  assert.match(fn[0], /if \(y === null\) return -1;/);
  // And prove the ordering it produces, on the real comparator's shape.
  const pct = (c) => c.chg;
  const byNew = () => 0;
  const rows = [{ n: 'a', chg: null }, { n: 'b', chg: -30 }, { n: 'c', chg: 5 }];
  rows.sort((a, b) => {
    const x = pct(a), y = pct(b);
    if (x === null && y === null) return byNew(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return Math.abs(y) - Math.abs(x) || byNew(a, b);
  });
  assert.deepStrictEqual(rows.map((r) => r.n), ['b', 'c', 'a']);
});

// --- the small money formatter ---------------------------------------------------------------------------

test('a price under a hundredth of a cent is said in words, not in scientific notation', () => {
  // "$2.7e-7" was on the live page. It is not a price anybody reads.
  const src = /function usd\(xvg\) \{[\s\S]*?\n\}\n/.exec(rm)[0];
  const usd = new Function('usdRate', src + '; return usd;')(0.0029726);
  assert.strictEqual(usd(0.00009), '<$0.0001');
  assert.strictEqual(usd(1), '$0.002973');
  assert.strictEqual(usd(1000), '$2.97');
  assert.strictEqual(usd(1000000), '$2,973');
  assert.strictEqual(usd(0), '', 'nothing to convert, nothing said');
  const noRate = new Function('usdRate', src + '; return usd;')(null);
  assert.strictEqual(noRate(1000), '', 'no rate means no dollar figure, not a guess');
  assert.ok(!/e-/.test(usd(0.000000001)), 'no exponent may ever reach the page');
});

console.log('\n' + passed + ' market change tests passed');
