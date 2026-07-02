// CLI helper tests: arg parsing, content-type, plan build + reveal round-trip. Offline.
// Run: node test/cli.test.js
const assert = require('assert');
const { parseArgs, inferContentType, buildPlan, revealFromPlan } = require('../src/cli');
const { parseInscriptionScript, buildInscriptionScripts } = require('../src/builder');
const { extractRedeemScript } = require('../src/rpc');
const bitcoin = require('bitcoinjs-lib');
const { ECPair, toBitcoinjsNetwork } = require('../src/builder');
const { Indexer } = require('../src/indexer');
const { parentIdToBuffer } = require('../src/envelope');
const { testnet } = require('../src/networks');

// Pull the revealed redeemScript (last push) out of a signed scriptSig buffer.
const redeemOf = (scriptSig) => extractRedeemScript({ hex: scriptSig.toString('hex') });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

test('parseArgs handles values, booleans, repeats, and positionals', () => {
  const { _, flags } = parseArgs(
    'mint reveal --plan p.json --broadcast --utxo a:0 --utxo b:1 --to vt1xyz'.split(' ')
  );
  assert.deepStrictEqual(_, ['mint', 'reveal']);
  assert.strictEqual(flags.plan, 'p.json');
  assert.strictEqual(flags.broadcast, true);
  assert.deepStrictEqual(flags.utxo, ['a:0', 'b:1']);
  assert.strictEqual(flags.to, 'vt1xyz');
});

test('inferContentType maps extensions and falls back to octet-stream', () => {
  assert.strictEqual(inferContentType('x.png'), 'image/png');
  assert.strictEqual(inferContentType('NOTE.TXT'), 'text/plain;charset=utf-8');
  assert.strictEqual(inferContentType('blob'), 'application/octet-stream');
});

test('buildPlan derives a testnet P2SH commit address and a usable wif', () => {
  const plan = buildPlan({
    body: Buffer.from('hi'),
    contentType: 'text/plain',
    networkName: 'testnet',
    amount: 1_000_000,
  });
  assert.strictEqual(plan.network, 'testnet');
  assert.strictEqual(plan.inputs.length, 1);
  assert.strictEqual(
    bitcoin.address.fromBase58Check(plan.inputs[0].address).version,
    testnet.scriptHash
  );
  assert.strictEqual(plan.inputs[0].amount, 1_000_000);
  // wif round-trips
  const net = toBitcoinjsNetwork(testnet);
  assert.doesNotThrow(() => ECPair.fromWIF(plan.wif, net));
});

test('buildPlan embeds tag-5 metadata on the first input, recoverable from the redeemScript', () => {
  const cbor = require('../src/cbor');
  const metadata = cbor.encode({ name: 'Verginals #7', attributes: [{ trait_type: 'House', value: 'Water' }] });
  const plan = buildPlan({
    body: Buffer.from('hi'),
    contentType: 'image/webp',
    networkName: 'testnet',
    amount: 1_000_000,
    metadata,
  });
  const parsed = parseInscriptionScript(Buffer.from(plan.inputs[0].redeemScript, 'hex'));
  assert.strictEqual(parsed.metadata.length, 1);
  assert.deepStrictEqual(parsed.metadata[0], metadata);
  assert.deepStrictEqual(cbor.decode(parsed.metadata[0]), {
    name: 'Verginals #7',
    attributes: [{ trait_type: 'House', value: 'Water' }],
  });
});

test('revealFromPlan signs a reveal whose scriptSig reveals the body', () => {
  const body = Buffer.from('Hello, Verge!', 'utf8');
  const plan = buildPlan({ body, contentType: 'text/plain', networkName: 'testnet', amount: 1_000_000 });
  const net = toBitcoinjsNetwork(testnet);
  const to = bitcoin.payments.p2pkh({ pubkey: ECPair.fromWIF(plan.wif, net).publicKey, network: net }).address;

  const { tx, txid, outputValue } = revealFromPlan({
    plan,
    utxos: ['ab'.repeat(32) + ':0'],
    to,
    fee: 100_000,
  });
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.strictEqual(outputValue, 900_000);
  const parsed = parseInscriptionScript(redeemOf(tx.vin[0].script));
  assert.strictEqual(parsed.body.toString('utf8'), 'Hello, Verge!');
  assert.strictEqual(parsed.contentType.toString('utf8'), 'text/plain');
});

test('revealFromPlan: resolved values override the plan amount', () => {
  const plan = buildPlan({ body: Buffer.from('x'), contentType: 'text/plain', networkName: 'testnet', amount: 1_000_000 });
  const net = toBitcoinjsNetwork(testnet);
  const to = bitcoin.payments.p2pkh({ pubkey: ECPair.fromWIF(plan.wif, net).publicKey, network: net }).address;

  // Real UTXO was funded with 2 XVG, not the 1 XVG estimate in the plan.
  const { outputValue } = revealFromPlan({
    plan,
    utxos: ['ab'.repeat(32) + ':0'],
    to,
    fee: 100_000,
    values: [2_000_000],
  });
  assert.strictEqual(outputValue, 1_900_000);
});

