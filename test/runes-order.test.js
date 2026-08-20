// A standing sell order that survives its own partial fills.
//
// The test that matters is "the order still stands after a partial fill": sell 20,000 of 50,000, and
// the SAME signed order, untouched, still sells the 30,000 that came home. If that ever stops being
// true the seller silently leaves the book after every trade, which is the failure this module exists
// to remove.
//
// Run: node test/runes-order.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { runeRefOf } = require('../src/runes/indexer');
const { buildRuneBid, acceptRuneBid, CHANGE_OUTPUT, DUST_UNITS } = require('../src/runes/bid');
const { signOrder, verifyOrder, remaining, quote, priceFor, fillsOrder, scriptFor } = require('../src/runes/order');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const scriptOf = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).output.toString('hex');
const H = (c) => c.repeat(64);

const REF = runeRefOf(9444444, 3);
const NOW = 1_787_000_000;
// 720 atomic units per rune, written as a ratio so nothing is ever rounded into somebody's pocket.
const ORDER = () => signOrder({
  network, runeRef: REF, sell: 50_000, minPrice: { units: 720, per: 1 },
  key: seller, nonce: 'a1', expiresAt: NOW + 86_400,
});

const funds = (v) => [{ txid: H('b'), vout: 0, value: v }];
const mkBid = (over = {}) => buildRuneBid(Object.assign({
  network, runeRef: REF, buyerAddress: addr(buyer), buyerKey: buyer,
  feeUnits: 200_000, time: NOW,
}, over));

// ---------------------------------------------------------------------------------------------
test('an order verifies against the address it claims', () => {
  const o = ORDER();
  assert.strictEqual(verifyOrder({ network, order: o, now: NOW }).ok, true);
  assert.strictEqual(o.address, addr(seller));
  assert.strictEqual(scriptFor(o), scriptOf(seller));
});

