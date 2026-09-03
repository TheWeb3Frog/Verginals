// How many mints one click may chain.
//
// Each mint is its own transaction spending the change of the one before, so asking for N is asking
// the mempool to hold a chain of N unconfirmed ancestors. The ceiling was twenty, reasoned from a
// limit of twenty five borrowed from Bitcoin that this chain does not report and does not
// configure. Runs never got past about ten.
//
// The number lives in TWO files, and that is the thing worth testing: the page offers a count and
// the wallet enforces one, and if the page ever offers more than the wallet will build, somebody
// pays for mints that were never going to be broadcast.
//
// Run: node test/mint-chain-limit.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'runes-mint.js'), 'utf8');
const wallet = fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'wallet.js'), 'utf8');

const pageLimit = () => {
  const m = /const CHAIN_LIMIT = (\d+);/.exec(page);
  return m ? Number(m[1]) : null;
};
const walletLimit = () => {
  const m = /const MAX_CHAINED_MINTS = (\d+);/.exec(wallet);
  return m ? Number(m[1]) : null;
};

test('the harness finds both numbers, so an empty check is not a pass', () => {
  assert.ok(pageLimit() !== null, 'the page should name its ceiling');
  assert.ok(walletLimit() !== null, 'the wallet should name its ceiling');
});

test('the stepper offers ten', () => {
  assert.strictEqual(pageLimit(), 10);
});

test('THE PAGE NEVER OFFERS MORE THAN THE WALLET WILL BUILD', () => {
  // The wallet clamps with Math.min, so anything above its own limit is silently dropped. A page
  // offering 20 against a wallet capped at 10 would take the press, charge for ten, and leave
  // somebody counting the difference.
  assert.ok(pageLimit() <= walletLimit(),
    `the page offers ${pageLimit()} but the wallet builds at most ${walletLimit()}`);
});

test('the ceiling is still bounded by what is left to claim', () => {
  // A coin with three claims left must not offer ten.
  assert.match(page, /Math\.min\(CHAIN_LIMIT, m\.remaining == null \? CHAIN_LIMIT : m\.remaining\)/);
});

test('the wallet still clamps whatever it is asked for', () => {
  assert.match(wallet, /Math\.min\(MAX_CHAINED_MINTS, Number\(times\) \|\| 1\)/);
});

test('a run that stops early still reports what really landed', () => {
  // Going over is meant to cost a confusing message, never money that bought nothing.
  assert.match(wallet, /stoppedBecause/);
  assert.match(wallet, /if \(!done\.length\) throw e;/);
});

test('CONTROL: a page ceiling above the wallet is caught', () => {
  const bad = page.replace('const CHAIN_LIMIT = 10;', 'const CHAIN_LIMIT = 20;');
  const n = Number(/const CHAIN_LIMIT = (\d+);/.exec(bad)[1]);
  assert.ok(!(n <= walletLimit()), 'the comparison would not have noticed a page offering 20');
});

console.log(`\n${passed} mint chain limit tests passed`);