test('parented reveal: builder spends the parent carrier; indexer verifies tag-3 membership', () => {
  const net = toBitcoinjsNetwork(testnet);
  // Operator's parent-holding key (distinct from every reveal wif).
  const opKey = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network: net });
  const opAddr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(opKey.publicKey), network: net }).address;

  // 1) Collection root: index a synthetic reveal so the parent has a real carrier UTXO.
  const parentTxid = 'a0'.repeat(32);
  const parentId = parentTxid + 'i0';
  const parentCarrier = 500_000;
  const ix = new Indexer();
  const [rootScript] = buildInscriptionScripts({
    pubkey: Buffer.from(opKey.publicKey), contentType: 'application/json', body: Buffer.from('root'),
  });
  ix.processBlock({
    height: 1,
    txs: [{ txid: parentTxid, ins: [{ txid: 'c0'.repeat(32), vout: 0, value: 600_000, inscriptionScript: rootScript }], outs: [{ value: parentCarrier, address: opAddr }] }],
  });
  assert.strictEqual(ix.inscriptions.get(parentId).location, parentTxid + ':0');

  // 2) Child mint: plan carries tag-3 parent; reveal appends the parent carrier as the last input.
  const childPlan = buildPlan({
    body: Buffer.from('child-img'), contentType: 'image/webp', networkName: 'testnet',
    amount: 300_000, parent: parentIdToBuffer(parentId),
  });
  const minter = bitcoin.payments.p2pkh({ pubkey: ECPair.fromWIF(childPlan.wif, net).publicKey, network: net }).address;
  const { tx, txid: childTxid, outputValue, parentOut } = revealFromPlan({
    plan: childPlan,
    utxos: ['bb'.repeat(32) + ':0'],
    to: minter,
    fee: 100_000,
    values: [300_000],
    parent: { txid: parentTxid, vout: 0, value: parentCarrier, wif: opKey.toWIF(), address: opAddr },
  });
  assert.strictEqual(outputValue, 200_000, 'child carrier = commit(300k) - fee(100k)');
  assert.deepStrictEqual(parentOut, { txid: childTxid, vout: 1, value: parentCarrier });
  assert.strictEqual(tx.vin.length, 2, 'commit input + parent carrier input');
  assert.strictEqual(tx.vout.length, 2, 'child carrier + parent carry-forward');

  // 3) Decode the freshly-built reveal into the indexer's shape and index it.
  const ins = tx.vin.map((vin) => ({
    txid: vin.txid,
    vout: vin.vout,
    value: vin.txid === parentTxid ? parentCarrier : 300_000,
    inscriptionScript: extractRedeemScript({ hex: vin.script.toString('hex') }),
  }));
  ix.processBlock({
    height: 2,
    txs: [{ txid: childTxid, ins, outs: [{ value: 200_000, address: minter }, { value: parentCarrier, address: opAddr }] }],
  });

  const child = ix.inscriptions.get(childTxid + 'i0');
  assert.strictEqual(child.location, childTxid + ':0', 'child binds to output 0');
  assert.strictEqual(child.parent, parentId, 'parent verified: reveal spent the parent carrier');
  const parent = ix.inscriptions.get(parentId);
  assert.strictEqual(parent.location, childTxid + ':1', 'parent carried forward to output 1');
  assert.deepStrictEqual(parent.children, [childTxid + 'i0']);
});

test('revealFromPlan rejects a parent carrier that would not survive the fee', () => {
  const plan = buildPlan({ body: Buffer.from('x'), contentType: 'image/webp', networkName: 'testnet', amount: 300_000 });
  const net = toBitcoinjsNetwork(testnet);
  const opKey = ECPair.fromPrivateKey(Buffer.alloc(32, 9), { network: net });
  const opAddr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(opKey.publicKey), network: net }).address;
  assert.throws(
    () => revealFromPlan({
      plan, utxos: ['ab'.repeat(32) + ':0'], to: opAddr, fee: 100_000, values: [300_000],
      parent: { txid: 'a0'.repeat(32), vout: 0, value: 90_000, wif: opKey.toWIF(), address: opAddr },
    }),
    /parent carrier .* must exceed reveal fee/
  );
});

test('revealFromPlan rejects a fee that exceeds funding', () => {
  const plan = buildPlan({ body: Buffer.from('x'), contentType: 'text/plain', networkName: 'testnet', amount: 50_000 });
  assert.throws(
    () => revealFromPlan({ plan, utxos: ['ab'.repeat(32) + ':0'], to: 'vt1qd', fee: 60_000 }),
    /fee .* total funded/
  );
});

console.log(`\n${passed} tests passed`);
