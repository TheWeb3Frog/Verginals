// One scan, two ledgers, and a chain that changes its mind.
//
// The property that matters most here is the last test: after a reorg is repaired, the state must be
// EXACTLY what a fresh scan of the new chain produces. Anything less and the index is quietly wrong
// in a way nobody would notice until two indexers compared roots.
//
// Run: node test/indexservice.test.js
const assert = require('assert');
const { IndexService, ReorgTooDeep } = require('../src/indexservice');
const { BlockTrail, findFork } = require('../src/reorg');
const { decodeBlock, xvgToUnits } = require('../src/rpc');
const { buildInscriptionScript, pushData } = require('../src/envelope');
const cbor = require('../src/cbor');
const codec = require('../src/runes/codec');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const queued = [];
const test = (name, fn) => queued.push([name, fn]);

const PUBKEY = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)]);
const RUNE_TYPE = 'application/vnd.verge-rune+cbor';
const xvg = (units) => units / 1e6;

// --- building raw verbose blocks, the shape the node really hands back ---------------------------

const scriptSigOf = (redeem) => ({ hex: pushData(redeem).toString('hex') });
const opReturnHex = (payload) => '6a' + payload.length.toString(16).padStart(2, '0') + payload.toString('hex');
const out = (units, hex = '76a914' + '11'.repeat(20) + '88ac') =>
  ({ value: xvg(units), scriptPubKey: { hex, addresses: ['DTEST'] } });
const opret = (payload) => ({ value: 0, scriptPubKey: { hex: opReturnHex(payload) } });

/** A plain inscription reveal. */
function revealTx(txid, from, contentType, body, parents = []) {
  const redeem = buildInscriptionScript({ pubkey: PUBKEY, contentType, body, parents });
  return {
    txid,
    vin: [{ txid: from, vout: 0, scriptSig: scriptSigOf(redeem) }],
    vout: [out(100000)],
  };
}

/** A rune etching: an inscription carrying the rune content type, plus the output that pays for it. */
function etchTx(txid, from, ticker, extra = {}) {
  const paid = lockFor(ticker);
  const body = cbor.encode(Object.assign({
    t: ticker, n: ticker, d: 0, s: 100000, p: 100000, l: { t: paid.lock.t, k: paid.lock.k },
  }, extra));
  const redeem = buildInscriptionScript({ pubkey: PUBKEY, contentType: RUNE_TYPE, body });
  return {
    txid,
    vin: [{ txid: from, vout: 0, scriptSig: scriptSigOf(redeem) }],
    vout: [out(100000), { value: xvg(paid.output.value), scriptPubKey: { hex: paid.output.scriptPubKey.toString('hex') } }],
  };
}

/** A fake node. Blocks are built with real hashes so the trail has something honest to follow. */
class FakeChain {
  constructor() {
    this.blocks = new Map();   // height -> raw verbose block
    this.values = new Map();   // "txid:vout" -> atomic units
    this.rawCalls = 0;         // how often anything asked the node to value an input
  }

  add(height, txs, tag = 'a') {
    const prev = this.blocks.get(height - 1);
    const block = {
      height,
      hash: `${tag}${height}`.padStart(8, '0'),
      previousblockhash: prev ? prev.hash : null,
      time: lockFor('AAAA').time,
      tx: txs,
    };
    this.blocks.set(height, block);
    for (const tx of txs) {
      tx.vout.forEach((o, i) => this.values.set(`${tx.txid}:${i}`, xvgToUnits(o.value)));
    }
    return this;
  }

  /** Drop everything above `height` so a different history can be built on top. */
  forkAt(height) {
    for (const h of [...this.blocks.keys()]) if (h > height) this.blocks.delete(h);
    return this;
  }

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
        this.rawCalls += 1;
        prevValues.set(key, this.values.get(key) != null ? this.values.get(key) : 500000);
      }
    }
    return decodeBlock(block, prevValues);
  }
}

const service = (chain, from = 100) => new IndexService({ runeOpts: { activationHeight: 0, etchMaturity: 0 },
  chain, from, runesFrom: from, trailDepth: 50, snapshotInterval: 2,
});

// --- the trail ----------------------------------------------------------------------------------

test('a trail follows hashes and forgets what is too old to matter', () => {
  const t = new BlockTrail(3);
  for (let h = 1; h <= 10; h++) t.record(h, 'h' + h);
  assert.strictEqual(t.hashAt(10), 'h10');
  assert.strictEqual(t.hashAt(6), null, 'should have been pruned');
  assert.strictEqual(t.oldest(), 7);
});

test('the first block of a scan has nothing to disagree with', () => {
  const t = new BlockTrail();
  assert.strictEqual(t.continues(100, 'anything'), true);
  t.record(100, 'h100');
  assert.strictEqual(t.continues(101, 'h100'), true);
  assert.strictEqual(t.continues(101, 'somethingelse'), false);
});

