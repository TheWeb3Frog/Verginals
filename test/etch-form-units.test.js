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

/**
 * Run the cap's consequence block, the same way: the source, executed, not matched.
 *
 * This is the second field on this form whose damage is silent, and it is worse than the first. A
 * wrong per-claim amount makes a coin unattractive; a cap read as a per-person limit makes most of
 * the supply impossible, and an etching cannot be revised.
 */
function readStranding({ supply, div, per, cap, keep = 0, open = true, acknowledged = false }) {
  const n = readNumbers({ supply, div, per, cap, price: 1, keep, open });
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.js'), 'utf8');
  const from = src.indexOf('  const claimable = supplyOk');
  assert.ok(from > 0, 'the cap consequence block could not be located');
  const to = src.indexOf('\n  }', src.indexOf('clear the cap')) + 4;
  const block = src.slice(from, to);

  const problems = [];
  const $ = () => ({ checked: acknowledged });
  // eslint-disable-next-line no-new-func
  const run = new Function('supplyOk', 'supply', 'premine', 'open', 'cap', 'perMint', 'problems', '$',
    block + '\nreturn { claimable, mintable, stranded };');
  const r = run(Number.isInteger(n.supply) && n.supply > 0, n.supply, n.premine, open, n.cap,
    n.perMint, problems, $);
  return { ...r, problems, scale: n.scale };
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

test('a cap is a COUNT of claims and is never scaled', () => {
  const r = readNumbers({ supply: 1000, div: 6, per: 10, cap: 50, price: 1 });
  assert.strictEqual(r.cap, 50, 'fifty claims, not fifty million');
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

test('THE ONE THAT CLOSED A COIN: a cap of 5 strands a 21,000 supply', () => {
  // SUNEROKTHEDEVGOAT, etched for real: 21,000 supply, no decimals, 5 coins a claim, cap 5. The
  // etcher meant five claims per person. What they got was five claims in total, so the coin closed
  // for ever with 25 coins in existence and the rest unreachable by anyone.
  const r = readStranding({ supply: 21000, div: 0, per: 5, cap: 5, keep: 10 });
  assert.strictEqual(r.claimable, 18900, 'the open supply after a 10 percent premine');
  assert.strictEqual(r.mintable, 25, 'five claims of five coins is all the cap ever allows');
  assert.strictEqual(r.stranded, 18875, 'and everything else is unreachable for ever');
  assert.ok(r.problems.length > 0, 'the form must refuse to send this quietly');
});

test('the refusal names the cap, so it cannot be read as a supply problem', () => {
  const r = readStranding({ supply: 21000, div: 0, per: 5, cap: 5 });
  assert.match(r.problems.join(' '), /cap/);
});

test('no cap strands nothing, which is what almost every coin wants', () => {
  const r = readStranding({ supply: 9420420, div: 2, per: 1000, cap: null });
  assert.strictEqual(r.stranded, 0);
  assert.strictEqual(r.mintable, r.claimable);
  assert.strictEqual(r.problems.length, 0);
});

test('a cap larger than the supply needs is harmless and is not flagged', () => {
  // 9,420,420 coins at 1000 a claim is 9,420 claims. A cap of 50,000 changes nothing, and warning
  // about it would train people to tick the box without reading it.
  const r = readStranding({ supply: 9420420, div: 2, per: 1000, cap: 50000 });
  assert.strictEqual(r.stranded, 0);
  assert.strictEqual(r.problems.length, 0);
});

test('a cap that lands exactly on the supply is not flagged either', () => {
  const r = readStranding({ supply: 10000, div: 0, per: 100, cap: 100 });
  assert.strictEqual(r.mintable, 10000);
  assert.strictEqual(r.stranded, 0);
  assert.strictEqual(r.problems.length, 0);
});

test('the stranded amount is counted in atomic units, like everything else on the wire', () => {
  const r = readStranding({ supply: 100000, div: 2, per: 1000, cap: 10 });
  assert.strictEqual(r.mintable, 1000000, 'atomic units');
  assert.strictEqual(r.mintable / r.scale, 10000, 'which is ten thousand coins');
  assert.strictEqual(r.stranded / r.scale, 90000, 'and ninety thousand that cannot exist');
});

test('ticking the box lets a deliberate stranding through', () => {
  // A deliberately capped supply is a real design, so this is a confirmation and never a ban.
  const r = readStranding({ supply: 21000, div: 0, per: 5, cap: 5, acknowledged: true });
  assert.ok(r.stranded > 0, 'the stranding is still real and still reported');
  assert.strictEqual(r.problems.length, 0, 'but it is no longer an accident');
});

test('a closed mint is not measured against a cap it does not have', () => {
  const r = readStranding({ supply: 21000, div: 0, per: 5, cap: 5, keep: 100, open: false });
  assert.strictEqual(r.stranded, 0);
  assert.strictEqual(r.problems.length, 0);
});

console.log(`\n${passed} passed`);
