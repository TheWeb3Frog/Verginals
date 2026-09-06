// Paying the person who made the art.
//
// A launchpad mint charged MINT_PER_INPUT_XVG, which is the network cost of writing the
// inscription and nothing else. A creator launched a collection, people minted it, and the creator
// received nothing at all: not at mint, not on resale. There was no economic reason to launch here,
// which is the real answer to why nobody had.
//
// The mechanism was already in the building. The commit transaction has always carried one output
// beyond the cost of writing, because that is how the operator's service fee was collected. This
// points the same output at the creator instead, and the site takes none of it.
//
// Run: node test/launchpad-price.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Launchpad, LIMITS } = require('../src/launchpad');
const { priceInscription } = require('../src/pricing');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function png(w = 64, h = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr]);
}
const b64 = png().toString('base64');
const ADDR = 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM';
const fresh = () => new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vprice-')) });

/** Submit and approve one collection, returning its manifest. */
function launch(l, over = {}, slug = 'frogs', opts = {}) {
  const { id } = l.createDraft(Object.assign({ name: 'Frogs', address: ADDR }, over));
  l.addItem(id, { dataBase64: b64 });
  l.addItem(id, { dataBase64: b64 }); // a collection is at least two
  l.finalize(id);
  l.approve(id, slug, opts);
  return JSON.parse(fs.readFileSync(path.join(l.collsDir, slug, 'collection_manifest.json'), 'utf8'));
}

test('the harness found both sides, so an empty check is not a pass', () => {
  assert.ok(LIMITS.maxMintPriceUnits > 0);
  assert.ok(server.length > 100000 && app.length > 80000);
});

// --- the price survives from the form to the manifest -----------------------------------------------

test('A PRICE SET AT SUBMISSION IS THE PRICE IN THE MANIFEST', () => {
  const m = launch(fresh(), { mintPriceUnits: 500 * 1e6 });
  assert.strictEqual(m.mint_price_units, 500 * 1e6);
  assert.strictEqual(m.payout_address, ADDR);
});

test('free is a real choice, and it carries no payout address', () => {
  const m = launch(fresh(), { mintPriceUnits: 0 });
  assert.strictEqual(m.mint_price_units, 0);
  assert.strictEqual(m.payout_address, null, 'nothing is paid, so nobody is named');
});

test('THE PAYOUT IS THE ADDRESS THAT SIGNED, never one typed alongside', () => {
  // The only address anybody has proved control of. An unproven address on a mint page is somebody
  // else's money going somewhere nobody checked.
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR, mintPriceUnits: 1, payoutAddress: 'D' + 'z'.repeat(33) });
  const d = l._loadDraft(id);
  assert.strictEqual(d.payoutAddress, ADDR, 'a payoutAddress in the request must be ignored');
});

test('a price cannot be negative, and a typo cannot ask for a fortune', () => {
  const l = fresh();
  assert.throws(() => l.createDraft({ name: 'A', address: ADDR, mintPriceUnits: -1 }), /zero or more/);
  assert.throws(() => l.createDraft({ name: 'B', address: ADDR, mintPriceUnits: LIMITS.maxMintPriceUnits + 1 }), /ceiling/);
  assert.ok(l.createDraft({ name: 'C', address: ADDR, mintPriceUnits: LIMITS.maxMintPriceUnits }), 'the ceiling itself is allowed');
});

test('AN UNUSABLE PAYOUT ADDRESS IS CAUGHT AT APPROVAL, not at somebody first mint', () => {
  const l = fresh();
  assert.throws(
    () => launch(l, { mintPriceUnits: 100 }, 'bad', { validAddress: () => false }),
    /not usable on this network/);
  // And a free collection needs no address, so the check must not fire on one.
  assert.ok(launch(fresh(), { mintPriceUnits: 0 }, 'free', { validAddress: () => false }));
});

test('the price reaches the grid, so a card can say what it costs', () => {
  const l = fresh();
  launch(l, { mintPriceUnits: 250 * 1e6 }, 'frogs');
  const row = l.list().find((c) => c.slug === 'frogs');
  assert.strictEqual(row.mintPriceUnits, 250 * 1e6);
});

// --- what the minter actually pays ----------------------------------------------------------------

test('THE CREATORS PRICE IS ADDED TO THE TOTAL AND NOTHING IS TAKEN OFF IT', () => {
  const price = 500 * 1e6;
  const free = priceInscription({ numInputs: 2, maxPerInput: 3e6, serviceFee: 0 });
  const paid = priceInscription({ numInputs: 2, maxPerInput: 3e6, serviceFee: price });
  assert.strictEqual(paid.total - free.total, price, 'the minter pays exactly the price on top');
  assert.strictEqual(paid.serviceFee, price, 'and the whole of it is the payout');
  assert.strictEqual(paid.carrier, free.carrier, 'the item they receive is unchanged');
});

test('the job points that output at the creator rather than the operator', () => {
  const fn = /async function createPaymentJob\(\{[\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'createPaymentJob should exist');
  assert.match(fn[0], /payout && payout\.units > 0 && payout\.address/);
  assert.match(fn[0], /feeAddress: serviceFee > 0 \? pay\.address : null/,
    'the address paid must be the one chosen, not the global one');
  assert.match(fn[0], /payoutTo: pay\.to/, 'and the answer says who it reached');
});

test('and the mint route reads the price off the manifest', () => {
  const fn = /async function handleLaunchpadMint\([\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'the mint route should exist');
  assert.match(fn[0], /c\.manifest\.mint_price_units/);
  assert.match(fn[0], /address: c\.manifest\.payout_address/);
  assert.match(fn[0], /label: 'creator'/);
});

test('THE MINT PAGE SAYS WHO THE MONEY REACHES', () => {
  // "Service fee" on a community collection would be wrong twice over: the site takes none of it,
  // and the creator receives all of it.
  assert.match(app, /b\.payoutTo === 'creator'/);
  assert.match(app, /'To the creator'/);
});

test('CONTROL: without a payout the job still pays the operator as before', () => {
  const fn = /async function createPaymentJob\(\{[\s\S]*?\n\}\n/.exec(server)[0];
  assert.match(fn, /\{ units: SERVICE_FEE_UNITS, address: FEE_ADDRESS, to: 'service' \}/,
    'the existing behaviour has to survive, or every ordinary inscription changes');
});

console.log('\n' + passed + ' launchpad price tests passed');
