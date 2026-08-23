// Does the scan actually see the four actions, and does it stop seeing them when the chain changes
// its mind?
//
// The unit tests next door prove the ledger's arithmetic. This one proves the wiring, which is where
// a drop list would really go wrong: an etch counted twice, a mint credited to the wrong output, or
// an action that survives the reorg that erased the transaction it came from. None of those raise
// an error anywhere. They just quietly move somebody else's coins.
//
// Run: node test/airdrop-scan.test.js
const assert = require('assert');
const { IndexService } = require('../src/indexservice');
const { decodeBlock, xvgToUnits } = require('../src/rpc');
const { buildInscriptionScript, pushData, parentIdToBuffer } = require('../src/envelope');
const cbor = require('../src/cbor');
const codec = require('../src/runes/codec');
const { sharesOf, MAX_SHARES } = require('../src/airdrop');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const queued = [];
const test = (name, fn) => queued.push([name, fn]);

const PUBKEY = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)]);
const RUNE_TYPE = 'application/vnd.verge-rune+cbor';
const xvg = (units) => units / 1e6;

const scriptSigOf = (redeem) => ({ hex: pushData(redeem).toString('hex') });
const opReturnHex = (payload) => '6a' + payload.length.toString(16).padStart(2, '0') + payload.toString('hex');
const out = (address, units = 100000) =>
  ({ value: xvg(units), scriptPubKey: { hex: '76a914' + '11'.repeat(20) + '88ac', addresses: [address] } });
const opret = (payload) => ({ value: 0, scriptPubKey: { hex: opReturnHex(payload) } });

/** A plain inscription reveal, landing on `to`. `parent` is the raw tag-3 claim, if any. */
function revealTx(txid, from, to, contentType, body, parent = null) {
  const redeem = buildInscriptionScript({ pubkey: PUBKEY, contentType, body, parent });
  return { txid, vin: [{ txid: from.txid, vout: from.vout, scriptSig: scriptSigOf(redeem) }], vout: [out(to)] };
}

// The operator's parent carrier: one utxo, spent and re-emitted unchanged on every mint.
const OP = 'Vop';
const TIP_VALUE = 3000000;

/**
 * A collection mint, shaped the way the real one is: it spends a commit output AND the operator's
 * parent tip, pays the buyer, and carries the tip forward unchanged as the LAST output.
 *
 * Modelled this closely on purpose. The first version of this harness had each mint spend the
 * previous mint's only output, which made the tip indistinguishable from the buyer's carrier and
 * would have passed whatever the code did.
 */
function mintTx(txid, commit, tip, to) {
  const redeem = buildInscriptionScript({
    pubkey: PUBKEY, contentType: 'image/webp', body: Buffer.from('art' + txid), parent: parentIdToBuffer(ROOT_ID),
  });
  return {
    txid,
    vin: [
      { txid: commit.txid, vout: commit.vout, scriptSig: scriptSigOf(redeem) },
      { txid: tip.txid, vout: tip.vout, scriptSig: { hex: '' } },
    ],
    vout: [out(to, 330000), out(OP, TIP_VALUE)],
  };
}

/** The root reveal, landing on the operator and starting the tip chain. */
const rootTx = (from) => ({
  txid: ROOT,
  vin: [{ txid: from, vout: 0, scriptSig: scriptSigOf(buildInscriptionScript({
    pubkey: PUBKEY, contentType: 'text/plain', body: Buffer.from('collection'),
  })) }],
  vout: [out(OP, TIP_VALUE)],
});

/**
 * An etching, landing on `to`. `extra` overrides the CBOR body; `pays` overrides what the lock
 * output is worth, which is the one way to build an etching that is well formed and still refused.
 */
function etchTx(txid, from, to, ticker, extra = {}, pays = null) {
  const paid = lockFor(ticker);
  if (pays != null) paid.output.value = pays;
  const body = cbor.encode(Object.assign({
    t: ticker, d: 0, s: 100000, p: 100000, l: { t: paid.lock.t, k: paid.lock.k },
  }, extra));
  const redeem = buildInscriptionScript({ pubkey: PUBKEY, contentType: RUNE_TYPE, body });
  return {
    txid,
    vin: [{ txid: from.txid, vout: from.vout, scriptSig: scriptSigOf(redeem) }],
    vout: [out(to), { value: xvg(paid.output.value), scriptPubKey: { hex: paid.output.scriptPubKey.toString('hex') } }],
  };
}

