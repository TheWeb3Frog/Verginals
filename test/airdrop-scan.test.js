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
const { sharesOf } = require('../src/airdrop');
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
  .filter(([, h]) => h != null).map(([k]) => k).sort();

// --- one action each ------------------------------------------------------------------------------

test('an inscription reveal earns the address that received it', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r1', { txid: 'c0', vout: 0 }, 'Vann', 'text/plain', Buffer.from('gm'))]);
  const svc = service(chain);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vann'), ['inscribe']);
  assert.strictEqual(svc.actions.at('Vann').inscribe, 100, 'and the height it happened at');
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

test('a reveal parented to the Alpha root earns an alpha, not an inscription', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx(ROOT, { txid: 'c0', vout: 0 }, 'Vteam', 'text/plain', Buffer.from('collection'))]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  // The child must SPEND the parent for the claim to be verified, which is the same rule the
  // inscription indexer already enforces.
  chain.add(101, [revealTx('a1', { txid: ROOT, vout: 0 }, 'Vfay', 'image/webp', Buffer.from('art'),
    parentIdToBuffer(ROOT_ID))]);
  await svc.sync();
  assert.strictEqual(svc.inscriptions.inscriptions.get('a1i0').parent, ROOT_ID, 'the parent must be verified');
  assert.deepStrictEqual(did(svc, 'Vfay'), ['alpha']);
});

test('with no collection configured, the same reveal is simply an inscription', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx(ROOT, { txid: 'c0', vout: 0 }, 'Vteam', 'text/plain', Buffer.from('collection'))]);
  const svc = service(chain, null);
  await svc.sync();
  chain.add(101, [revealTx('a1', { txid: ROOT, vout: 0 }, 'Vfay', 'image/webp', Buffer.from('art'),
    parentIdToBuffer(ROOT_ID))]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vfay'), ['inscribe']);
});

// --- adding up --------------------------------------------------------------------------------------

test('four different actions by one address are four shares', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx(ROOT, { txid: 'c0', vout: 0 }, 'Vteam', 'text/plain', Buffer.from('c'))]);
  const svc = service(chain, ROOT_ID);
  await svc.sync();
  chain
    .add(101, [revealTx('a1', { txid: ROOT, vout: 0 }, 'Vzoe', 'image/webp', Buffer.from('art'), parentIdToBuffer(ROOT_ID))])
    .add(102, [revealTx('i1', { txid: 'c9', vout: 0 }, 'Vzoe', 'text/plain', Buffer.from('gm'))])
    .add(103, [etchTx('e1', { txid: 'c8', vout: 0 }, 'Vzoe', 'OPEN', { p: 0, m: { a: 1000 } })])
    .add(104, [{ txid: 'm1', vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
      vout: [out('Vzoe'), opret(codec.encodeMint(codec.refOf(103, 0)))] }]);
  await svc.sync();
  assert.deepStrictEqual(did(svc, 'Vzoe'), ['alpha', 'coin', 'etch', 'inscribe']);
  assert.strictEqual(sharesOf(svc.actions.at('Vzoe')), 4);
});

test('doing the same thing ten times is still one share', async () => {
  const chain = new FakeChain();
  for (let i = 0; i < 10; i++) {
    chain.add(100 + i, [revealTx('i' + i, { txid: 'c' + i, vout: 0 }, 'Vsam', 'text/plain', Buffer.from('x' + i))]);
  }
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(sharesOf(svc.actions.at('Vsam')), 1);
  assert.strictEqual(svc.actions.at('Vsam').inscribe, 100, 'the first one is the one that counts');
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
