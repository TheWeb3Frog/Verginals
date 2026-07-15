// Marketplace swap primitives: listing half-signatures (SINGLE|ANYONECANPAY), completion,
// tamper resistance, the padded constant-postage layout, and legacy sighash edge cases.
// Run: node test/swap.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { legacySighash, SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } = require('../src/vergetx');
const { buildListing, completeListing, buildListingSchedule, pickVariant, buildBid, acceptBid, SELLER_INDEX, LISTING_SIGHASH, POSTAGE_UNITS } = require('../src/swap');
const { Indexer } = require('../src/indexer');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const H = (c) => c.repeat(64);

const carrier = { txid: H('a'), vout: 0, value: 2_100_000 };
const mkListing = (over = {}) => buildListing(Object.assign({
  network, carrier, priceUnits: 150_000_000, sellerAddress: addr(seller), sellerKey: seller, time: 1_783_000_000,
}, over));
const mkComplete = (listing, over = {}) => completeListing(Object.assign({
  network,
  listing,
  pads: [{ txid: H('b'), vout: 1, value: 150_000 }, { txid: H('d'), vout: 3, value: 120_000 }],
  funds: [{ txid: H('c'), vout: 0, value: 200_000_000 }],
  buyerAddress: addr(buyer),
  buyerKey: buyer,
  feeUnits: 200_000,
  carrierOffset: 0,
}, over));

// --- listing + completion ------------------------------------------------------------------
test('a listing completes into a balanced, constant-postage transaction', () => {
  const l = mkListing();
  const done = mkComplete(l);
  assert.ok(/^[0-9a-f]+$/.test(done.hex));
  const padOut = 150_000 + 120_000 + 0; // pads + offset
  // vout[0] = padding-out, vout[1] = POSTAGE (new carrier), vout[2] = price, vout[3] = change
  assert.strictEqual(done.outputs[0].value, padOut);
  assert.strictEqual(done.outputs[1].value, POSTAGE_UNITS);
  assert.strictEqual(done.outputs[2].value, 150_000_000);
  const totalIn = 150_000 + 120_000 + carrier.value + 200_000_000;
  assert.strictEqual(done.outputs[3].value, totalIn - padOut - POSTAGE_UNITS - 150_000_000 - 200_000);
});

test('the seller half-signature is invariant to every buyer-controlled slot', () => {
  const l = mkListing();
  mkComplete(l);
  mkComplete(l, {
    pads: [{ txid: H('d'), vout: 7, value: 130_000 }, { txid: H('9'), vout: 2, value: 110_000 }],
    funds: [{ txid: H('e'), vout: 2, value: 180_000_000 }, { txid: H('f'), vout: 0, value: 30_000_000 }],
    buyerAddress: addr(ECPair.makeRandom({ network })),
    buyerKey: buyer,
    feeUnits: 300_000,
    carrierOffset: 0,
  });
});

test('completion requires exactly two pad coins', () => {
  const l = mkListing();
  assert.throws(() => mkComplete(l, { pads: [{ txid: H('b'), vout: 1, value: 150_000 }] }), /exactly 2/);
});

test('tampering with the price breaks the seller signature', () => {
  const l = mkListing();
  l.priceUnits = 1_000_000; // buyer tries to pay less than signed
  assert.throws(() => mkComplete(l), /does not verify/);
});

test('tampering with the seller payout address breaks the signature', () => {
  const l = mkListing();
  l.sellerAddress = addr(buyer); // redirect the payment
  assert.throws(() => mkComplete(l), /does not verify/);
});

test('tampering with the pinned nTime breaks the signature', () => {
  const l = mkListing();
  l.time += 1;
  assert.throws(() => mkComplete(l), /does not verify/);
});

test('completion refuses underfunded buys', () => {
  const l = mkListing();
  assert.throws(() => mkComplete(l, { funds: [{ txid: H('c'), vout: 0, value: 100_000_000 }] }), /do not cover/);
});

// --- the invariant: the locked postage never grows, the inscription resets to offset 0 -------
//
// Follows the inscribed sat with the SAME FIFO rule the indexer uses (Indexer.assignToOutput):
// its global unit offset across the ordered inputs, mapped onto the ordered outputs. Proves the
// sat always lands on vout[1] at offset 0 and the carrier stays exactly one POSTAGE, even when
// starting from a heavily bloated, drifted carrier.
function landing(padValues, fundValues, carrierValue, carrierOffset, outputs) {
  // global offset of the inscribed sat = all inputs before the carrier + its internal offset
  const preCarrier = padValues.reduce((s, v) => s + v, 0);
  const globalOffset = preCarrier + carrierOffset;
  return Indexer.assignToOutput(globalOffset, outputs.map((o) => ({ value: o.value })));
}

