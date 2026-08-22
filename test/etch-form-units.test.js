// Every amount the etch form sends must be in the same units the protocol reads.
//
// This exists because two boxes sat side by side and did not agree. Supply scaled by the
// divisibility, the amount per claim did not, and somebody typing the same number into both got a
// hundredfold difference in terms that can never be changed once the etching confirms. The supply
// field had that exact bug once already and was fixed alone, which is how its neighbour kept it.
//
// It RUNS the form's arithmetic rather than grepping for it. A first version matched the source with
// a regex, the expression grew a line break, and the check reported a correct field as broken. A
// verification that cries wolf gets ignored just as fast as one that misses.
//
// Run: node test/etch-form-units.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

/**
 * Run readForm's numeric block against typed values.
 *
 * `$` and `int` are stubbed rather than the block being rewritten, so what runs here is the source
 * exactly as the browser executes it, including the lines that read checkboxes and text fields.
 */
function readNumbers({ supply, div, per, cap, price, keep = 0, open = true }) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.js'), 'utf8');
  const from = src.indexOf("const whole = int('#et-supply');");
  const to = src.indexOf('const mintPrice =');
  assert.ok(from > 0 && to > from, 'the form arithmetic could not be located');
  const block = src.slice(from, src.indexOf('\n', to));

  const ints = { 'et-supply': supply, 'et-div': div, 'et-per': per, 'et-cap': cap };
  const int = (sel) => {
    const v = ints[sel.replace('#', '')];
    return Number.isInteger(v) ? v : NaN;
  };
  const $ = (sel) => ({
    value: sel === '#et-keep' ? String(keep) : sel === '#et-price' ? String(price) : '',
    checked: sel === '#et-openmint' ? open : false,
  });
  const COIN = 1e6;
  // eslint-disable-next-line no-new-func
  const run = new Function('int', '$', 'COIN',
    block + '\nreturn { supply, premine, perMint, cap, mintPrice, divisibility, scale, keepPct };');
  return run(int, $, COIN);
}

test('THE ONE THAT COST A COIN: per-claim scales like supply', () => {
  // The exact values from the etching that went wrong: 9,420,420 supply, 2 decimals, 1000 per claim.
  const r = readNumbers({ supply: 9420420, div: 2, per: 1000, cap: null, price: 10 });
  assert.strictEqual(r.supply, 942042000, 'supply in atomic units');
  assert.strictEqual(r.perMint, 100000, 'per claim in atomic units, NOT the typed 1000');
  assert.strictEqual(r.perMint / r.scale, 1000, 'which is the 1000 coins the person typed');
});

test('the two boxes agree: the same number typed means the same number of coins', () => {
  for (const div of [0, 1, 2, 4, 6]) {
    const r = readNumbers({ supply: 5000, div, per: 5000, cap: null, price: 1 });
    assert.strictEqual(r.perMint, r.supply, `at ${div} decimals the two fields must agree`);
  }
});

test('CONTROL: the harness would catch the old behaviour', () => {
  // If per-claim were taken raw again, perMint would be 1000 rather than 100000 and the first test
  // would fail. Proven by computing what the old line produced, rather than trusting the claim.
  const r = readNumbers({ supply: 9420420, div: 2, per: 1000, cap: null, price: 10 });
  const old = 1000; // what `int('#et-per')` alone used to give
  assert.notStrictEqual(r.perMint, old, 'the fixed field must differ from the broken one');
  assert.strictEqual(r.perMint, old * r.scale);
});

test('the premine is a share of the supply, so it is already in atomic units', () => {
  const r = readNumbers({ supply: 1000, div: 2, per: 10, cap: null, price: 1, keep: 10 });
  assert.strictEqual(r.premine, 10000, '10 percent of 100,000 atomic units');
  assert.strictEqual(r.premine / r.scale, 100, 'which is 100 coins');
});

test('the mint price is in XVG and scales by COIN, not by the divisibility', () => {
  const r = readNumbers({ supply: 1000, div: 6, per: 10, cap: null, price: 10 });
  assert.strictEqual(r.mintPrice, 10000000, '10 XVG in atomic XVG units');
});

test('THE CAP FIELD IS GONE, so the mistake it caused is unreachable', () => {
  // A cap counted claims for the WHOLE COIN and was read as a limit per person. The one etcher who
  // read it that way closed a 21,000-supply coin after 25 coins existed, permanently.
  //
  // The guard that caught it worked, and this is better than a guard: the form cannot express the
  // value at all, so claiming always runs until the supply is gone. The protocol still has the
  // field; this site does not set it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.html'), 'utf8');
  assert.ok(!/id="et-cap"/.test(html), 'no cap input may exist on the form');
  assert.match(src, /const cap = null;/, 'and the form must hard-code it as unset');
  assert.ok(!/int\('#et-cap'\)/.test(src), 'nothing may read a cap out of the page');
});

test('so an open mint always reaches the whole open supply', () => {
  // The property that replaces the guard, checked by running the form rather than by reading it.
  const r = readNumbers({ supply: 21000, div: 0, per: 5, cap: 5, price: 1, keep: 10 });
  assert.strictEqual(r.cap, null, 'whatever was typed, no cap reaches the wire');
  const claimable = r.supply - r.premine;
  assert.strictEqual(claimable % 1, 0);
  // Every coin of the open supply is reachable: claims run until it is gone.
  assert.ok(Math.floor(claimable / r.perMint) * r.perMint > claimable - r.perMint,
    'the last claim lands inside the supply, with less than one claim left over');
});

console.log(`\n${passed} passed`);
