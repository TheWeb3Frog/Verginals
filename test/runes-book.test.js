// The rune book is a relay, never a custodian. The test that carries the claim is the last one: a
// hostile book that edits what it stores produces something the seller's own check refuses, so the
// worst a bad book can do is NO TRADE.
//
// Run: node test/runes-book.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { runeRefOf } = require('../src/runes/indexer');
const { buildRuneBid, verifyRuneBid, DUST_UNITS, CHANGE_OUTPUT } = require('../src/runes/bid');
const { signOrder, signCancel, verifyCancel, priceFor } = require('../src/runes/order');
const { RuneBook } = require('../src/runes/book');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');

let passed = 0;
const test = (name, fn) => { const r = fn(); if (r && r.then) throw new Error('use runAsync'); passed++; console.log('  ok - ' + name); };
const tests = [];
const asyncTest = (name, fn) => tests.push([name, fn]);

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const stranger = ECPair.makeRandom({ network });
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const scriptOf = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).output.toString('hex');
const H = (c) => c.repeat(64);

const REF = runeRefOf(9444444, 3);
const NOW = 1_787_000_000;
const carrier = { txid: H('a'), vout: 1, value: DUST_UNITS, script: scriptOf(seller) };

const spent = new Set();
const chain = {
  async outpointSpent(txid, vout) { return spent.has(`${txid}:${vout}`); },
  async carrierRunes(txid, vout) {
    if (`${txid}:${vout}` !== `${carrier.txid}:${carrier.vout}`) return null;
    return { value: carrier.value, script: carrier.script, runes: { [REF]: 50_000 }, height: 9_500_000 };
  },
};

const mkBook = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runebook-'));
  return new RuneBook({ dataDir: dir, network, chain, now: () => NOW }).load();
};
const mkOrder = (over = {}) => signOrder(Object.assign({
  network, runeRef: REF, sell: 50_000, minPrice: { units: 720, per: 1 },
  key: seller, nonce: 'n1', expiresAt: NOW + 3600,
}, over));
const mkBid = (over = {}) => {
  const amount = over.amount || 10_000;
  const p = priceFor(mkOrder(), amount);
  return buildRuneBid(Object.assign({
    network, carriers: [carrier], runeRef: REF, amount, priceUnits: p,
    buyerAddress: addr(buyer), buyerKey: buyer,
    funds: [{ txid: H('b'), vout: 0, value: p + DUST_UNITS + 1_000_000 }],
    feeUnits: 200_000, time: NOW,
  }, over));
};

// --- orders --------------------------------------------------------------------------------------
test('an order goes in and comes back out', () => {
  const b = mkBook();
  b.putOrder(mkOrder());
  const rows = b.orders({ runeRef: REF });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].remaining, 50_000);
});

test('re-publishing the same nonce replaces the terms, which is how a price change works', () => {
  const b = mkBook();
  b.putOrder(mkOrder());
  b.putOrder(mkOrder({ minPrice: { units: 800, per: 1 } }));
  const rows = b.orders({ runeRef: REF });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].order.minPrice.units, 800);
});

test('an order for another rune is not served', () => {
  const b = mkBook();
  b.putOrder(mkOrder());
  assert.strictEqual(b.orders({ runeRef: runeRefOf(9444444, 9) }).length, 0);
});

test('an expired order is dropped as it is noticed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runebook-'));
  let t = NOW;
  const b = new RuneBook({ dataDir: dir, network, chain, now: () => t }).load();
  b.putOrder(mkOrder());
  t = NOW + 3601;
  assert.strictEqual(b.orders().length, 0);
  assert.strictEqual(Object.keys(b.state.orders).length, 0, 'and really removed, not just hidden');
});

test('a cancel from the order\'s own key withdraws it', () => {
  const b = mkBook();
  const o = mkOrder();
  b.putOrder(o);
  b.cancelOrder(signCancel({ order: o, key: seller, at: NOW }));
  assert.strictEqual(b.orders().length, 0);
});

test('a cancel signed by anybody else is refused', () => {
  const b = mkBook();
  const o = mkOrder();
  b.putOrder(o);
  const forged = signCancel({ order: o, key: stranger, at: NOW });
  assert.throws(() => b.cancelOrder(forged), /not signed by the order/);
  assert.strictEqual(b.orders().length, 1);
});

test('a cancel naming an order that is not there is refused', () => {
  const b = mkBook();
  assert.strictEqual(verifyCancel({ cancel: signCancel({ order: mkOrder(), key: seller, at: NOW }), order: null }).ok, false);
});

