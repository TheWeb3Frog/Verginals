// Rune listing safety (RUNES-SPEC-v0 §9).
//
// The first test is the important one: it DEMONSTRATES the theft that the whole-carrier rule exists to
// prevent, using the real indexer rather than an argument. If that test ever stops showing the loss,
// the rule has become unnecessary; until then it is load-bearing.
//
// Run: node test/runes-swap.test.js
const assert = require('assert');
const { RuneState, applyTx: rawApplyTx, runeRefOf } = require('../src/runes/indexer');
// These histories are synthetic and sit at heights like 100, so the mainnet activation height and
// the maturity delay are switched off HERE, explicitly, rather than left to be discovered. The rules
// themselves are covered by test/runes-maturity.test.js against the real defaults.
const RELAXED = { activationHeight: 0, etchMaturity: 0 };
const applyTx = (state, tx, o) => rawApplyTx(state, tx, Object.assign({}, RELAXED, o));
const codec = require('../src/runes/codec');
const { lockFor } = require('./fixtures/etchlock');
const {
  PADDING_INDEX, CARRIER_INDEX, PRICE_INDEX,
  listingTerms, validateListing, takerEdicts, verifySettlement,
} = require('../src/runes/swap');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const DUST = 100000;
const REF = runeRefOf(100, 1);
const REF2 = runeRefOf(100, 2);
const out = (value, address) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false, address });
const opret = (d) => ({ value: 0, isOpReturn: true, opReturnData: d });

/** A maker holding 1000 FROG on one carrier. */
function maker() {
  const s = new RuneState();
  const paid = lockFor('FROG');
  applyTx(s, {
    txid: 'etch', height: 100, txIndex: 1, inputs: [], time: paid.time,
    outputs: [out(DUST, 'DMAKER'), paid.output],
    etching: { ticker: 'FROG', supply: 1000, premine: 1000, divisibility: 0, lock: paid.lock },
  });
  return s;
}

/** The marketplace output layout, plus whatever the taker chooses to append. */
const layout = (extra) => [
  out(2 * DUST, 'DBUYER'),  // 0 padding-out
  out(DUST, 'DBUYER'),      // 1 the buyer's new carrier
  out(300, 'DMAKER'),       // 2 the price, the only output the maker signed
  ...extra,
];

test('THE ATTACK: a partial listing lets the taker take everything', () => {
  // What an honest taker builds for a 300-of-1000 sale
  const honest = maker();
  applyTx(honest, {
    txid: 'honest', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: layout([
      out(DUST, 'DMAKER'), // 3 the maker's rune change
      opret(codec.encodeEdicts([
        { runeRef: REF, amount: 300, output: CARRIER_INDEX },
        { runeRef: REF, amount: 700, output: 3 },
      ])),
    ]),
  });
  assert.strictEqual(honest.balanceOf('honest:1', REF), 300);
  assert.strictEqual(honest.balanceOf('honest:3', REF), 700);

  // The same maker signature, and a taker who simply omits the OP_RETURN
  const robbed = maker();
  applyTx(robbed, {
    txid: 'robbed', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: layout([]),
  });
  assert.strictEqual(robbed.balanceOf(`robbed:${PADDING_INDEX}`, REF), 1000, 'the buyer should get everything');
  assert.strictEqual(robbed.balanceOf('robbed:3', REF), 0, 'the maker keeps nothing');
  // paid for 300, lost 1000: this is why §9.1 exists
});

test('a partial listing is refused outright', () => {
  const r = validateListing({ declared: { [REF]: 300 }, onChain: { [REF]: 1000 }, partialAmount: 300 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /whole carrier/);
});

test('with the whole carrier listed, a missing edict costs the maker nothing', () => {
  const s = maker();
  applyTx(s, {
    txid: 'whole', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: layout([]), // lazy taker, no OP_RETURN
  });
  // everything was for sale, so everything going to the buyer is the agreed outcome
  const toBuyer = s.balanceOf(`whole:${PADDING_INDEX}`, REF) + s.balanceOf(`whole:${CARRIER_INDEX}`, REF);
  assert.strictEqual(toBuyer, 1000);
  assert.strictEqual(verifySettlement({ state: s, txid: 'whole', declared: { [REF]: 1000 } }).ok, true);
});

test('the recommended taker edicts land the balance on the proper carrier', () => {
  const declared = { [REF]: 1000 };
  const s = maker();
  applyTx(s, {
    txid: 'tidy', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: layout([opret(codec.encodeEdicts(takerEdicts(declared)))]),
  });
  assert.strictEqual(s.balanceOf(`tidy:${CARRIER_INDEX}`, REF), 1000);
  assert.strictEqual(s.balanceOf(`tidy:${PADDING_INDEX}`, REF), 0);
});

test('listing terms sell everything the carrier holds', () => {
  const t = listingTerms({ [REF]: 1000, [REF2]: 5 });
  assert.deepStrictEqual(t.sells, [
    { runeRef: REF, amount: 1000 },
    { runeRef: REF2, amount: 5 },
  ]);
});

test('an outpoint carrying nothing is not a rune listing', () => {
  assert.throws(() => listingTerms({}), /carries no rune/);
});

test('a declaration that misses a second rune on the carrier is refused', () => {
  // the maker had forgotten REF2 was sitting on that coin
  const r = validateListing({ declared: { [REF]: 1000 }, onChain: { [REF]: 1000, [REF2]: 5 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /every rune/);
});

test('a declaration with the wrong amount is refused', () => {
  const r = validateListing({ declared: { [REF]: 999 }, onChain: { [REF]: 1000 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /chain says 1000/);
});

test('a declaration naming a rune that is not there is refused', () => {
  const r = validateListing({ declared: { [REF2]: 1000 }, onChain: { [REF]: 1000 } });
  assert.strictEqual(r.ok, false);
});

test('an honest, complete declaration is accepted', () => {
  assert.strictEqual(validateListing({ declared: { [REF]: 1000, [REF2]: 5 }, onChain: { [REF]: 1000, [REF2]: 5 } }).ok, true);
});

test('settlement verification catches a short delivery', () => {
  const s = maker();
  applyTx(s, {
    txid: 'short', height: 101, txIndex: 0,
    inputs: [{ txid: 'etch', vout: 0 }],
    outputs: layout([
      out(DUST, 'DELSEWHERE'),
      opret(codec.encodeEdicts([
        { runeRef: REF, amount: 400, output: CARRIER_INDEX },
        { runeRef: REF, amount: 600, output: 3 }, // 600 diverted away from the buyer
      ])),
    ]),
  });
  const r = verifySettlement({ state: s, txid: 'short', declared: { [REF]: 1000 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /buyer received 400/);
});

test('the layout indices are the ones the marketplace spec pins', () => {
  assert.strictEqual(PADDING_INDEX, 0);
  assert.strictEqual(CARRIER_INDEX, 1);
  assert.strictEqual(PRICE_INDEX, 2); // the maker's SIGHASH_SINGLE output
});

console.log('\nrunes swap: ' + passed + ' passed');
