// What a mint costs to claim, by default.
//
// The etcher sets a price that a claim must pay as an ordinary transaction fee. It started at
// 20 XVG, came down to 1, and is now 0: almost nobody was claiming, and the price is the only thing
// standing between somebody and a mint.
//
// Zero has to be a real, valid choice all the way down, not just a number the form accepts. The
// indexer must count a price-free claim, and the form must not quietly write a price of 0 into the
// etching, because "no price" and "a price of zero" are different payloads.
//
// Run: node test/etch-price-default.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'web', 'etch.js'), 'utf8');

test('the form opens on a free mint', () => {
  const m = /<input id="et-price"[^>]*value="([^"]*)"/.exec(html);
  assert.ok(m, 'the price field should exist');
  assert.strictEqual(m[1], '0', 'the recommended mint price is zero');
});

test('the page does not still recommend a number it no longer defaults to', () => {
  assert.ok(!/1 XVG is the recommendation/.test(html),
    'the note still recommends 1 XVG while the field says 0');
  assert.ok(/Zero is the recommendation/.test(html));
});

test('and it says what zero costs the etcher, because nothing else limits a mint', () => {
  // The claim cap was removed from this form, so a price is genuinely the only friction left.
  assert.match(js, /const cap = null;/, 'if a cap comes back, this warning needs revisiting');
  assert.match(html, /one person can take your whole supply/);
});

test('a price of zero is written as NO price, not as a price of zero', () => {
  assert.match(js, /if \(f\.mintPrice > 0\) payload\.terms\.price = f\.mintPrice;/);
});

test('zero is accepted by the form rather than rejected as missing', () => {
  assert.match(js, /mintPrice < 0/, 'only a negative price should be refused');
  assert.ok(!/mintPrice <= 0/.test(js), 'a zero price must not be treated as invalid');
});

// --- the rule the chain actually applies ------------------------------------------------------

const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer');
const codec = require('../src/runes/codec');

test('THE INDEXER COUNTS A FREE CLAIM, with no fee resolved at all', () => {
  const H = codec.ACTIVATION_HEIGHT + 10;
  const ref = runeRefOf(H, 1);
  const state = new RuneState();
  state.runes.set(ref, {
    runeRef: ref, ticker: 'FREE', divisibility: 0, supply: 1000, premine: 0,
    minted: 0, mintCount: 0, terms: { amount: 100 },   // no price at all
  });
  const out = (v) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });
  applyTx(state, {
    txid: 'claim', height: H + 20, txIndex: 1, inputs: [],
    // fee deliberately absent: a free mint must not depend on the fee being resolvable
    outputs: [out(100000), { value: 0, scriptPubKey: Buffer.from('6a', 'hex'), isOpReturn: true, opReturnData: codec.encodeMint(ref) }],
  });
  assert.strictEqual(state.balanceOf('claim:0', ref), 100, 'the free claim was credited');
  assert.strictEqual(state.runes.get(ref).mintCount, 1);
});

test('CONTROL: a PRICED claim with no resolvable fee is still refused', () => {
  const H = codec.ACTIVATION_HEIGHT + 10;
  const ref = runeRefOf(H, 2);
  const state = new RuneState();
  state.runes.set(ref, {
    runeRef: ref, ticker: 'PAID', divisibility: 0, supply: 1000, premine: 0,
    minted: 0, mintCount: 0, terms: { amount: 100, price: 1000000 },
  });
  const out = (v) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });
  applyTx(state, {
    txid: 'claim2', height: H + 20, txIndex: 1, inputs: [],
    outputs: [out(100000), { value: 0, scriptPubKey: Buffer.from('6a', 'hex'), isOpReturn: true, opReturnData: codec.encodeMint(ref) }],
  });
  assert.strictEqual(state.balanceOf('claim2:0', ref), 0,
    'a priced mint must fail closed when the fee cannot be established');
});

console.log(`\n${passed} etch price tests passed`);