test('findFork walks back to the last height both sides agree on', async () => {
  const t = new BlockTrail(50);
  for (let h = 100; h <= 110; h++) t.record(h, 'old' + h);
  const chain = { getBlockHash: async (h) => (h <= 105 ? 'old' + h : 'new' + h) };
  assert.strictEqual(await findFork(t, chain, 111), 105);
});

test('a fork deeper than the trail is reported rather than guessed at', async () => {
  const t = new BlockTrail(50);
  for (let h = 100; h <= 110; h++) t.record(h, 'old' + h);
  const chain = { getBlockHash: async () => 'nothingmatches' };
  assert.strictEqual(await findFork(t, chain, 111), null);
});

// --- one scan, two ledgers ----------------------------------------------------------------------

test('a single scan fills both the inscription and the rune ledger', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('hello'))])
    .add(101, [etchTx('e1', 'c1', 'GRUMPY')]);
  const svc = service(chain);
  await svc.sync();

  assert.strictEqual(svc.inscriptions.inscriptions.size, 2, 'the etching is an inscription too');
  assert.strictEqual(svc.runes.runes.size, 1);
  assert.strictEqual(svc.runes.tickers.get('GRUMPY'), codec.refOf(101, 0));
  assert.strictEqual(svc.runes.balanceOf('e1:0', codec.refOf(101, 0)), 100000);
  assert.strictEqual(svc.scannedThrough, 101);
});

test('the mint fee is read from values the block fetch already resolved', async () => {
  const chain = new FakeChain()
    .add(100, [etchTx('e1', 'c1', 'PRICED', { p: 0, m: { a: 1000, f: 20 * 1e6 } })]);
  const svc = service(chain);
  await svc.sync();
  const before = chain.rawCalls;

  // A mint paying 20 XVG in fee: one input of 30 XVG, one output of 10 XVG.
  chain.values.set('funder:0', 30 * 1e6);
  chain.add(101, [{ txid: 'm1', vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
    vout: [out(10 * 1e6), opret(codec.encodeMint(codec.refOf(100, 0)))] }]);
  await svc.sync();

  assert.strictEqual(svc.runes.balanceOf('m1:0', codec.refOf(100, 0)), 1000, 'the priced mint was credited');
  assert.strictEqual(chain.rawCalls - before, 1,
    'the fee must cost no lookup beyond the one the block fetch already did');
});

test('an underpaid mint is still refused', async () => {
  const chain = new FakeChain()
    .add(100, [etchTx('e1', 'c1', 'PRICED', { p: 0, m: { a: 1000, f: 20 * 1e6 } })]);
  chain.values.set('funder:0', 30 * 1e6);
  chain.add(101, [{ txid: 'm1', vin: [{ txid: 'funder', vout: 0, scriptSig: { hex: '' } }],
    vout: [out(29 * 1e6), opret(codec.encodeMint(codec.refOf(100, 0)))] }]); // 1 XVG fee
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(svc.runes.balanceOf('m1:0', codec.refOf(100, 0)), 0);
});

// --- the reason the two belong in one service ---------------------------------------------------

test('a rune parent claim is only kept when the etching spends the parent', async () => {
  const parentId = 'p1i0';
  const chain = new FakeChain()
    .add(100, [revealTx('p1', 'c0', 'text/plain', Buffer.from('collection'))])
    // claims the parent but spends an unrelated coin
    .add(101, [etchTx('liar', 'unrelated', 'FAKER', { k: parentId })])
    // claims it AND spends it
    .add(102, [etchTx('honest', 'p1', 'TRUER', { k: parentId })]);
  const svc = service(chain);
  await svc.sync();

  assert.strictEqual(svc.runes.runes.get(codec.refOf(101, 0)).parent, null,
    'an unspent parent claim must not be believed');
  assert.strictEqual(svc.runes.runes.get(codec.refOf(102, 0)).parent, parentId,
    'a claim backed by spending the parent stands');
});

// --- reorgs -------------------------------------------------------------------------------------

test('a reorg is noticed instead of silently absorbed', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('one'))])
    .add(101, [revealTx('r2', 'c1', 'text/plain', Buffer.from('two'))])
    .add(102, [revealTx('r3', 'c2', 'text/plain', Buffer.from('three'))]);
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(svc.inscriptions.inscriptions.size, 3);

  chain.forkAt(101).add(102, [revealTx('x3', 'c9', 'text/plain', Buffer.from('other'))], 'b');
  chain.add(103, [revealTx('x4', 'c8', 'text/plain', Buffer.from('more'))], 'b');
  await svc.sync();

  assert.strictEqual(svc.reorgs, 1, 'the fork should have been detected');
  assert.strictEqual(svc.scannedThrough, 103, 'and repaired within the same sync');
  const ids = svc.inscriptions.list().map((i) => i.id);
  assert.ok(ids.includes('x3i0') && ids.includes('x4i0'), 'the replacement blocks were read');
  assert.ok(!ids.includes('r3i0'), 'the orphaned inscription must be gone, not merely outnumbered');
});