test('repeated trades keep the carrier at one postage and the inscription at offset 0', () => {
  let cur = { txid: H('a'), vout: 0, value: 2_100_000, offset: 0 }; // fresh mint: offset 0
  const padValues = [150_000, 120_000];
  for (let round = 0; round < 6; round++) {
    const l = buildListing({ network, carrier: cur, priceUnits: 5_000_000, sellerAddress: addr(seller), sellerKey: seller, time: 1_783_000_000 });
    const done = completeListing({
      network, listing: l,
      pads: [{ txid: H('b'), vout: 1, value: padValues[0] }, { txid: H('e'), vout: 2, value: padValues[1] }],
      funds: [{ txid: H('c'), vout: 0, value: 10_000_000 }],
      buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, carrierOffset: cur.offset,
    });
    const land = landing(padValues, [10_000_000], cur.value, cur.offset, done.outputs);
    assert.strictEqual(land.vout, 1, `round ${round}: inscription must land on the new carrier`);
    assert.strictEqual(land.offset, 0, `round ${round}: inscription must reset to offset 0`);
    assert.strictEqual(done.outputs[1].value, POSTAGE_UNITS, `round ${round}: postage must stay constant`);
    // the new carrier for the next hop is vout[1]
    cur = { txid: done.txid, vout: 1, value: done.outputs[1].value, offset: land.offset };
  }
});

test('a bloated, drifted carrier is healed back to one postage in a single trade', () => {
  // Simulate the OLD bug's end state: value inflated by many absorbed dummies, inscription drifted
  // deep into the carrier. One v2 trade must recover the excess and reset it.
  const bloated = { txid: H('a'), vout: 0, value: 3_000_000, offset: 2_400_000 };
  const l = buildListing({ network, carrier: bloated, priceUnits: 5_000_000, sellerAddress: addr(seller), sellerKey: seller, time: 1_783_000_000 });
  const padValues = [150_000, 120_000];
  const funds = [{ txid: H('c'), vout: 0, value: 10_000_000 }];
  const done = completeListing({
    network, listing: l,
    pads: [{ txid: H('b'), vout: 1, value: padValues[0] }, { txid: H('e'), vout: 2, value: padValues[1] }],
    funds, buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, carrierOffset: bloated.offset,
  });
  const land = landing(padValues, [10_000_000], bloated.value, bloated.offset, done.outputs);
  assert.strictEqual(land.vout, 1);
  assert.strictEqual(land.offset, 0);
  assert.strictEqual(done.outputs[1].value, POSTAGE_UNITS);
  // the excess that used to be locked is returned to the buyer, not burned or lost to the seller
  assert.strictEqual(done.outputs[2].value, 5_000_000); // seller still gets exactly the price
});

test('completion refuses a carrier too small to reset onto a fresh postage', () => {
  const tiny = { txid: H('a'), vout: 0, value: 90_000 }; // below one postage
  const l = buildListing({ network, carrier: tiny, priceUnits: 5_000_000, sellerAddress: addr(seller), sellerKey: seller, time: 1_783_000_000 });
  assert.throws(() => completeListing({
    network, listing: l,
    pads: [{ txid: H('b'), vout: 1, value: 150_000 }, { txid: H('e'), vout: 2, value: 120_000 }],
    funds: [{ txid: H('c'), vout: 0, value: 10_000_000 }],
    buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, carrierOffset: 0,
  }), /too small/);
});

// --- listing variant schedule ----------------------------------------------------------------
test('a listing schedule signs one working variant per timestamp', () => {
  const sched = buildListingSchedule({
    network, carrier, priceUnits: 150_000_000, sellerAddress: addr(seller), sellerKey: seller,
    startTime: 1_783_000_000, offsets: [0, 3600, 86400],
  });
  assert.strictEqual(sched.variants.length, 3);
  assert.strictEqual(sched.expiresAt, 1_783_000_000 + 86400);
  for (const v of sched.variants) {
    const one = pickVariant(sched, { now: v.time, maxCoinTime: 0 });
    assert.strictEqual(one.time, v.time);
    mkComplete(one);
  }
});

test('pickVariant honours both the now ceiling and the coin-age floor', () => {
  const sched = buildListingSchedule({
    network, carrier, priceUnits: 150_000_000, sellerAddress: addr(seller), sellerKey: seller,
    startTime: 1000, offsets: [0, 100, 200, 300],
  });
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 0 }).time, 1200);
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 1150 }).time, 1200);
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 1210 }), null);
  assert.strictEqual(pickVariant(sched, { now: 999, maxCoinTime: 0 }), null);
});

// --- bids -------------------------------------------------------------------------------------
const mkBid = (over = {}) => buildBid(Object.assign({
  network, carrier, priceUnits: 120_000_000, sellerAddress: addr(seller),
  pads: [{ txid: H('b'), vout: 1, value: 150_000 }, { txid: H('d'), vout: 3, value: 120_000 }],
  funds: [{ txid: H('c'), vout: 0, value: 200_000_000 }],
  buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, carrierOffset: 0, time: 1_783_100_000,
}, over));