class FakeChain {
  constructor() { this.blocks = new Map(); this.values = new Map(); }
  add(height, txs, tag = 'a') {
    const prev = this.blocks.get(height - 1);
    this.blocks.set(height, {
      height, hash: `${tag}${height}`.padStart(8, '0'),
      previousblockhash: prev ? prev.hash : null, time: lockFor('AAAA').time, tx: txs,
    });
    for (const tx of txs) tx.vout.forEach((o, i) => this.values.set(`${tx.txid}:${i}`, xvgToUnits(o.value)));
    return this;
  }
  forkAt(height) { for (const h of [...this.blocks.keys()]) if (h > height) this.blocks.delete(h); return this; }
  async getBlockCount() { return Math.max(...this.blocks.keys()); }
  async getBlockHash(h) {
    const b = this.blocks.get(h);
    if (!b) throw new Error('no block at ' + h);
    return b.hash;
  }
  async fetchDecodedBlock(height) {
    const block = this.blocks.get(height);
    const prevValues = new Map();
    for (const tx of block.tx) {
      for (const vin of tx.vin) {
        if (vin.coinbase !== undefined) continue;
        const key = `${vin.txid}:${vin.vout}`;
        prevValues.set(key, this.values.get(key) != null ? this.values.get(key) : 5000000);
      }
    }
    return decodeBlock(block, prevValues);
  }
}

const service = (chain, alphaParent = null) => new IndexService({
  runeOpts: { activationHeight: 0, etchMaturity: 0 },
  chain, from: 100, runesFrom: 100, trailDepth: 50, snapshotInterval: 2, alphaParent,
});

// A parent id is parsed as a real inscription id, so the collection root needs a real txid.
const ROOT = 'ab'.repeat(32);
const ROOT_ID = ROOT + 'i0';

const did = (svc, address) => Object.entries(svc.actions.at(address))
  .filter(([, d]) => d.count > 0).map(([k]) => k).sort();
const times = (svc, address, key) => svc.actions.at(address)[key].count;

// --- one action each ------------------------------------------------------------------------------

test('an inscription reveal earns the address that received it', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r1', { txid: 'c0', vout: 0 }, 'Vann', 'text/plain', Buffer.from('gm'))]);
  const svc = service(chain);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vann'), ['inscribe']);
  assert.strictEqual(svc.actions.at('Vann').inscribe.first, 100, 'and the height it happened at');
});

test('an etching earns an etch and NOT an inscription, though it is both', async () => {
  const chain = new FakeChain().add(100, [etchTx('e1', { txid: 'c0', vout: 0 }, 'Vbob', 'GRUMPY')]);
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(svc.runes.runes.size, 1, 'the etch has to have been accepted for this to mean anything');
  assert.deepStrictEqual(did(svc, 'Vbob'), ['etch'], 'an etch must not also pay as an inscription');
  assert.strictEqual(sharesOf(svc.actions.at('Vbob')), 1);
});

test('an etching the rune indexer REFUSED still earns an inscription', async () => {
  // The ticker price is underpaid, so the name is not taken and no rune exists. The reveal is real
  // either way, and paying it as nothing at all would punish somebody for a failed attempt.
  const chain = new FakeChain()
    .add(100, [etchTx('e1', { txid: 'c0', vout: 0 }, 'Vcar', 'GRUMPY', {}, 1)]);
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(svc.runes.runes.size, 0, 'the etch must really have failed for this test to mean anything');
  assert.deepStrictEqual(did(svc, 'Vcar'), ['inscribe']);
});

test('a coin mint earns the address the coins landed on', async () => {
  const chain = new FakeChain()
    .add(100, [etchTx('e1', { txid: 'c0', vout: 0 }, 'Vbob', 'OPEN', { p: 0, m: { a: 1000 } })]);
  const svc = service(chain);
  await svc.sync();
  chain.add(101, [{
    txid: 'm1', vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
    vout: [out('Vdee'), opret(codec.encodeMint(codec.refOf(100, 0)))],
  }]);
  await svc.sync();
  assert.strictEqual(svc.runes.balanceOf('m1:0', codec.refOf(100, 0)), 1000, 'the mint has to have worked');
  assert.deepStrictEqual(did(svc, 'Vdee'), ['coin']);
});

