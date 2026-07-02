// Indexer core tests: extraction, deterministic numbering, FIFO transfer, burn, digest.
// Run: node test/indexer.test.js
const assert = require('assert');
const { Indexer } = require('../src/indexer');
const { buildInscriptionScript, parentIdToBuffer } = require('../src/envelope');
const cbor = require('../src/cbor');

const pubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xcd)]);
const ws = (contentType, text) =>
  buildInscriptionScript({ pubkey, contentType, body: Buffer.from(text, 'utf8') });

// Helpers to build decoded txs.
const reveal = (txid, contentType, text, commitTxid = 'c0'.repeat(32)) => ({
  txid,
  ins: [{ txid: commitTxid, vout: 0, value: 100_000, inscriptionScript: ws(contentType, text) }],
  outs: [{ value: 98_000 }],
});
const plain = (txid, ins, outs) => ({ txid, ins, outs });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('reveal creates inscription #0 at <revealtxid>:0', () => {
  const ix = new Indexer();
  ix.processBlock({ height: 100, txs: [reveal('aa'.repeat(32), 'text/plain', 'hi')] });
  const list = ix.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].number, 0);
  assert.strictEqual(list[0].id, `${'aa'.repeat(32)}i0`);
  assert.strictEqual(list[0].contentType, 'text/plain');
  assert.strictEqual(list[0].location, `${'aa'.repeat(32)}:0`);
  assert.strictEqual(list[0].genesisHeight, 100);
});

test('numbering follows block order then tx order', () => {
  const ix = new Indexer();
  ix.processBlock({
    height: 1,
    txs: [reveal('a1'.repeat(32), 'text/plain', 'first'), reveal('a2'.repeat(32), 'text/plain', 'second')],
  });
  const [i0, i1] = ix.list();
  assert.strictEqual(i0.number, 0);
  assert.strictEqual(i0.id, `${'a1'.repeat(32)}i0`);
  assert.strictEqual(i1.number, 1);
  assert.strictEqual(i1.id, `${'a2'.repeat(32)}i0`);
});

test('FIFO transfer: inscription on a non-first input lands in the correct output', () => {
  const ix = new Indexer();
  const rtxid = 'bb'.repeat(32);
  ix.processBlock({ height: 1, txs: [reveal(rtxid, 'text/plain', 'move me')] });
  // inscription is at rtxid:0, offset 0, in an output worth 98_000.
  // Spend it as the SECOND input, behind a 5_000 non-inscribed input.
  const ttxid = 'dd'.repeat(32);
  ix.processBlock({
    height: 2,
    txs: [
      plain(
        ttxid,
        [
          { txid: 'ee'.repeat(32), vout: 0, value: 5_000, inscriptionScript: null },
          { txid: rtxid, vout: 0, value: 98_000, inscriptionScript: null },
        ],
        // global offset = 5_000 + 0 = 5_000 → falls in output 1 ([5_000, 95_000))
        [{ value: 5_000 }, { value: 90_000 }]
      ),
    ],
  });
  const rec = ix.list()[0];
  assert.strictEqual(rec.location, `${ttxid}:1`, `expected ${ttxid}:1, got ${rec.location}`);
});

test('inscription spent entirely to fee is burned', () => {
  const ix = new Indexer();
  const rtxid = 'ff'.repeat(32);
  ix.processBlock({ height: 1, txs: [reveal(rtxid, 'text/plain', 'rip')] });
  // Spend the inscribed output with NO outputs ⇒ everything to fee.
  ix.processBlock({
    height: 2,
    txs: [plain('07'.repeat(32), [{ txid: rtxid, vout: 0, value: 98_000, inscriptionScript: null }], [])],
  });
  assert.strictEqual(ix.list()[0].location, 'burned');
});

test('surfaces decoded tag-5 metadata, and does not fold it into the digest', () => {
  const meta = cbor.encode({ name: 'Verginals #5', attributes: [{ trait_type: 'House', value: 'Earth' }] });
  const script = buildInscriptionScript({ pubkey, contentType: 'image/webp', body: Buffer.from('img'), metadata: meta });
  const rtxid = '5a'.repeat(32);
  const tx = { txid: rtxid, ins: [{ txid: 'c0'.repeat(32), vout: 0, value: 100_000, inscriptionScript: script }], outs: [{ value: 98_000 }] };

  const ix = new Indexer();
  ix.processBlock({ height: 1, txs: [tx] });
  const rec = ix.list()[0];
  assert.strictEqual(rec.metadata.length, 1);
  assert.deepStrictEqual(rec.metadata[0], { name: 'Verginals #5', attributes: [{ trait_type: 'House', value: 'Earth' }] });

  // Same inscription without metadata must yield the SAME digest (metadata is display-only, §6).
  const noMeta = { txid: rtxid, ins: [{ txid: 'c0'.repeat(32), vout: 0, value: 100_000, inscriptionScript: ws('image/webp', 'img') }], outs: [{ value: 98_000 }] };
  const ix2 = new Indexer();
  ix2.processBlock({ height: 1, txs: [noMeta] });
  assert.strictEqual(ix.digest(), ix2.digest());
});

