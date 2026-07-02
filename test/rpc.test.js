// RPC decoder tests: verbose-block JSON -> indexer shape, offline (no live node).
// Run: node test/rpc.test.js
const assert = require('assert');
const {
  xvgToUnits,
  extractRedeemScript,
  decodeTx,
  decodeBlock,
  prevoutRefs,
} = require('../src/rpc');
const { ECPair, toBitcoinjsNetwork, buildInscriptionScripts, buildReveal } = require('../src/builder');
const { Indexer } = require('../src/indexer');
const { testnet, COIN } = require('../src/networks');
const bitcoin = require('bitcoinjs-lib');

const network = toBitcoinjsNetwork(testnet);
const signer = ECPair.fromPrivateKey(Buffer.alloc(32, 1), { network });
const pubkey = Buffer.from(signer.publicKey);
const payout = bitcoin.payments.p2pkh({ pubkey, network }).address;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Turn a signed Verge tx (plain object) into the verbose-RPC tx JSON a node would return.
function toVerboseTx(tx, txid, prevTxid) {
  return {
    txid,
    vin: tx.vin.map((inp, i) => ({
      txid: prevTxid,
      vout: i,
      scriptSig: { hex: inp.script.toString('hex') },
    })),
    vout: tx.vout.map((o, n) => ({ value: Number(o.value) / COIN, n })),
  };
}

test('xvgToUnits converts 6-decimal XVG to atomic units', () => {
  assert.strictEqual(xvgToUnits(0), 0);
  assert.strictEqual(xvgToUnits(0.1), 100_000);
  assert.strictEqual(xvgToUnits(1.234567), 1_234_567);
  assert.strictEqual(xvgToUnits(0.000001), 1);
});

test('extractRedeemScript returns the last push, null when absent', () => {
  assert.strictEqual(extractRedeemScript(undefined), null);
  assert.strictEqual(extractRedeemScript({ hex: '' }), null);
  // scriptSig = push("aa") push("bbcc"): 01 aa 02 bbcc -> last push is bbcc
  const rs = extractRedeemScript({ hex: '01aa02bbcc' });
  assert.deepStrictEqual(rs, Buffer.from('bbcc', 'hex'));
});

test('prevoutRefs skips coinbase and deduplicates outpoints', () => {
  const block = {
    height: 1,
    tx: [
      { txid: 'cb', vin: [{ coinbase: '00' }], vout: [{ value: 50, n: 0 }] },
      { txid: 't1', vin: [{ txid: 'a', vout: 0 }, { txid: 'a', vout: 0 }], vout: [] },
    ],
  };
  const refs = prevoutRefs(block);
  assert.deepStrictEqual(refs, [{ txid: 'a', vout: 0, key: 'a:0' }]);
});

test('decodeTx skips coinbase inputs and converts output values', () => {
  const tx = { txid: 'cb', vin: [{ coinbase: 'abcd' }], vout: [{ value: 12.5, n: 0 }] };
  const decoded = decodeTx(tx, new Map());
  assert.strictEqual(decoded.ins.length, 0);
  assert.deepStrictEqual(decoded.outs, [{ value: 12_500_000, address: null }]);
});

test('decodeTx surfaces the output owner address from scriptPubKey', () => {
  const tx = {
    txid: 't', vin: [{ coinbase: 'ab' }],
    vout: [
      { value: 1, n: 0, scriptPubKey: { address: 'DLsrj97VqgURBjEx1cbAuXePDgU9rMGDmX' } },
      { value: 2, n: 1, scriptPubKey: { addresses: ['Dlegacy'] } },
      { value: 3, n: 2, scriptPubKey: {} },
    ],
  };
  const decoded = decodeTx(tx, new Map());
  assert.deepStrictEqual(decoded.outs.map((o) => o.address), ['DLsrj97VqgURBjEx1cbAuXePDgU9rMGDmX', 'Dlegacy', null]);
});

test('decodeBlock -> Indexer extracts an inscription from a real reveal tx', () => {
  // Build a genuine signed reveal, then describe it the way Verge RPC would.
  const body = Buffer.from('Hello, Verge!', 'utf8');
  const [rs] = buildInscriptionScripts({ pubkey, contentType: 'text/plain', body });
  const commitTxid = 'ab'.repeat(32);
  const commitValue = 100_000;
  const reveal = buildReveal({
    network,
    inputs: [{ txid: commitTxid, vout: 0, value: commitValue, redeemScript: rs }],
    outputs: [{ address: payout, value: commitValue - 2_000 }],
    signer,
  });

  const coinbase = { txid: 'cb'.repeat(32), vin: [{ coinbase: '01' }], vout: [{ value: 50, n: 0 }] };
  const block = { height: 100, tx: [coinbase, toVerboseTx(reveal.tx, reveal.txid, commitTxid)] };

  const prevValues = new Map([[`${commitTxid}:0`, commitValue]]);
  const decoded = decodeBlock(block, prevValues);

  const idx = new Indexer();
  idx.processBlock(decoded);
  const list = idx.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].number, 0);
  assert.strictEqual(list[0].contentType, 'text/plain');
  assert.strictEqual(list[0].id, `${reveal.txid}i0`);
  assert.strictEqual(list[0].location, `${reveal.txid}:0`);
});

console.log(`\n${passed} tests passed`);