test('a mint the rune indexer REFUSED earns nothing', async () => {
  const chain = new FakeChain()
    .add(100, [etchTx('e1', { txid: 'c0', vout: 0 }, 'Vbob', 'CAPPED', { p: 0, m: { a: 1000, c: 1 } })]);
  const svc = service(chain);
  await svc.sync();
  const mint = (txid, to) => ({
    txid, vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
    vout: [out(to), opret(codec.encodeMint(codec.refOf(100, 0)))],
  });
  chain.add(101, [mint('m1', 'Vdee')]).add(102, [mint('m2', 'Vell')]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vdee'), ['coin'], 'the first mint took the only one there was');
  assert.deepStrictEqual(did(svc, 'Vell'), [], 'the second was over the cap and earns nothing');
});

test('a mint that claims the root AND spends the tip earns an alpha', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  assert.strictEqual(svc.alphaTip.outpoint, `${ROOT}:0`, 'the chain has to start somewhere');
  chain.add(101, [mintTx('a1', { txid: 'commit1', vout: 0 }, { txid: ROOT, vout: 0 }, 'Vfay')]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vfay'), ['alpha']);
  assert.strictEqual(svc.alphaTip.outpoint, 'a1:1', 'and the tip follows the carry-forward');
});

test('CLAIMING the root without spending the tip earns only an inscription', async () => {
  // The forgery this guards against: the tag-3 claim is a string anybody can write into a cheap
  // inscription, and on its own it would buy three of the eight shares for the price of one reveal.
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  chain.add(101, [revealTx('fake', { txid: 'mine', vout: 0 }, 'Vliar', 'image/webp', Buffer.from('art'),
    parentIdToBuffer(ROOT_ID))]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vliar'), ['inscribe'], 'a claim nobody backed is not an Alpha');
  assert.strictEqual(svc.alphaTip.outpoint, `${ROOT}:0`, 'and the tip did not move');
});

test('spending the tip without claiming the root is not an alpha either', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  // The operator refreshing their own carrier, revealing nothing.
  chain.add(101, [{ txid: 'refresh', vin: [{ txid: ROOT, vout: 0, scriptSig: { hex: '' } }],
    vout: [out(OP, TIP_VALUE)] }]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, OP), ['inscribe'], 'only the root reveal itself');
  assert.strictEqual(svc.alphaTip.outpoint, 'refresh:0', 'the tip moved with the carrier');
});

test('THE REGRESSION: an alpha still counts after the root inscription is burned', async () => {
  // What actually happened on mainnet at height 9,304,347. The inscription's offset inside the
  // carrier creeps forward by the fee on every carry-forward until it walks off the end, and the
  // ordinal rules then say it was paid to the miner. Reading the VERIFIED parent reported nothing
  // for 1,290 mints. The utxo chain is untouched by any of it.
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();

  let tip = { txid: ROOT, vout: 0 };
  for (let i = 0; i < 3; i++) {
    chain.add(101 + i, [mintTx('m' + i, { txid: 'commit' + i, vout: 0 }, tip, 'Vbuy' + i)]);
    tip = { txid: 'm' + i, vout: 1 };
  }
  await svc.sync();

  const root = svc.inscriptions.inscriptions.get(ROOT_ID);
  assert.strictEqual(root.location, 'burned', 'the harness must reproduce the burn, or this proves nothing');

  // The first mint still verifies: the claim is checked against the inscriptions the transaction
  // SPENDS, and the burn happens later in that same transaction. Mainnet did exactly this, which is
  // why inscriptions 5 and 6 have a parent and everything from 7 does not.
  assert.strictEqual(svc.inscriptions.inscriptions.get('m0i0').parent, ROOT_ID);
  for (let i = 1; i < 3; i++) {
    assert.strictEqual(svc.inscriptions.inscriptions.get(`m${i}i0`).parent, null,
      `mint ${i} must have NO verified parent, which is the whole point`);
  }
  for (let i = 0; i < 3; i++) {
    assert.deepStrictEqual(did(svc, 'Vbuy' + i), ['alpha'], `mint ${i} must still count as an Alpha`);
  }
});

test('with no collection configured, the same mint is simply an inscription', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, null);
  await svc.sync();
  chain.add(101, [mintTx('a1', { txid: 'commit1', vout: 0 }, { txid: ROOT, vout: 0 }, 'Vfay')]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vfay'), ['inscribe']);
  assert.strictEqual(svc.alphaTip, null, 'and no chain is followed at all');
});

// --- adding up --------------------------------------------------------------------------------------

test('four different actions by one address are four shares', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  chain
    .add(101, [mintTx('a1', { txid: 'commit1', vout: 0 }, { txid: ROOT, vout: 0 }, 'Vzoe')])
    .add(102, [revealTx('i1', { txid: 'c9', vout: 0 }, 'Vzoe', 'text/plain', Buffer.from('gm'))])
    .add(103, [etchTx('e1', { txid: 'c8', vout: 0 }, 'Vzoe', 'OPEN', { p: 0, m: { a: 1000 } })])
    .add(104, [{ txid: 'm1', vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
      vout: [out('Vzoe'), opret(codec.encodeMint(codec.refOf(103, 0)))] }]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vzoe'), ['alpha', 'coin', 'etch', 'inscribe']);
  assert.strictEqual(sharesOf(svc.actions.at('Vzoe')), 4, 'one of each is four of the eight');
});