test('malformed metadata is surfaced as hex, never throwing', () => {
  const { decodeMetadata } = require('../src/indexer');
  const out = decodeMetadata([Buffer.from('ff', 'hex')]); // 0xff is not decodable in our subset
  assert.deepStrictEqual(out, [{ hex: 'ff' }]);
});

test('tag-3 parent is verified only when the reveal spends the parent utxo; child links back', () => {
  const ix = new Indexer();
  const parentTxid = 'a0'.repeat(32);
  const parentId = `${parentTxid}i0`;
  // 1) Inscribe the collection root (parent) with a 100_000-unit carrier at parentTxid:0.
  ix.processBlock({ height: 1, txs: [reveal(parentTxid, 'application/json', 'root')] });

  // 2) Child reveal that DOES spend the parent utxo (offset math lands parent in output 1).
  const childScript = buildInscriptionScript({
    pubkey,
    contentType: 'image/webp',
    body: Buffer.from('child'),
    parent: parentIdToBuffer(parentId),
  });
  const childTxid = 'b0'.repeat(32);
  ix.processBlock({
    height: 2,
    txs: [
      {
        txid: childTxid,
        ins: [
          { txid: 'c0'.repeat(32), vout: 0, value: 50_000, inscriptionScript: childScript },
          { txid: parentTxid, vout: 0, value: 100_000, inscriptionScript: null }, // spends the parent
        ],
        outs: [{ value: 50_000 }, { value: 90_000 }], // out0=child carrier, out1=parent carry-forward
      },
    ],
  });

  const child = ix.inscriptions.get(`${childTxid}i0`);
  assert.strictEqual(child.location, `${childTxid}:0`, 'child binds to output 0');
  assert.deepStrictEqual(child.parents, [parentId], 'raw tag-3 claim is recorded');
  assert.strictEqual(child.parent, parentId, 'parent verified because reveal spent the parent utxo');

  const parent = ix.inscriptions.get(parentId);
  assert.strictEqual(parent.location, `${childTxid}:1`, 'parent carried forward to output 1');
  assert.deepStrictEqual(parent.children, [`${childTxid}i0`], 'child linked into parent record');
});

test('tag-3 parent is NOT verified when the reveal does not spend the parent utxo', () => {
  const ix = new Indexer();
  const parentTxid = 'a1'.repeat(32);
  const parentId = `${parentTxid}i0`;
  ix.processBlock({ height: 1, txs: [reveal(parentTxid, 'application/json', 'root')] });

  const childScript = buildInscriptionScript({
    pubkey,
    contentType: 'image/webp',
    body: Buffer.from('forged'),
    parent: parentIdToBuffer(parentId),
  });
  const childTxid = 'b1'.repeat(32);
  ix.processBlock({
    height: 2,
    txs: [
      {
        txid: childTxid,
        // Commit input only; the parent utxo is untouched, so the claim is unverified.
        ins: [{ txid: 'c1'.repeat(32), vout: 0, value: 50_000, inscriptionScript: childScript }],
        outs: [{ value: 48_000 }],
      },
    ],
  });

  const child = ix.inscriptions.get(`${childTxid}i0`);
  assert.deepStrictEqual(child.parents, [parentId], 'raw claim still recorded');
  assert.strictEqual(child.parent, null, 'claim NOT verified: reveal did not spend the parent');
  const parent = ix.inscriptions.get(parentId);
  assert.deepStrictEqual(parent.children, [], 'no child linked for an unverified claim');
});

test('digest is reproducible across independent runs', () => {
  const run = () => {
    const ix = new Indexer();
    ix.processBlock({
      height: 1,
      txs: [reveal('11'.repeat(32), 'image/png', 'a'), reveal('12'.repeat(32), 'text/plain', 'b')],
    });
    ix.processBlock({
      height: 2,
      txs: [plain('13'.repeat(32), [{ txid: '11'.repeat(32), vout: 0, value: 98_000, inscriptionScript: null }], [{ value: 96_000 }])],
    });
    return ix.digest();
  };
  assert.strictEqual(run(), run());
  assert.match(run(), /^[0-9a-f]{64}$/);
});

console.log(`\n${passed} tests passed`);
