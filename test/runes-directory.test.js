// The coin directory: what a market opens on, and the one number nobody may be asked to scale.
//
// Two mistakes shipped in one day taught this file what to check. A wallet showed 11,000 of a coin
// somebody held 110.00 of, and a market page showed a price per ATOMIC unit labelled "each". Both
// were the same missing factor of 10^divisibility, in opposite directions, on the same screen.
// So the multiplication happens here and the tests below are mostly about that.
//
// Run: node test/runes-directory.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const codec = require('../src/runes/codec');
const { pickNetwork } = require('../src/cli');
const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer');
const { RuneBook } = require('../src/runes/book');
const { signOrder } = require('../src/runes/order');
const { directory, perWholeCoin, carrierCounts } = require('../src/runes/directory');
const { lockFor } = require('./fixtures/etchlock');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');
const seller = ECPair.makeRandom({ network });
const addrOf = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const A = codec.ACTIVATION_HEIGHT;
const DUST = 100000;
const NOW = 1_787_000_000;
const out = (v = DUST) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });

/** A state with real etchings in it, applied by the real indexer. */
function chainWith(coins) {
  const s = new RuneState();
  coins.forEach((c, i) => {
    const paid = lockFor(c.ticker);
    applyTx(s, {
      txid: 'e' + i, height: A + i, txIndex: 1, inputs: [], time: paid.time,
      outputs: [out(), paid.output],
      etching: {
        ticker: c.ticker,
        supply: c.supply,
        premine: c.premine || 0,
        divisibility: c.div || 0,
        spacers: c.spacers || 0,
        lock: paid.lock,
        terms: c.terms === undefined ? { amount: 1000 } : c.terms,
      },
    });
  });
  s.height = A + coins.length;
  return s;
}

const refAt = (i) => runeRefOf(A + i, 1);

function bookWith(orders) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runedir-'));
  const book = new RuneBook({ dataDir: dir, network, chain: {}, now: () => NOW }).load();
  orders.forEach((o, i) => {
    book.putOrder(signOrder({
      network, runeRef: o.runeRef, sell: o.sell, minPrice: o.minPrice,
      key: seller, nonce: 'n' + i, expiresAt: NOW + 86400,
    }));
  });
  const byRune = new Map();
  for (const row of book.orders({})) {
    const list = byRune.get(row.order.runeRef) || [];
    list.push(row);
    byRune.set(row.order.runeRef, list);
  }
  return byRune;
}

test('THE PRICE IS PER WHOLE COIN, never per atomic unit', () => {
  // The buy page said "0.5 XVG each" for an order asking 0.5 XVG per hundredth of a coin. The true
  // ask was 50 XVG a coin, a hundred times what the screen said, and a buyer acting on the screen
  // would have been signing for the real number.
  assert.strictEqual(perWholeCoin({ units: 500000, per: 1 }, 2), 50000000);
  assert.strictEqual(perWholeCoin({ units: 500000, per: 1 }, 0), 500000);
  assert.strictEqual(perWholeCoin({ units: 1, per: 2 }, 6), 500000);
});

test('and it survives the whole way through the directory', () => {
  const s = chainWith([{ ticker: 'TWODEC', supply: 100000, div: 2 }]);
  const ref = refAt(0);
  const byRune = bookWith([{ runeRef: ref, sell: 10000, minPrice: { units: 500000, per: 1 } }]);
  const [c] = directory(s, { height: s.height, ordersByRune: byRune });
  assert.strictEqual(c.market.bestAsk, 50000000, '50 XVG for one whole TWODEC');
  assert.strictEqual(c.market.bestAsk / 1e6, 50);
});

test('the best ask is the lowest of them, not the first or the last', () => {
  const s = chainWith([{ ticker: 'MANY', supply: 100000, div: 0 }]);
  const ref = refAt(0);
  const byRune = bookWith([
    { runeRef: ref, sell: 100, minPrice: { units: 900000, per: 1 } },
    { runeRef: ref, sell: 100, minPrice: { units: 300000, per: 1 } },
    { runeRef: ref, sell: 100, minPrice: { units: 700000, per: 1 } },
  ]);
  const [c] = directory(s, { height: s.height, ordersByRune: byRune });
  assert.strictEqual(c.market.bestAsk, 300000);
  assert.strictEqual(c.market.asks, 3);
  assert.strictEqual(c.market.forSale, 300);
});