test('an order that has sold out is not served, and the accounting says why', () => {
  const b = mkBook();
  const o = mkOrder();
  b.putOrder(o);
  b.recordFill({ address: o.address, nonce: o.nonce, amount: 50_000, txid: H('f') });
  assert.strictEqual(b.orders().length, 0);
  assert.strictEqual(b.soldFor(o.address, o.nonce), 50_000);
});

// --- bids ----------------------------------------------------------------------------------------
asyncTest('a bid is filed under the seller it is aimed at', async () => {
  const b = mkBook();
  const r = await b.putBid(mkBid());
  assert.strictEqual(r.seller, scriptOf(seller));
  const live = await b.bidsFor(scriptOf(seller));
  assert.strictEqual(live.length, 1);
});

asyncTest('a bid on a spent carrier is refused', async () => {
  const b = mkBook();
  spent.add(`${carrier.txid}:${carrier.vout}`);
  await assert.rejects(() => b.putBid(mkBid()), /already spent/);
  spent.delete(`${carrier.txid}:${carrier.vout}`);
});

asyncTest('a bid on a carrier this node does not know is refused', async () => {
  const b = mkBook();
  const bid = mkBid({ carriers: [{ ...carrier, txid: H('9') }] });
  await assert.rejects(() => b.putBid(bid), /unknown to this node/);
});

asyncTest('a bid that fails verification never enters the book', async () => {
  const b = mkBook();
  const bid = mkBid();
  bid.vout[CHANGE_OUTPUT].script = scriptOf(buyer);
  await assert.rejects(() => b.putBid(bid), /does not return to the carriers/);
  assert.deepStrictEqual(await b.bidsFor(scriptOf(seller)), []);
});

asyncTest('a buyer re-bidding on the same carriers replaces their own offer', async () => {
  const b = mkBook();
  await b.putBid(mkBid({ amount: 10_000 }));
  await b.putBid(mkBid({ amount: 20_000 }));
  const live = await b.bidsFor(scriptOf(seller));
  assert.strictEqual(live.length, 1, 'both spend the same coins, only one could ever confirm');
  assert.strictEqual(live[0].amount, 20_000);
});

asyncTest('a bid whose buyer coins have been spent is dropped before it is shown', async () => {
  const b = mkBook();
  const bid = mkBid();
  await b.putBid(bid);
  spent.add(`${bid.vin[1].txid}:${bid.vin[1].vout}`);
  assert.deepStrictEqual(await b.bidsFor(scriptOf(seller)), []);
  spent.delete(`${bid.vin[1].txid}:${bid.vin[1].vout}`);
});

asyncTest('the depth is sorted cheapest first', async () => {
  const b = mkBook();
  b.putOrder(mkOrder({ nonce: 'x', minPrice: { units: 900, per: 1 } }));
  b.putOrder(mkOrder({ nonce: 'y', minPrice: { units: 700, per: 1 } }));
  const d = await b.depth(REF);
  assert.deepStrictEqual(d.map((r) => r.order.minPrice.units), [700, 900]);
});

// --- the claim -----------------------------------------------------------------------------------
asyncTest('A HOSTILE BOOK CANNOT DO BETTER THAN NO TRADE', async () => {
  // The book is handed a good bid and quietly edits it, the way a custodian could. Every edit it
  // could want to make is one the seller's own check refuses, because the buyer signed the whole
  // transaction and the seller re-derives the facts from their own node.
  const b = mkBook();
  const good = mkBid();
  await b.putBid(good);
  const onChain = [{ ...carrier, runes: { [REF]: 50_000 }, height: 9_500_000 }];
  assert.strictEqual(verifyRuneBid({ network, bid: good, onChain }).ok, true);

  for (const [what, tamper] of [
    ['redirect the payment', (x) => { x.vout[3].script = scriptOf(stranger); }],
    ['skim the payment', (x) => { x.vout[3].value -= 1; }],
    ['steal the change', (x) => { x.vout[CHANGE_OUTPUT].script = scriptOf(stranger); }],
    ['inflate the amount taken', (x) => { x.amount += 1; }],
    ['swap in another carrier', (x) => { x.carriers[0] = { ...x.carriers[0], txid: H('7') }; }],
  ]) {
    const evil = JSON.parse(JSON.stringify(good));
    tamper(evil);
    const r = verifyRuneBid({ network, bid: evil, onChain });
    assert.strictEqual(r.ok, false, `the seller must refuse an attempt to ${what}`);
  }
});

(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log('  ok - ' + name); }
  console.log(`\n${passed} passed`);
})();
