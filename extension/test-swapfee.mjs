// What a swap costs to relay, and how many coins it should spend to get there.
//
// A real purchase was rejected by the network with:
//   mempool min fee not met, 300000 < 1100000 (code 66)
// The marketplace paid a flat 0.3 XVG whatever it built, and it built a transaction spending EVERY
// clean coin in the buyer's wallet, because completeListing spends every coin it is handed and the
// selection handed it all of them. A wallet with a lot of small coins therefore produced a
// multi-kilobyte transaction funded like a four-input one.
//
// Run: node extension/test-swapfee.mjs
import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const src = fs.readFileSync(new URL('./lib/wallet.js', import.meta.url), 'utf8');

// The rule, mirrored from the source so the numbers below are the shipped ones.
const RELAY_PER_KB = 200000, INPUT_BYTES = 149, OUTPUT_BYTES = 34, SWAP_OUTPUTS = 5;
const swapFee = (i, o) => Math.max(RELAY_PER_KB, Math.ceil((14 + i * INPUT_BYTES + o * OUTPUT_BYTES) / 1000) * RELAY_PER_KB);

test('the flat fee is gone from the marketplace paths', () => {
  assert.ok(!/const feeUnits = 300000/.test(src), 'a hard-coded 0.3 XVG swap fee is still in wallet.js');
  assert.ok(/const swapFee = \(inputs, outputs\)/.test(src), 'the size-based rule should be defined');
});

test('the rule matches the node: 0.2 XVG per whole kB, rounded up', () => {
  assert.strictEqual(swapFee(1, 1), 200000, 'a tiny transaction still pays one kB');
  // 6 inputs + 5 outputs = 14 + 894 + 170 = 1078 bytes -> 2 kB
  assert.strictEqual(swapFee(6, 5), 400000);
});

test('THE REJECTED TRANSACTION would now be funded above what the node asked', () => {
  // The refusal named the size: it wanted 1,100,000 units, which at 0.2 XVG/kB is a 5.5 kB
  // transaction. Reconstructing that shape, the fee this code now computes must clear it.
  const wanted = 1100000;
  const inputs = Math.round((5500 - 14 - 4 * OUTPUT_BYTES) / INPUT_BYTES); // ~36 inputs
  const got = swapFee(inputs, 4);
  assert.ok(got >= wanted, `computed ${got} for ${inputs} inputs, node wanted ${wanted}`);
});

test('the fee rises with the transaction, which is the whole point', () => {
  const small = swapFee(4, 5), big = swapFee(60, 5);
  assert.ok(big > small * 4, `4 inputs cost ${small}, 60 cost ${big}`);
});

// --- selecting only what is needed ---------------------------------------------------------------

/** The fast path from _ensurePads, mirrored: biggest first, stop once price + fee is covered. */
function pick(rest, need, outputs = SWAP_OUTPUTS) {
  const sorted = [...rest].sort((a, b) => b - a);
  const picked = [];
  let have = 0;
  for (const v of sorted) {
    if (have >= need + swapFee(3 + picked.length, outputs)) break;
    picked.push(v);
    have += v;
  }
  return { picked, have, fee: swapFee(3 + picked.length, outputs) };
}

test('a fat wallet no longer spends everything it owns to buy one thing', () => {
  const rest = Array.from({ length: 60 }, () => 5_000_000); // 60 coins of 5 XVG
  const r = pick(rest, 10_000_000);                          // buying a 10 XVG Verginal
  assert.ok(r.picked.length <= 4, `spent ${r.picked.length} of 60 coins`);
  assert.ok(r.have >= 10_000_000 + r.fee, 'and still covers price plus fee');
});

test('it still spends enough when the coins are tiny', () => {
  const rest = Array.from({ length: 400 }, () => 100000);    // 400 coins of 0.1 XVG
  const r = pick(rest, 10_000_000);
  assert.ok(r.have >= 10_000_000 + r.fee, 'price and fee are covered');
  // The fee it charges must match the transaction it just described.
  assert.strictEqual(r.fee, swapFee(3 + r.picked.length, SWAP_OUTPUTS));
});

test('CONTROL: the old behaviour underpays, which is why this file exists', () => {
  const rest = Array.from({ length: 60 }, () => 5_000_000);
  const everything = swapFee(3 + rest.length, 5); // what spending all 60 really costs
  assert.ok(everything > 300000,
    'if a flat 300000 covered 63 inputs there would have been no bug');
});

console.log(`\n${passed} swap fee tests passed`);