test('an order claiming somebody else\'s address is refused', () => {
  const o = ORDER();
  o.address = addr(buyer);
  const r = verifyOrder({ network, order: o, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not match the address/);
});

test('changing any field breaks the signature', () => {
  for (const mut of [
    (o) => { o.sell = 60_000; },
    (o) => { o.minPrice = { units: 1, per: 1 }; },
    (o) => { o.runeRef = runeRefOf(9444444, 4); },
    (o) => { o.expiresAt += 1; },
    (o) => { o.nonce = 'a2'; },
    (o) => { o.minFill = 1; },
  ]) {
    const o = ORDER();
    mut(o);
    assert.strictEqual(verifyOrder({ network, order: o, now: NOW }).ok, false, 'mutation slipped through');
  }
});

test('an expired order is refused', () => {
  const o = ORDER();
  assert.strictEqual(verifyOrder({ network, order: o, now: NOW + 86_401 }).ok, false);
});

test('the price floor rounds UP, so no fill lands a unit below it', () => {
  const o = signOrder({ network, runeRef: REF, sell: 1000, minPrice: { units: 1, per: 3 }, key: seller, nonce: 'r', expiresAt: NOW + 60 });
  assert.strictEqual(priceFor(o, 10), 4, '10/3 rounds up to 4, never down to 3');
  assert.strictEqual(priceFor(o, 9), 3);
});

// --- the one this module exists for -------------------------------------------------------------
test('THE ORDER STILL STANDS AFTER A PARTIAL FILL, with nothing re-signed', () => {
  const order = ORDER();
  const big = { txid: H('a'), vout: 1, value: DUST_UNITS, script: scriptOf(seller) };
  const chain1 = [{ ...big, runes: { [REF]: 50_000 }, height: 9_500_000 }];

  // A buyer takes 20,000 at the floor.
  const price1 = priceFor(order, 20_000);
  const bid1 = mkBid({ carriers: [big], amount: 20_000, priceUnits: price1, funds: funds(price1 + DUST_UNITS + 1_000_000) });
  const g1 = fillsOrder({ network, order, bid: bid1, onChain: chain1, now: NOW, alreadySold: 0 });
  assert.strictEqual(g1.ok, true, g1.reason);
  assert.strictEqual(g1.keeps, 30_000);
  assert.strictEqual(g1.soldAfter, 20_000);

  // The seller signs. The new outpoint is known here, before broadcast.
  const filled = acceptRuneBid({ network, bid: bid1, sellerKey: seller });
  const [ntxid, nvout] = filled.changeOutpoint.split(':');
  assert.strictEqual(Number(nvout), CHANGE_OUTPUT);

  // The 30,000 are now on a NEW outpoint. THE ORDER OBJECT HAS NOT BEEN TOUCHED.
  const rest = { txid: ntxid, vout: Number(nvout), value: DUST_UNITS, script: scriptOf(seller) };
  const chain2 = [{ ...rest, runes: { [REF]: 30_000 }, height: 9_500_001 }];
  assert.strictEqual(verifyOrder({ network, order, now: NOW + 60 }).ok, true, 'same signature, still valid');
  assert.strictEqual(remaining(order, 20_000), 30_000);

  const q = quote({ order, carriers: chain2, amount: 30_000, alreadySold: 20_000 });
  assert.strictEqual(q.ok, true, q.reason);
  assert.strictEqual(q.carriers[0].txid, ntxid, 'the quote follows the remainder by itself');

  const price2 = q.priceUnits;
  const bid2 = mkBid({ carriers: [rest], amount: 30_000, priceUnits: price2, funds: funds(price2 + DUST_UNITS + 1_000_000), time: NOW + 60 });
  const g2 = fillsOrder({ network, order, bid: bid2, onChain: chain2, now: NOW + 60, alreadySold: 20_000 });
  assert.strictEqual(g2.ok, true, g2.reason);
  assert.strictEqual(g2.keeps, 0);
  assert.strictEqual(g2.soldAfter, 50_000);
});

// --- the gate ------------------------------------------------------------------------------------
const carrier = { txid: H('a'), vout: 1, value: DUST_UNITS, script: scriptOf(seller) };
const chain = [{ ...carrier, runes: { [REF]: 50_000 }, height: 9_500_000 }];
const atFloor = (amount, over = {}) => {
  const p = over.priceUnits != null ? over.priceUnits : priceFor(ORDER(), amount);
  return mkBid(Object.assign({ carriers: [carrier], amount, priceUnits: p, funds: funds(p + DUST_UNITS + 1_000_000) }, over));
};

test('THE FEE ATTACK: a handsome price routed to a fee address is refused', () => {
  // The bid states 720 a rune, then sends nine tenths of it to a "market fee" address the buyer
  // controls. A floor checked against the advertised price would wave this straight through.
  const order = ORDER();
  const p = priceFor(order, 10_000);
  const bid = atFloor(10_000, { priceUnits: p, marketFeeUnits: Math.floor(p * 0.9), feeAddress: addr(buyer) });
  const r = fillsOrder({ network, order, bid, onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /would receive .* under this order's floor/);
});

test('a bid one unit under the floor is refused', () => {
  const order = ORDER();
  const p = priceFor(order, 10_000);
  const bid = atFloor(10_000, { priceUnits: p - 1 });
  const r = fillsOrder({ network, order, bid, onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /under this order's floor/);
});

test('a bid exactly at the floor is accepted', () => {
  const order = ORDER();
  const r = fillsOrder({ network, order, bid: atFloor(10_000), onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, true, r.reason);
});

test('a bid above the remaining offer is refused', () => {
  const order = ORDER();
  const r = fillsOrder({ network, order, bid: atFloor(20_000), onChain: chain, now: NOW, alreadySold: 40_000 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /only 10000 is still on offer/);
});

test('a bid below the seller\'s minimum fill is refused', () => {
  const order = signOrder({ network, runeRef: REF, sell: 50_000, minPrice: { units: 720, per: 1 }, key: seller, nonce: 'm', expiresAt: NOW + 60, minFill: 5_000 });
  const p = priceFor(order, 100);
  const bid = atFloor(100, { priceUnits: p });
  const r = fillsOrder({ network, order, bid, onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /below this order's floor of 5000/);
});

test('a bid for another rune is refused', () => {
  const order = ORDER();
  const bid = atFloor(10_000);
  bid.runeRef = runeRefOf(9444444, 9);
  const r = fillsOrder({ network, order, bid, onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /this order sells/);
});

test('a bid against somebody else\'s carrier is refused by the order, not just by the key', () => {
  const order = ORDER();
  const foreign = [{ ...chain[0], script: scriptOf(buyer) }];
  const r = fillsOrder({ network, order, bid: atFloor(10_000), onChain: foreign, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not speak for/);
});

test('an expired order fills nothing', () => {
  const order = ORDER();
  const r = fillsOrder({ network, order, bid: atFloor(10_000), onChain: chain, now: NOW + 90_000, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('the gate still runs the money checks, it does not replace them', () => {
  const order = ORDER();
  const bid = atFloor(10_000);
  bid.vout[CHANGE_OUTPUT].script = scriptOf(buyer); // the change stops coming home
  const r = fillsOrder({ network, order, bid, onChain: chain, now: NOW, alreadySold: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not return to the carriers/);
});

// --- quoting a fragmented holding ----------------------------------------------------------------
test('a quote takes the fewest carriers, largest first', () => {
  const order = ORDER();
  const frags = [
    { txid: H('1'), vout: 0, value: DUST_UNITS, script: scriptOf(seller), runes: { [REF]: 5_000 } },
    { txid: H('2'), vout: 0, value: DUST_UNITS, script: scriptOf(seller), runes: { [REF]: 25_000 } },
    { txid: H('3'), vout: 0, value: DUST_UNITS, script: scriptOf(seller), runes: { [REF]: 12_000 } },
  ];
  const q = quote({ order, carriers: frags, amount: 30_000, alreadySold: 0 });
  assert.strictEqual(q.ok, true, q.reason);
  assert.strictEqual(q.carriers.length, 2);
  assert.deepStrictEqual(q.carriers.map((c) => c.txid), [H('2'), H('3')]);
  assert.strictEqual(q.pooled, 37_000);
});

test('a quote refuses rather than under-delivering when the address is short', () => {
  const order = ORDER();
  const frags = [{ txid: H('1'), vout: 0, value: DUST_UNITS, script: scriptOf(seller), runes: { [REF]: 900 } }];
  const q = quote({ order, carriers: frags, amount: 30_000, alreadySold: 0 });
  assert.strictEqual(q.ok, false);
  assert.match(q.reason, /holds 900 .*short of 30000/);
});

test('a quote ignores carriers that are not this seller\'s', () => {
  const order = ORDER();
  const frags = [{ txid: H('1'), vout: 0, value: DUST_UNITS, script: scriptOf(buyer), runes: { [REF]: 90_000 } }];
  assert.strictEqual(quote({ order, carriers: frags, amount: 1_000, alreadySold: 0 }).ok, false);
});

test('OVERFILL IS IMPOSSIBLE ON CHAIN, not merely discouraged by the accounting', () => {
  // Two buyers each take 40,000 of a 50,000 holding and the seller's software signs both, because
  // its `alreadySold` has not caught up. Both transactions spend the SAME carrier, so at most one
  // can ever confirm. The chain is the hard cap; the accounting is only there to stop the seller
  // wasting signatures.
  const order = ORDER();
  const a = atFloor(40_000);
  const b = mkBid({ carriers: [carrier], amount: 40_000, priceUnits: priceFor(order, 40_000), funds: funds(priceFor(order, 40_000) + DUST_UNITS + 2_000_000), time: NOW + 1 });
  assert.strictEqual(fillsOrder({ network, order, bid: a, onChain: chain, now: NOW, alreadySold: 0 }).ok, true);
  assert.strictEqual(fillsOrder({ network, order, bid: b, onChain: chain, now: NOW, alreadySold: 0 }).ok, true);
  const ta = acceptRuneBid({ network, bid: a, sellerKey: seller });
  const tb = acceptRuneBid({ network, bid: b, sellerKey: seller });
  assert.notStrictEqual(ta.txid, tb.txid);
  assert.deepStrictEqual(a.vin[0], b.vin[0], 'both spend the same carrier outpoint, so only one confirms');
});

console.log(`\n${passed} passed`);
