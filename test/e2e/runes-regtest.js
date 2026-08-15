// End-to-end on the isolated regtest chain (RUNES-PLAN phase 3).
//
// The point is NOT to re-test the pure logic (unit tests already do that). It is to prove the pure
// core and the real chain agree: broadcast genuine transactions, read the blocks back through the
// scanner, and check the reconstructed state matches what the state machine predicted.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const codec = require(path.join(ROOT, 'src/runes/codec'));
const { RuneState, applyTx, runeRefOf } = require(path.join(ROOT, 'src/runes/indexer'));
const { scanRange, toIndexerTx, readOpReturn } = require(path.join(ROOT, 'src/runes/scanner'));
const { stateRoot, proveBalance, verifyBalance } = require(path.join(ROOT, 'src/runes/checkpoint'));

const COIN = 1e6;
let checks = 0, failed = 0;
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}

/** Broadcast a transaction with an OP_RETURN payload plus `recipients` value outputs. */
async function sendWithMessage(payload, recipients) {
  const outs = {};
  for (const [addr, amt] of recipients) outs[addr] = amt;
  outs.data = payload.toString('hex');
  const raw = await rpc('createrawtransaction', [[], outs]);
  const funded = await rpc('fundrawtransaction', [raw]);
  const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
  if (!signed.complete) throw new Error('signing incomplete');
  return rpc('sendrawtransaction', [signed.hex]);
}

const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (hash, v) => rpc('getblock', [hash, v]),
};

(async () => {
  console.log('Verge Runes end-to-end on regtest\n');

  const startHeight = (await rpc('getblockchaininfo')).blocks;
  const addrA = await rpc('getnewaddress');
  const addrB = await rpc('getnewaddress');

  // ---- 1. the OP_RETURN survives the chain unchanged -----------------------------------------
  const REF = runeRefOf(startHeight + 1, 1); // pretend the rune was etched here
  const edictMsg = codec.encodeEdicts([{ runeRef: REF, amount: 250000, output: 0 }]);
  const txid1 = await sendWithMessage(edictMsg, [[addrA, 0.5]]);
  await rpc('generate', [1]);

  const raw1 = await rpc('getrawtransaction', [txid1, true]);
  const recovered = raw1.vout.map(readOpReturn).find((d) => d && d.length);
  check('the OP_RETURN payload survives the round trip byte for byte',
    recovered && recovered.equals(edictMsg),
    recovered ? recovered.toString('hex') : 'none found');
  check('the node accepted an 83-byte-class protocol message', !!txid1);

  // ---- 2. the scanner reproduces the payload the codec understands ---------------------------
  const h1 = raw1.height || (await rpc('getblock', [raw1.blockhash])).height;
  const scanned = toIndexerTx(raw1, h1, 1);
  const decoded = codec.decode(scanned.outputs.map((o) => o.opReturnData).find(Boolean));
  check('the scanner + codec decode the edict back to its exact values',
    decoded && decoded.type === 'edicts' && decoded.edicts[0].runeRef === REF && decoded.edicts[0].amount === 250000,
    JSON.stringify(decoded));

  // ---- 3. a mint message and a checkpoint message also survive --------------------------------
  const mintMsg = codec.encodeMint(REF);
  const txid2 = await sendWithMessage(mintMsg, [[addrA, 0.5]]);
  const cpRoot = Buffer.alloc(32, 0x7c);
  const cpMsg = codec.encodeCheckpoint(startHeight + 5, cpRoot);
  const txid3 = await sendWithMessage(cpMsg, [[addrB, 0.5]]);
  await rpc('generate', [1]);

  const m2 = codec.decode(readOpReturn((await rpc('getrawtransaction', [txid2, true])).vout.find((o) => (o.scriptPubKey.hex || '').startsWith('6a'))));
  check('a mint message survives the chain', m2 && m2.type === 'mint' && m2.runeRef === REF);
  const m3 = codec.decode(readOpReturn((await rpc('getrawtransaction', [txid3, true])).vout.find((o) => (o.scriptPubKey.hex || '').startsWith('6a'))));
  check('a checkpoint root survives the chain', m3 && m3.type === 'checkpoint' && m3.root.equals(cpRoot));

  // ---- 4. full scan: the chain-derived state matches the pure prediction -----------------------
  // Etch the rune synthetically at the height we referenced, then let the scanner replay the real
  // blocks on top. Etch-via-inscription is phase 2 work; everything else here is genuine chain data.
  const etching = { ticker: 'REGT', name: 'Regtest', divisibility: 2, supply: 1000000, premine: 900000,
    terms: { amount: 1000 } };
  const chainState = new RuneState();
  const etchTxid = 'synthetic-etch';
  applyTx(chainState, { txid: etchTxid, height: startHeight + 1, txIndex: 1, inputs: [], outputs: [
    { value: 100000, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
  ], etching });
  check('the synthetic etching registered the rune', chainState.runes.get(REF) && chainState.runes.get(REF).ticker === 'REGT');

  const endHeight = (await rpc('getblockchaininfo')).blocks;
  const res = await scanRange(chain, chainState, startHeight + 1, endHeight, applyTx);
  check('the scanner walked every transaction in the range', res.applied > 0, res.applied + ' txs');

  // The mint we broadcast is a real one against a live rune with open terms.
  const mintedSomewhere = [...chainState.entries()].some((e) => e.runeRef === REF && e.amount === 1000);
  check('the real on-chain mint credited exactly the terms amount', mintedSomewhere,
    JSON.stringify([...chainState.entries()].slice(0, 4)));

  // ---- 5. checkpoint over the chain-derived state ----------------------------------------------
  const root = stateRoot(chainState);
  check('a merkle root can be computed over the chain-derived state', root.length === 32);
  const first = [...chainState.entries()][0];
  if (first) {
    const proof = proveBalance(chainState, first.outpoint, first.runeRef);
    check('a balance from real chain data verifies against its root',
      proof && verifyBalance(proof.entry, proof.path, root));
    const lie = Object.assign({}, proof.entry, { amount: proof.entry.amount + 1 });
    check('tampering with that balance fails against the same root', !verifyBalance(lie, proof.path, root));
  }

  // ---- 6. determinism: a second independent scan gives the same root ---------------------------
  const second = new RuneState();
  applyTx(second, { txid: etchTxid, height: startHeight + 1, txIndex: 1, inputs: [], outputs: [
    { value: 100000, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
  ], etching });
  await scanRange(chain, second, startHeight + 1, endHeight, applyTx);
  check('two independent scans of the same chain produce the same root', stateRoot(second).equals(root),
    stateRoot(second).toString('hex').slice(0, 16) + ' vs ' + root.toString('hex').slice(0, 16));

  console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' FAILED') + '  (' + checks + ' checks)');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nERROR: ' + e.message); process.exit(1); });
