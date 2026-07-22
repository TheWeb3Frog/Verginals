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

// A controllable fake chain. spent[] marks outpoints as spent; owner is the inscription's current
// holder (controls sale-vs-cancel detection); collection identity flags Alpha vs launchpad.
function fakeChain(over = {}) {
  const spent = new Set(over.spent || []);
  const carrierAddr = over.carrierAddr || addr(seller);
  const ins = over.noInscription ? null : {
    id: over.inscriptionId || 'x',
    collectionNumber: over.collectionNumber != null ? over.collectionNumber : 7,
    collectionSlug: over.collectionSlug || null,
  };
  return {
    spent,
    owner: over.owner || { address: carrierAddr, location: `${carrier.txid}:0` }, // mutate in tests
    async carrierInfo(txid, vout) {
      return { address: carrierAddr, valueUnits: carrier.value, spent: spent.has(`${txid}:${vout}`), inscription: ins };
    },
    async outpointSpent(txid, vout) { return spent.has(`${txid}:${vout}`); },
    async inscriptionOwner() { return this.owner; },
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

  await test('a spent carrier that changed owner is logged as a sale with the listed price', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addListing(mkListing());
    chain.spent.add(`${carrier.txid}:0`);
    chain.owner = { address: addr(buyer), location: 'ff'.repeat(32) + ':1' }; // moved to the buyer
    await book.listings(); // triggers the prune + sale detection
    const act = book.activity();
    const sale = act.find((a) => a.type === 'sale');
    assert.ok(sale, 'a sale should be recorded');
    assert.strictEqual(sale.priceUnits, 150_000_000);
    assert.strictEqual(sale.buyerAddress, addr(buyer));
    assert.strictEqual(sale.sellerAddress, addr(seller));
  });

  await test('a cancel (carrier spent but still with the seller) records no sale', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addListing(mkListing());
    chain.spent.add(`${carrier.txid}:0`);
    chain.owner = { address: addr(seller), location: 'ee'.repeat(32) + ':0' }; // self-move / cancel
    await book.listings();
    assert.strictEqual(book.activity().filter((a) => a.type === 'sale').length, 0);
  });

  await test('a sale is NOT lost when the indexer lags the spend (retries until decidable)', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addListing(mkListing());
    chain.spent.add(`${carrier.txid}:0`);
    // Indexer still maps the inscription to the outpoint we know is spent: verdict must be
    // "pending", the listing survives for a retry, but is hidden from buyers and stats.
    chain.owner = { address: addr(seller), location: `${carrier.txid}:0` };
    let s = await book.stats();
    assert.strictEqual(s.salesCount, 0, 'no premature sale');
    assert.strictEqual(s.listedCount, 0, 'pending listing hidden from stats');
    assert.strictEqual(book.variantFor(`${carrier.txid}:0`, { maxCoinTime: 2_000_000_100 }), null, 'not buyable');
    // Indexer errors are also "pending", not a lost sale.
    const oldOwner = chain.inscriptionOwner;
    chain.inscriptionOwner = async () => { throw new Error('indexer busy'); };
    await book.stats();
    chain.inscriptionOwner = oldOwner;
    // Indexer catches up: the move to the buyer is now visible and the sale is recorded.
    chain.owner = { address: addr(buyer), location: 'ff'.repeat(32) + ':1' };
    s = await book.stats();
    assert.strictEqual(s.salesCount, 1, 'sale recorded after the indexer caught up');
    assert.strictEqual(s.volumeUnits, 150_000_000);
    const sale = book.activity().find((a) => a.type === 'sale');
    assert.strictEqual(sale.buyerAddress, addr(buyer));
  });

  await test('stats report floor, listed count and lifetime volume for Alpha only', async () => {
    const chain = fakeChain();
    const book = freshBook(chain);
    await book.addListing(mkListing());
    let s = await book.stats();
    assert.strictEqual(s.listedCount, 1);
    assert.strictEqual(s.floorUnits, 150_000_000);
    assert.strictEqual(s.volumeUnits, 0);
    // sell it, then a new listing: floor updates, volume accrues
    chain.spent.add(`${carrier.txid}:0`);
    chain.owner = { address: addr(buyer), location: 'ff'.repeat(32) + ':1' };
    s = await book.stats();
    assert.strictEqual(s.listedCount, 0);
    assert.strictEqual(s.floorUnits, null);
    assert.strictEqual(s.salesCount, 1);
    assert.strictEqual(s.volumeUnits, 150_000_000);
  });

  await test('launchpad listings are excluded from the Alpha collection stats', async () => {
    const chain = fakeChain({ collectionSlug: 'kittens', collectionNumber: 3 });
    const book = freshBook(chain);
    await book.addListing(mkListing());
    const s = await book.stats();
    assert.strictEqual(s.listedCount, 0); // not Alpha
  });

  console.log(`\n${passed} order book tests passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