test('minting three Alphas earns three shares, and a fourth earns none', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  let tip = { txid: ROOT, vout: 0 };
  for (let i = 0; i < 4; i++) {
    chain.add(101 + i, [mintTx('mint' + i, { txid: 'commit' + i, vout: 0 }, tip, 'Vmax')]);
    tip = { txid: 'mint' + i, vout: 1 };
  }
  await svc.sync();
  assert.strictEqual(times(svc, 'Vmax', 'alpha'), 3, 'the fourth Alpha is over the ceiling');
  assert.strictEqual(sharesOf(svc.actions.at('Vmax')), 3);
});

test('a full bar is reachable, and nothing beyond it is', async () => {
  const chain = new FakeChain().add(100, [rootTx('c0')]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  let tip = { txid: ROOT, vout: 0 };
  for (let i = 0; i < 3; i++) {
    chain.add(101 + i, [mintTx('a' + i, { txid: 'commit' + i, vout: 0 }, tip, 'Vall')]);
    tip = { txid: 'a' + i, vout: 1 };
  }
  chain.add(104, [revealTx('ins', { txid: 'c7', vout: 0 }, 'Vall', 'text/plain', Buffer.from('gm'))]);
  chain.add(105, [etchTx('e1', { txid: 'c8', vout: 0 }, 'Vall', 'OPEN', { p: 0, m: { a: 1000 } })]);
  for (let i = 0; i < 4; i++) {
    chain.add(106 + i, [{ txid: 'm' + i, vin: [{ txid: 'f' + i, vout: 0, scriptSig: { hex: '' } }],
      vout: [out('Vall'), opret(codec.encodeMint(codec.refOf(105, 0)))] }]);
  }
  await svc.sync();
  assert.strictEqual(times(svc, 'Vall', 'coin'), 3, 'the fourth coin mint is over the ceiling');
  assert.strictEqual(sharesOf(svc.actions.at('Vall')), MAX_SHARES, 'and that is the whole bar');
});

test('inscribing ten times is still one share, because inscribing caps at one', async () => {
  const chain = new FakeChain();
  for (let i = 0; i < 10; i++) {
    chain.add(100 + i, [revealTx('i' + i, { txid: 'c' + i, vout: 0 }, 'Vsam', 'text/plain', Buffer.from('x' + i))]);
  }
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(sharesOf(svc.actions.at('Vsam')), 1);
  assert.strictEqual(svc.actions.at('Vsam').inscribe.first, 100, 'the first one is the one that counts');
});

// --- the chain changing its mind -----------------------------------------------------------------------

test('a reorg that erases an etch takes the etch off the roll', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r0', { txid: 'c0', vout: 0 }, 'Vann', 'text/plain', Buffer.from('gm'))])
    .add(101, [], 'a').add(102, [etchTx('e1', { txid: 'c1', vout: 0 }, 'Vbob', 'GRUMPY')], 'a')
    .add(103, [], 'a');
  const svc = service(chain);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vbob'), ['etch']);

  // The chain re-mines from 102 without the etching.
  chain.forkAt(101).add(102, [], 'b').add(103, [], 'b').add(104, [], 'b');
  await svc.sync();

  assert.deepStrictEqual(did(svc, 'Vbob'), [], 'the etch was re-mined away and must not still count');
  assert.deepStrictEqual(did(svc, 'Vann'), ['inscribe'], 'and the block before the fork is untouched');
});

test('a repaired scan agrees exactly with a fresh scan of the same chain', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r0', { txid: 'c0', vout: 0 }, 'Vann', 'text/plain', Buffer.from('gm'))])
    .add(101, [], 'a').add(102, [etchTx('e1', { txid: 'c1', vout: 0 }, 'Vbob', 'GRUMPY')], 'a')
    .add(103, [], 'a');
  const svc = service(chain);
  await svc.sync();
  chain.forkAt(101)
    .add(102, [etchTx('e2', { txid: 'c2', vout: 0 }, 'Vcar', 'GRUMPY')], 'b')
    .add(103, [], 'b').add(104, [], 'b');
  await svc.sync();

  const fresh = service(chain);
  await fresh.sync();
  assert.deepStrictEqual(svc.actions.toJSON(), fresh.actions.toJSON());
  assert.deepStrictEqual(did(svc, 'Vcar'), ['etch']);
  assert.deepStrictEqual(did(svc, 'Vbob'), []);
});

(async () => {
  for (const [name, fn] of queued) { await fn(); passed++; console.log('  ok - ' + name); }
  console.log(`\nairdrop scan: ${passed} passed`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
