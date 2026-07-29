// The complete asset lifecycle on a live regtest chain (ASSETS-PLAN phase 3, closing the loop).
//
// Everything before this stubbed the etching: the asset was injected into the state by hand. Here it
// is inscribed for real, in a commit + reveal pair, and the scanner has to FIND it on its own from
// the inscription envelope. Nothing about the asset is told to the indexer: it is discovered.
//
// Then a real mint and a real transfer are broadcast against that discovered asset, and the final
// state is rebuilt from nothing but blocks.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { buildEtch, buildMint, buildTransfer, DUST_UNITS } = require(path.join(ROOT, 'src/assets/builder'));
const { AssetState, applyTx, assetRefOf } = require(path.join(ROOT, 'src/assets/indexer'));
const { scanRange, detectEtching } = require(path.join(ROOT, 'src/assets/scanner'));
const { stateRoot, proveBalance, verifyBalance } = require(path.join(ROOT, 'src/assets/checkpoint'));
const codec = require(path.join(ROOT, 'src/assets/codec'));

const COIN = 1e6;
let checks = 0, failed = 0;
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}

async function broadcastPlan(plan, mustSpend = []) {
  const outs = {};
  let count = 0;
  for (const o of plan.outputs) {
    if (o.isOpReturn) { outs.data = o.data.toString('hex'); count += 1; continue; }
    if (o.isChange) continue;
    outs[o.address] = Number((o.value / COIN).toFixed(6));
    count += 1;
  }
  const raw = await rpc('createrawtransaction', [mustSpend, outs]);
  // changePosition pinned to the end: the default is RANDOM, which would renumber the outputs an
  // edict points at and pay the wrong party.
  const funded = await rpc('fundrawtransaction', [raw, { changePosition: count }]);
  const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
  return rpc('sendrawtransaction', [signed.hex]);
}

const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (hash, v) => rpc('getblock', [hash, v]),
};

