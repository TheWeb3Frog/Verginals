// Marketplace swap primitives: listing half-signatures (SINGLE|ANYONECANPAY), completion,
// tamper resistance, and legacy sighash edge cases.
// Run: node test/swap.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { legacySighash, SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY } = require('../src/vergetx');
const { buildListing, completeListing, buildListingSchedule, pickVariant, buildBid, acceptBid, SELLER_INDEX, LISTING_SIGHASH } = require('../src/swap');

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
  dummy: { txid: H('b'), vout: 1, value: 150_000 },
  funds: [{ txid: H('c'), vout: 0, value: 200_000_000 }],
  buyerAddress: addr(buyer),
  buyerKey: buyer,
  feeUnits: 200_000,
}, over));

// --- listing + completion ------------------------------------------------------------------
test('a listing completes into a balanced, self-verified transaction', () => {
  const l = mkListing();
  const done = mkComplete(l);
  assert.ok(/^[0-9a-f]+$/.test(done.hex));
  // vout[0] = dummy + carrier to buyer, vout[1] = price, vout[2] = change
  assert.strictEqual(done.outputs[0].value, 150_000 + carrier.value);
  assert.strictEqual(done.outputs[1].value, 150_000_000);
  assert.strictEqual(done.outputs[2].value, 200_000_000 - 150_000_000 - 200_000);
});

test('the seller half-signature is invariant to every buyer-controlled slot', () => {
  const l = mkListing();
  // Two completions with totally different buyer coins, destination and change still verify
  // (completeListing throws if the seller signature stops matching).
  mkComplete(l);
  mkComplete(l, {
    dummy: { txid: H('d'), vout: 7, value: 130_000 },
    funds: [{ txid: H('e'), vout: 2, value: 180_000_000 }, { txid: H('f'), vout: 0, value: 30_000_000 }],
    buyerAddress: addr(ECPair.makeRandom({ network })),
    buyerKey: buyer,
    feeUnits: 300_000,
  });
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

// --- listing variant schedule ----------------------------------------------------------------
test('a listing schedule signs one working variant per timestamp', () => {
  const sched = buildListingSchedule({
    network, carrier, priceUnits: 150_000_000, sellerAddress: addr(seller), sellerKey: seller,
    startTime: 1_783_000_000, offsets: [0, 3600, 86400],
  });
  assert.strictEqual(sched.variants.length, 3);
  assert.strictEqual(sched.expiresAt, 1_783_000_000 + 86400);
  // every variant must complete into a valid swap
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
  // now=250 -> variants at 1000,1100,1200 are minable; pick the newest (1200)
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 0 }).time, 1200);
  // coins created at 1150 -> need time>=1150, so 1200 (not 1100)
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 1150 }).time, 1200);
  // coins created at 1250 but now only 1250 -> only the 1300 variant would cover them, not minable yet
  assert.strictEqual(pickVariant(sched, { now: 1250, maxCoinTime: 1210 }), null);
  // nothing minable yet
  assert.strictEqual(pickVariant(sched, { now: 999, maxCoinTime: 0 }), null);
});

// --- bids -------------------------------------------------------------------------------------
const mkBid = (over = {}) => buildBid(Object.assign({
  network, carrier, priceUnits: 120_000_000, sellerAddress: addr(seller),
  dummy: { txid: H('b'), vout: 1, value: 150_000 },
  funds: [{ txid: H('c'), vout: 0, value: 200_000_000 }],
  buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, time: 1_783_100_000,
}, over));

test('a bid is accepted by the seller into a broadcastable transaction', () => {
  const bid = mkBid();
  assert.strictEqual(bid.kind, 'verginals-bid-v1');
  assert.ok(bid.scriptSigs[0] && bid.scriptSigs[2] && !bid.scriptSigs[SELLER_INDEX]); // carrier unsigned
  const done = acceptBid({ network, bid, sellerKey: seller });
  assert.ok(/^[0-9a-f]+$/.test(done.hex) && /^[0-9a-f]{64}$/.test(done.txid));
});

test('a bid can carry an optional service-fee output', () => {
  const feeAddr = addr(ECPair.makeRandom({ network }));
  const bid = mkBid({ feeOutput: { address: feeAddr, value: 5_000_000 } });
  // vout: buyer-inscription, price, fee, change
  assert.strictEqual(bid.vout.length, 4);
  assert.strictEqual(bid.vout[2].value, 5_000_000);
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
  b.vin[0] = { txid: H('9'), vout: 5 }; // different first input
  b.vout[0] = { value: 999999, script: Buffer.from([0x53]) }; // different first output
  b.vin.push({ txid: H('8'), vout: 0 }); // extra input appended
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
  b.vin[1].sequence = 12345; // other input's sequence must not matter under NONE
  const h2 = legacySighash(b, 0, code, SIGHASH_NONE);
  assert.deepStrictEqual(h1, h2);
  const c = baseTx();
  c.vin[1].sequence = 12345;
  const h3 = legacySighash(c, 0, code, SIGHASH_ALL); // but it does matter under ALL
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