test('a bid is accepted by the seller into a broadcastable transaction', () => {
  const bid = mkBid();
  assert.strictEqual(bid.kind, 'verginals-bid-v2');
  assert.ok(bid.scriptSigs[0] && bid.scriptSigs[1] && !bid.scriptSigs[SELLER_INDEX]); // carrier unsigned
  const done = acceptBid({ network, bid, sellerKey: seller });
  assert.ok(/^[0-9a-f]+$/.test(done.hex) && /^[0-9a-f]{64}$/.test(done.txid));
});

test('an accepted bid also lands the inscription on a fresh constant postage', () => {
  const bid = mkBid();
  // vout: padding-out, postage, price, change
  assert.strictEqual(bid.vout[1].value, POSTAGE_UNITS);
  assert.strictEqual(bid.vout[2].value, 120_000_000);
  const land = Indexer.assignToOutput(150_000 + 120_000 + 0, bid.vout.map((o) => ({ value: o.value })));
  assert.strictEqual(land.vout, 1);
  assert.strictEqual(land.offset, 0);
});

test('a bid can carry an optional service-fee output', () => {
  const feeAddr = addr(ECPair.makeRandom({ network }));
  const bid = mkBid({ feeOutput: { address: feeAddr, value: 5_000_000 } });
  // vout: padding-out, postage, price, fee, change
  assert.strictEqual(bid.vout.length, 5);
  assert.strictEqual(bid.vout[3].value, 5_000_000);
  acceptBid({ network, bid, sellerKey: seller });
});

test('buildBid refuses an underfunded offer', () => {
  assert.throws(() => mkBid({ funds: [{ txid: H('c'), vout: 0, value: 100_000_000 }] }), /do not cover/);
});

// --- legacy sighash edge cases ---------------------------------------------------------------
const baseTx = () => ({
  version: 1, time: 1_783_000_000, locktime: 0,
  vin: [{ txid: H('1'), vout: 0 }, { txid: H('2'), vout: 1 }],
  vout: [{ value: 1000, script: Buffer.from([0x51]) }, { value: 2000, script: Buffer.from([0x52]) }],
});
const code = Buffer.from([0x51]);

test('SINGLE|ANYONECANPAY ignores other inputs and lower outputs', () => {
  const a = baseTx();
  const h1 = legacySighash(a, 1, code, LISTING_SIGHASH);
  const b = baseTx();
  b.vin[0] = { txid: H('9'), vout: 5 };
  b.vout[0] = { value: 999999, script: Buffer.from([0x53]) };
  b.vin.push({ txid: H('8'), vout: 0 });
  const h2 = legacySighash(b, 1, code, LISTING_SIGHASH);
  assert.deepStrictEqual(h1, h2);
});

test('SINGLE commits to the paired output', () => {
  const a = baseTx();
  const h1 = legacySighash(a, 1, code, LISTING_SIGHASH);
  const b = baseTx();
  b.vout[1] = { value: 2001, script: b.vout[1].script };
  const h2 = legacySighash(b, 1, code, LISTING_SIGHASH);
  assert.notDeepStrictEqual(h1, h2);
});

test('NONE commits to no outputs; SINGLE/NONE zero the other sequences', () => {
  const a = baseTx();
  const h1 = legacySighash(a, 0, code, SIGHASH_NONE);
  const b = baseTx();
  b.vout = [{ value: 5, script: Buffer.from([0x55]) }];
  b.vin[1].sequence = 12345;
  const h2 = legacySighash(b, 0, code, SIGHASH_NONE);
  assert.deepStrictEqual(h1, h2);
  const c = baseTx();
  c.vin[1].sequence = 12345;
  const h3 = legacySighash(c, 0, code, SIGHASH_ALL);
  assert.notDeepStrictEqual(legacySighash(baseTx(), 0, code, SIGHASH_ALL), h3);
});

test('the historical SIGHASH_SINGLE bug hashes to the constant one', () => {
  const a = baseTx();
  const h = legacySighash(a, 1, code, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY);
  const bug = legacySighash({ ...a, vout: [a.vout[0]] }, 1, code, SIGHASH_SINGLE);
  const one = Buffer.alloc(32);
  one[0] = 1;
  assert.deepStrictEqual(bug, one);
  assert.notDeepStrictEqual(h, one);
});

test('SIGHASH_ALL behaviour is unchanged by the extension', () => {
  const a = baseTx();
  const h1 = legacySighash(a, 0, code, SIGHASH_ALL);
  const b = baseTx();
  b.vout[1].value = 2001;
  assert.notDeepStrictEqual(h1, legacySighash(b, 0, code, SIGHASH_ALL));
});

console.log(`\n${passed} swap tests passed`);