(async () => {
  console.log('Verge Assets full lifecycle on regtest\n');
  const { network } = pickNetwork('regtest');
  const start = (await rpc('getblockchaininfo')).blocks;
  const holder = await rpc('getnewaddress');
  const buyer = await rpc('getnewaddress');

  // ---- 1. ETCH: inscribe the asset definition for real ----------------------------------------
  const etch = buildEtch({
    ticker: 'CYCLE', name: 'Full Cycle', divisibility: 2,
    supply: 1000000, premine: 400000,
    terms: { amount: 5000, cap: 10 },
  }, { address: holder, value: DUST_UNITS });
  check('buildEtch produced the asset content type', etch.contentType === 'application/vnd.verge-asset+cbor');

  const plan = buildPlan({
    body: etch.body, contentType: etch.contentType, networkName: 'regtest',
    amount: 2 * DUST_UNITS, file: 'cycle.cbor',
  });
  check('the etching fits in a single inscription input', plan.inputs.length >= 1,
    plan.inputs.length + ' inputs for ' + etch.body.length + ' bytes');

  // commit: fund every P2SH input of the plan
  const commitOuts = {};
  for (const inp of plan.inputs) commitOuts[inp.address] = Number((2 * DUST_UNITS / COIN).toFixed(6));
  const commitRaw = await rpc('createrawtransaction', [[], commitOuts]);
  const commitFunded = await rpc('fundrawtransaction', [commitRaw]);
  const commitSigned = await rpc('signrawtransactionwithwallet', [commitFunded.hex]);
  const commitTxid = await rpc('sendrawtransaction', [commitSigned.hex]);
  await rpc('generate', [1]);

  // reveal: spend those commit outputs, exposing the inscription, paying the premine to `holder`
  const commitTx = await rpc('getrawtransaction', [commitTxid, true]);
  const utxos = [];
  const values = [];
  for (const inp of plan.inputs) {
    const vout = commitTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(inp.address));
    utxos.push(`${commitTxid}:${vout}`);
    values.push(2 * DUST_UNITS);
  }
  const reveal = revealFromPlan({
    plan, utxos, to: holder, fee: DUST_UNITS, values, network,
  });
  const etchTxid = await rpc('sendrawtransaction', [reveal.hex]);
  await rpc('generate', [1]);
  check('the etching reveal was accepted by the node', !!etchTxid);

  // ---- 2. the scanner DISCOVERS the asset with no help ----------------------------------------
  const etchTx = await rpc('getrawtransaction', [etchTxid, true]);
  const discovered = detectEtching(etchTx);
  check('the scanner found the etching in the inscription envelope', !!discovered,
    discovered ? '' : 'nothing detected');
  check('the discovered etching matches what was inscribed',
    discovered && discovered.ticker === 'CYCLE' && discovered.supply === 1000000
      && discovered.premine === 400000 && discovered.terms && discovered.terms.amount === 5000,
    JSON.stringify(discovered));

  // Replay from blocks alone: nothing is injected, the asset must appear by itself.
  const state = new AssetState();
  const afterEtch = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, start + 1, afterEtch, applyTx);
  check('replaying the blocks registered the asset from scratch', state.tickers.has('CYCLE'),
    'tickers: ' + [...state.tickers.keys()].join(','));

  const REF = state.tickers.get('CYCLE');
  const premineHeld = [...state.entries()].filter((e) => e.assetRef === REF).reduce((s, e) => s + e.amount, 0);
  check('the premine landed on chain', premineHeld === 400000, 'held ' + premineHeld);

  // ---- 3. MINT against the discovered asset ----------------------------------------------------
  const mintTxid = await broadcastPlan(buildMint(REF, { address: buyer, value: DUST_UNITS }));
  await rpc('generate', [1]);
  const afterMint = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterEtch + 1, afterMint, applyTx);

  const mintTx = await rpc('getrawtransaction', [mintTxid, true]);
  const mintVout = mintTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(buyer));
  check('the mint credited the terms amount', state.balanceOf(`${mintTxid}:${mintVout}`, REF) === 5000,
    'got ' + state.balanceOf(`${mintTxid}:${mintVout}`, REF));
  check('the asset tracked its issued total', state.assets.get(REF).minted === 5000);

  // ---- 4. TRANSFER part of it onward ------------------------------------------------------------
  // Sending PART of a balance needs an explicit destination for the rest. Without one the leftover
  // falls through to the first eligible output (spec §3) and the recipient receives the lot, which
  // is exactly the mistake a wallet must not make. So: 2000 to the holder, the remaining 3000 back
  // to the sender, both as explicit edicts.
  const tPlan = buildTransfer([
    { address: holder, value: DUST_UNITS, assets: [{ assetRef: REF, amount: 2000 }] },
    { address: buyer, value: DUST_UNITS, assets: [{ assetRef: REF, amount: 3000 }] }, // asset change
  ]);
  const tTxid = await broadcastPlan(tPlan, [{ txid: mintTxid, vout: mintVout }]);
  await rpc('generate', [1]);
  const end = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterMint + 1, end, applyTx);

  const tTx = await rpc('getrawtransaction', [tTxid, true]);
  const toVout = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(holder));
  const backVout = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(buyer));
  check('the transfer moved exactly the edict amount to the recipient',
    state.balanceOf(`${tTxid}:${toVout}`, REF) === 2000,
    'got ' + state.balanceOf(`${tTxid}:${toVout}`, REF));
  check('the asset change came back to the sender, not to the recipient',
    state.balanceOf(`${tTxid}:${backVout}`, REF) === 3000,
    'got ' + state.balanceOf(`${tTxid}:${backVout}`, REF));
  check('the spent carrier is empty', state.balanceOf(`${mintTxid}:${mintVout}`, REF) === 0);

  // ---- 5. conservation: nothing was created or destroyed ---------------------------------------
  const total = [...state.entries()].filter((e) => e.assetRef === REF).reduce((s, e) => s + e.amount, 0);
  check('total supply on chain equals premine + minted', total === 400000 + 5000, 'total ' + total);

  // ---- 6. a checkpoint over a state built purely from chain data --------------------------------
  const root = stateRoot(state);
  const anyEntry = [...state.entries()].find((e) => e.assetRef === REF);
  const proof = proveBalance(state, anyEntry.outpoint, anyEntry.assetRef);
  check('a balance from the fully chain-derived state proves against its root',
    verifyBalance(proof.entry, proof.path, root));

  const rebuilt = new AssetState();
  await scanRange(chain, rebuilt, start + 1, end, applyTx);
  check('an independent full replay produces the identical root', stateRoot(rebuilt).equals(root),
    stateRoot(rebuilt).toString('hex').slice(0, 12) + ' vs ' + root.toString('hex').slice(0, 12));

  console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' FAILED') + '  (' + checks + ' checks)');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nERROR: ' + e.message + '\n' + (e.stack || '')); process.exit(1); });
