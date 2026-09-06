// A creator's cut of a resale, and the sentence that has to go with it.
//
// The signed swap has always carried a fee output: it is how the operator's marketplace fee is
// guaranteed rather than merely asked for. It had ONE rate for everything, checked before the chain
// read, which is what made it impossible for the amount to depend on what was being sold.
//
// The honest half matters as much as the code. This is enforced by THIS MARKETPLACE, not by the
// chain: a wallet-to-wallet transfer pays nothing and no UTXO chain can prevent that. True
// everywhere since OpenSea made royalties optional, and a creator must read it in the form rather
// than discover it after launching.
//
// Run: node test/launchpad-royalty.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Launchpad, LIMITS } = require('../src/launchpad');
const { OrderBook } = require('../src/orderbook');
const { pickNetwork } = require('../src/cli');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const book = fs.readFileSync(path.join(__dirname, '..', 'src', 'orderbook.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const { network } = pickNetwork('mainnet');

function png() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(64, 8); ihdr.writeUInt32BE(64, 12);
  return Buffer.concat([sig, ihdr]);
}
const b64 = png().toString('base64');
const ADDR = 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM';
const POOL = 'DFTitj6PjQ9xFnBUf3Ez1J1dnKyN7ASd2N';
const freshLp = () => new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vroy-')) });

function launch(l, over, slug) {
  const { id } = l.createDraft(Object.assign({ name: 'Frogs', address: ADDR }, over));
  l.addItem(id, { dataBase64: b64 });
  l.finalize(id);
  l.approve(id, slug);
  return l;
}
const mkBook = (opts = {}) => new OrderBook(Object.assign({
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vrbook-')), network, chain: {},
}, opts));

test('the harness found both modules, so an empty check is not a pass', () => {
  assert.strictEqual(LIMITS.maxRoyaltyBps, 1000);
  assert.ok(book.length > 8000 && server.length > 100000);
});

// --- what the collection stores ---------------------------------------------------------------------

test('A ROYALTY IS CAPPED AT TEN PER CENT', () => {
  const l = freshLp();
  assert.throws(() => l.createDraft({ name: 'A', address: ADDR, royaltyBps: 1001 }), /cannot be over 10%/);
  assert.ok(l.createDraft({ name: 'B', address: ADDR, royaltyBps: 1000 }), 'ten per cent itself is allowed');
  assert.throws(() => l.createDraft({ name: 'C', address: ADDR, royaltyBps: -1 }), /zero or more/);
});

test('a collection that takes a royalty must have a payout address', () => {
  const l = freshLp();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR, royaltyBps: 500 });
  l.addItem(id, { dataBase64: b64 });
  l.finalize(id);
  assert.throws(() => l.approve(id, 'frogs', { validAddress: () => false }), /not usable on this network/);
});

test('and the book is told about it in the shape it asks for', () => {
  const l = launch(freshLp(), { royaltyBps: 500 }, 'frogs');
  assert.deepStrictEqual(l.royaltyFor('frogs'), { bps: 500, address: ADDR });
});

test('NO ROYALTY IS NULL, NOT A ZERO', () => {
  // A zero-fee object would look like an answer, and the book would stop falling back to whatever
  // the marketplace itself charges.
  const l = launch(freshLp(), { royaltyBps: 0 }, 'frogs');
  assert.strictEqual(l.royaltyFor('frogs'), null);
  assert.strictEqual(l.royaltyFor('no-such-collection'), null);
});

// --- what the book charges ----------------------------------------------------------------------------

test('THE FEE OUTPUT PAYS THE CREATOR WHEN THE COLLECTION HAS A ROYALTY', () => {
  const b = mkBook({ royaltyFor: () => ({ bps: 500, address: ADDR }) });
  const t = b.feeTerms(1000000, 'frogs');
  assert.deepStrictEqual(t, { units: 50000, address: ADDR, to: 'creator' });
});

test('and the marketplace otherwise, which is how it behaved before', () => {
  const b = mkBook({ feeBps: 200, feeAddress: POOL });
  assert.deepStrictEqual(b.feeTerms(1000000, null), { units: 20000, address: POOL, to: 'marketplace' });
  assert.deepStrictEqual(b.feeTerms(1000000, 'unknown'), { units: 20000, address: POOL, to: 'marketplace' });
});

test('an Alpha carries no slug, so it keeps the marketplace terms', () => {
  const b = mkBook({ feeBps: 0, feeAddress: null, royaltyFor: () => ({ bps: 500, address: ADDR }) });
  assert.strictEqual(b.feeTerms(1000000, null).units, 0, 'null slug must not reach the lookup');
});

test('BOTH AT ONCE IS REFUSED, because the signed swap has one fee output', () => {
  // Not silently preferring one: taking a marketplace cut and a royalty needs two outputs and the
  // format has one, so a configuration that wants both is a mistake and says so.
  const b = mkBook({ feeBps: 200, feeAddress: POOL, royaltyFor: () => ({ bps: 500, address: ADDR }) });
  assert.throws(() => b.feeTerms(1000000, 'frogs'), /cannot both be taken/);
});

test('THE FEE IS CHECKED AFTER THE CHAIN READ, or it cannot know the collection', () => {
  const fn = /async addListing\([\s\S]*?\n  \}/.exec(book);
  assert.ok(fn, 'addListing should exist');
  const read = fn[0].indexOf('await this.chain.carrierInfo');
  const check = fn[0].indexOf('this.feeTerms(');
  assert.ok(read > 0 && check > read,
    'reading the fee first is what made one rate for everything the only possible design');
});

test('a bid is held to the same terms as a listing', () => {
  const fn = /async addBid\([\s\S]*?\n  \}/.exec(book);
  assert.ok(fn, 'addBid should exist');
  assert.match(fn[0], /this\.feeTerms\(bid\.priceUnits/);
  assert.match(fn[0], /toOutputScript\(fee\.address/, 'and against the address the terms name');
});

test('the server hands the book the launchpad lookup', () => {
  assert.match(server, /royaltyFor: \(slug\) => \(launchpad \? launchpad\.royaltyFor\(slug\) : null\)/);
});

// --- the sentence -------------------------------------------------------------------------------------

test('THE FORM SAYS WHO ENFORCES THIS, in the form itself', () => {
  const card = html.slice(html.indexOf('id="lp-submit-card"'), html.indexOf('id="lps-submit"'));
  assert.match(card, /applied by this marketplace, not by the\s+chain/,
    'a creator must read it here rather than find it out after launching');
  assert.match(card, /wallet-to-wallet transfer pays nothing/);
  assert.match(card, /id="lps-royalty"/);
});

console.log('\n' + passed + ' launchpad royalty tests passed');