test('a reorg with no new blocks at all is still caught', async () => {
  // The trap this closes: blocks replaced at heights already counted leave the tip NUMBER unchanged,
  // so a scan that only ever inspects new blocks fetches nothing and notices nothing.
  const chain = new FakeChain()
    .add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('one'))])
    .add(101, [revealTx('r2', 'c1', 'text/plain', Buffer.from('two'))]);
  const svc = service(chain);
  await svc.sync();
  assert.strictEqual(svc.scannedThrough, 101);

  chain.forkAt(100).add(101, [revealTx('z2', 'c5', 'text/plain', Buffer.from('replaced'))], 'b');
  await svc.sync();

  assert.strictEqual(svc.reorgs, 1, 'a same-height reorg must not slip past');
  const ids = svc.inscriptions.list().map((i) => i.id);
  assert.deepStrictEqual(ids, ['r1i0', 'z2i0']);
});

test('after a repair the state is EXACTLY a fresh scan of the new chain', async () => {
  const build = () => new FakeChain()
    .add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('one'))])
    .add(101, [etchTx('e1', 'c1', 'GRUMPY')])
    .add(102, [revealTx('r3', 'c2', 'text/plain', Buffer.from('three'))])
    .add(103, [revealTx('r4', 'c3', 'text/plain', Buffer.from('four'))]);

  // one service lives through the reorg
  const live = build();
  const svc = service(live);
  await svc.sync();
  live.forkAt(101)
    .add(102, [etchTx('e2', 'c7', 'OTHER')], 'b')
    .add(103, [revealTx('y4', 'c6', 'text/plain', Buffer.from('new four'))], 'b');
  await svc.sync();   // detects and rewinds
  await svc.sync();   // reads the new blocks

  // another sees only the final chain, from scratch
  const fresh = build();
  fresh.forkAt(101)
    .add(102, [etchTx('e2', 'c7', 'OTHER')], 'b')
    .add(103, [revealTx('y4', 'c6', 'text/plain', Buffer.from('new four'))], 'b');
  const clean = service(fresh);
  await clean.sync();

  assert.strictEqual(svc.scannedThrough, clean.scannedThrough);
  assert.strictEqual(svc.inscriptions.digest(), clean.inscriptions.digest(),
    'the inscription ledger must match a fresh scan');
  assert.deepStrictEqual(svc.runes.toJSON(), clean.runes.toJSON(),
    'the rune ledger must match a fresh scan');
  assert.ok(!svc.runes.tickers.has('GRUMPY') === !clean.runes.tickers.has('GRUMPY'));
  assert.ok(svc.runes.tickers.has('OTHER'), 'the replacement chain etched OTHER');
});

test('a reorg deeper than the trail refuses rather than pretending', async () => {
  const chain = new FakeChain();
  for (let h = 100; h <= 108; h++) chain.add(h, [revealTx('r' + h, 'c' + h, 'text/plain', Buffer.from('x'))]);
  const svc = new IndexService({ runeOpts: { activationHeight: 0, etchMaturity: 0 }, chain, from: 100, trailDepth: 2, snapshotInterval: 1000 });
  await svc.sync();

  chain.forkAt(100);
  for (let h = 101; h <= 109; h++) chain.add(h, [revealTx('z' + h, 'c' + h, 'text/plain', Buffer.from('y'))], 'b');
  await assert.rejects(() => svc.sync(), ReorgTooDeep);
});

// --- persistence --------------------------------------------------------------------------------

test('state survives a round trip through JSON', async () => {
  const chain = new FakeChain()
    .add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('one'))])
    .add(101, [etchTx('e1', 'c1', 'GRUMPY', { a: Buffer.alloc(32, 7) })]);
  const svc = service(chain);
  await svc.sync();

  const revived = service(chain);
  const r = revived.load(JSON.parse(JSON.stringify(svc.toJSON())));
  assert.ok(r.ok, r.reason);
  assert.strictEqual(revived.inscriptions.digest(), svc.inscriptions.digest());
  assert.deepStrictEqual(revived.runes.toJSON(), svc.runes.toJSON());
  const rec = revived.runes.runes.get(codec.refOf(101, 0));
  assert.ok(Buffer.isBuffer(rec.allowlistRoot), 'the allowlist root must come back as bytes');
  assert.ok(rec.allowlistRoot.equals(Buffer.alloc(32, 7)));
  assert.strictEqual(revived.trail.hashAt(101), svc.trail.hashAt(101));
});

test('a state file from a different start height is refused, not adapted', async () => {
  const chain = new FakeChain().add(100, [revealTx('r1', 'c0', 'text/plain', Buffer.from('x'))]);
  const svc = service(chain, 100);
  await svc.sync();
  const other = new IndexService({ runeOpts: { activationHeight: 0, etchMaturity: 0 }, chain, from: 200, runesFrom: 200 });
  const r = other.load(svc.toJSON());
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /built from height 100/);
});

(async () => {
  for (const [name, fn] of queued) { await fn(); passed += 1; console.log('  ok - ' + name); }
  console.log('\nindex service: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
