// Order book: validation of signed listings and bids, staleness pruning, no-custody behaviour.
// Run: node test/orderbook.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { buildListingSchedule, buildBid } = require('../src/swap');
const { OrderBook } = require('../src/orderbook');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const H = (c) => c.repeat(64);

let passed = 0;
function test(name, fn) {
  return fn().then(() => { passed++; console.log(`  ok - ${name}`); });
}

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const carrier = { txid: H('a'), vout: 0, value: 2_100_000 };

// A controllable fake chain. spent[] marks outpoints as spent; carriers[] maps outpoint -> info.
function fakeChain(over = {}) {
  const spent = new Set(over.spent || []);
  const carrierAddr = over.carrierAddr || addr(seller);
  return {
    spent,
    async carrierInfo(txid, vout) {
      if (over.noInscription) return { address: carrierAddr, valueUnits: carrier.value, spent: spent.has(`${txid}:${vout}`), inscription: null };
      return { address: carrierAddr, valueUnits: carrier.value, spent: spent.has(`${txid}:${vout}`), inscription: { id: 'x' } };
    },
    async outpointSpent(txid, vout) { return spent.has(`${txid}:${vout}`); },
  };
}

function freshBook(chain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmarket-'));
  let clock = 2_000_000_000;
  const book = new OrderBook({ dataDir: dir, network, chain, now: () => clock });
  book.setClock = (t) => { clock = t; };
  return book.load();
}

const mkListing = () => buildListingSchedule({
  network, carrier, priceUnits: 150_000_000, sellerAddress: addr(seller), sellerKey: seller,
  startTime: 1_999_999_000, offsets: [0, 3600, 86400],
});
const mkBid = (over = {}) => buildBid(Object.assign({
  network, carrier, priceUnits: 120_000_000, sellerAddress: addr(seller),
  pads: [{ txid: H('d'), vout: 1, value: 150_000 }, { txid: H('b'), vout: 2, value: 120_000 }],
  funds: [{ txid: H('e'), vout: 0, value: 200_000_000 }],
  buyerAddress: addr(buyer), buyerKey: buyer, feeUnits: 200_000, carrierOffset: 0, time: 1_999_999_500,
}, over));

async function main() {
  await test('a valid listing is accepted and served', async () => {
    const book = freshBook(fakeChain());
    const r = await book.addListing(mkListing());
    assert.strictEqual(r.variants, 3);
    const list = await book.listings();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].priceUnits, 150_000_000);
  });

  await test('a listing on a non-inscription UTXO is refused', async () => {
    const book = freshBook(fakeChain({ noInscription: true }));
    await assert.rejects(book.addListing(mkListing()), /does not carry a Verginal/);
  });

  await test('a listing whose carrier is spent is refused', async () => {
    const book = freshBook(fakeChain({ spent: [`${carrier.txid}:0`] }));
    await assert.rejects(book.addListing(mkListing()), /spent or unknown/);
  });

  await test('a listing not signed by the carrier owner is refused', async () => {
    const book = freshBook(fakeChain({ carrierAddr: addr(buyer) })); // owner != signer(seller)
    await assert.rejects(book.addListing(mkListing()), /carrier owner/);
  });

  await test('a tampered price invalidates every variant signature', async () => {
    const book = freshBook(fakeChain());
    const l = mkListing();
    l.priceUnits = 1; // signatures were over 150M
    await assert.rejects(book.addListing(l), /variant signature is invalid/);
  });

  await test('a sold carrier makes the listing disappear on next read', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addListing(mkListing());
    chain.spent.add(`${carrier.txid}:0`); // buyer completed the swap
    const list = await book.listings();
    assert.strictEqual(list.length, 0);
  });

  await test('an expired listing is pruned', async () => {
    const book = freshBook(fakeChain());
    await book.addListing(mkListing()); // expires at 1_999_999_000 + 86400
    book.setClock(1_999_999_000 + 86401);
    assert.strictEqual((await book.listings()).length, 0);
  });

  await test('variantFor picks a usable variant and honours coin age', async () => {
    const book = freshBook(fakeChain());
    await book.addListing(mkListing());
    book.setClock(1_999_999_000 + 3700); // variants at +0 and +3600 are minable
    const key = `${carrier.txid}:0`;
    assert.strictEqual(book.variantFor(key, { maxCoinTime: 0 }).time, 1_999_999_000 + 3600);
    // a coin newer than every minable variant -> nothing fits yet
    assert.strictEqual(book.variantFor(key, { maxCoinTime: 1_999_999_000 + 3700 }), null);
  });

  await test('a valid bid is accepted and listed under its carrier', async () => {
    const book = freshBook(fakeChain());
    const r = await book.addBid(mkBid());
    assert.strictEqual(r.priceUnits, 120_000_000);
    const bids = await book.bidsFor(`${carrier.txid}:0`);
    assert.strictEqual(bids.length, 1);
    assert.strictEqual(bids[0].buyerAddress, addr(buyer));
  });

  await test('a bid with a spent funding coin is refused', async () => {
    const book = freshBook(fakeChain({ spent: [`${H('e')}:0`] }));
    await assert.rejects(book.addBid(mkBid()), /already spent/);
  });

  await test('a new bid from the same buyer replaces the old one', async () => {
    const book = freshBook(fakeChain());
    await book.addBid(mkBid({ priceUnits: 100_000_000 }));
    await book.addBid(mkBid({ priceUnits: 130_000_000 }));
    const bids = await book.bidsFor(`${carrier.txid}:0`);
    assert.strictEqual(bids.length, 1);
    assert.strictEqual(bids[0].priceUnits, 130_000_000);
  });

  await test('bids are pruned when a funding coin is later spent', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addBid(mkBid());
    chain.spent.add(`${H('e')}:0`);
    assert.strictEqual((await book.bidsFor(`${carrier.txid}:0`)).length, 0);
  });

  await test('the order book never exposes signatures or private material in reads', async () => {
    const book = freshBook(fakeChain());
    await book.addListing(mkListing());
    await book.addBid(mkBid());
    const dump = JSON.stringify(await book.listings()) + JSON.stringify(await book.bidsFor(`${carrier.txid}:0`));
    assert.ok(!/scriptSig/.test(dump), 'reads must not leak scriptSigs');
  });

  console.log(`\n${passed} order book tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