test('no asks is null, and null is not zero', () => {
  // A coin with no seller must not read as a coin selling for nothing.
  const s = chainWith([{ ticker: 'QUIET', supply: 1000 }]);
  const [c] = directory(s, { height: s.height });
  assert.strictEqual(c.market.bestAsk, null);
  assert.strictEqual(c.market.asks, 0);
});

test('A PREMINE-ONLY COIN IS IN THE DIRECTORY, which is why it is not the mint list', () => {
  // mintable() drops anything without terms, correctly: there is nothing to mint. A market that
  // reused it would hide every fully premined coin, and those are exactly the ones that trade.
  const s = chainWith([{ ticker: 'ALLMINE', supply: 1000, premine: 1000, terms: null }]);
  const rows = directory(s, { height: s.height });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ticker, 'ALLMINE');
  assert.strictEqual(rows[0].mint, null, 'nothing to mint, said plainly');
});

test('minted share is against the OPEN supply, never the whole one', () => {
  const s = chainWith([{ ticker: 'HALF', supply: 1000, premine: 500, terms: { amount: 250 } }]);
  const ref = refAt(0);
  s.runes.get(ref).minted = 250;
  const [c] = directory(s, { height: s.height });
  assert.strictEqual(c.openSupply, 500);
  assert.strictEqual(c.mintedShare, 0.5);
  assert.strictEqual(c.circulating, 750);
});

test('whole-coin figures are the atomic ones divided by the divisibility, all of them', () => {
  const s = chainWith([{ ticker: 'SCALED', supply: 100000, premine: 20000, div: 2, terms: { amount: 1000 } }]);
  const ref = refAt(0);
  s.runes.get(ref).minted = 5000;
  const [c] = directory(s, { height: s.height });
  assert.deepStrictEqual(c.whole, { supply: 1000, premine: 200, minted: 50, circulating: 250 });
});

test('carriers are counted once per outpoint, and a zero balance is not a holder', () => {
  const s = chainWith([{ ticker: 'HELD', supply: 1000 }, { ticker: 'ALSO', supply: 1000 }]);
  const [one, two] = [refAt(0), refAt(1)];
  s.balances.set('a:0', new Map([[one, 10], [two, 5]]));
  s.balances.set('a:1', new Map([[one, 10]]));
  s.balances.set('a:2', new Map([[one, 0]]));
  const counts = carrierCounts(s);
  assert.strictEqual(counts.get(one), 2, 'the zero-balance outpoint is not a holder');
  assert.strictEqual(counts.get(two), 1);
  const rows = directory(s, { height: s.height });
  assert.strictEqual(rows.find((r) => r.runeRef === one).carriers, 2);
});

test('the display name comes from the spacer mask the etching committed to', () => {
  const s = chainWith([{ ticker: 'DOGGOTOTHEMOON', supply: 1000, spacers: 0b10100 }]);
  const [c] = directory(s, { height: s.height });
  assert.strictEqual(c.ticker, 'DOGGOTOTHEMOON', 'the bare ticker is still the identity');
  assert.strictEqual(c.display, 'DOG•GO•TOTHEMOON');
});

test('newest first, so the directory is not a leaderboard for the biggest typed number', () => {
  const s = chainWith([
    { ticker: 'FIRST', supply: 1000000000 },
    { ticker: 'SECOND', supply: 10 },
    { ticker: 'THIRD', supply: 500 },
  ]);
  const rows = directory(s, { height: s.height });
  assert.deepStrictEqual(rows.map((r) => r.ticker), ['THIRD', 'SECOND', 'FIRST']);
});

test('an empty chain is an empty directory, not a crash', () => {
  assert.deepStrictEqual(directory(new RuneState(), { height: 0 }), []);
});

console.log(`\n${passed} directory tests passed`);
