// A self-contained demonstration of the Verge Assets protocol, for someone who has two minutes.
//
//   node test/e2e/assets-demo.js
//
// It starts its own regtest node in a temporary directory, mines a few blocks, then creates a token
// on Verge, mints it, sends it, and proves a balance against a merkle root. Nothing is faked and
// nothing is mocked: every step is a real transaction on a real Verge chain. It cleans up after
// itself and never touches an existing wallet or datadir.
//
// Set VERGE_BIN if the binary is somewhere unusual:
//   VERGE_BIN=/usr/local/bin/verged node test/e2e/assets-demo.js
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { buildEtch, buildMint, buildTransfer, DUST_UNITS } = require(path.join(ROOT, 'src/assets/builder'));
const { AssetState, applyTx } = require(path.join(ROOT, 'src/assets/indexer'));
const { index: verifyIndex } = require(path.join(ROOT, 'src/assets/verify'));
const { scanRange, detectEtching } = require(path.join(ROOT, 'src/assets/scanner'));
const { stateRoot, proveBalance, verifyBalance } = require(path.join(ROOT, 'src/assets/checkpoint'));
const { priceOf } = require(path.join(ROOT, 'src/assets/tickers'));

const COIN = 1e6;
const PORT = 18449; // deliberately not a default, so it cannot collide with a real node
const USER = 'demo';
const PASS = 'demo' + Math.random().toString(36).slice(2, 10);

const CANDIDATES = [
  process.env.VERGE_BIN,
  '/Applications/Verge-Qt.app/Contents/MacOS/verge-qt',
  '/usr/local/bin/verged',
  '/usr/bin/verged',
].filter(Boolean);

const say = (s = '') => console.log(s);
const step = (n, s) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${s}`);
const ok = (s) => console.log(`      \x1b[32m✓\x1b[0m ${s}`);

function findBinary() {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  try { return execSync('command -v verged', { encoding: 'utf8' }).trim(); } catch { /* not on PATH */ }
  throw new Error('no Verge binary found. Set VERGE_BIN=/path/to/verged and run again.');
}

function rpc(method, params = []) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: 'demo', method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/', timeout: 120000,
      headers: {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(body),
        authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64'),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(method + ': ' + (j.error.message || JSON.stringify(j.error))));
          resolve(j.result);
        } catch { reject(new Error(method + ': ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(method + ' timed out')); });
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRpc(seconds = 60) {
  for (let i = 0; i < seconds; i++) {
    try { await rpc('getblockchaininfo'); return; } catch { await sleep(1000); }
  }
  throw new Error('the regtest node did not answer in time');
}

async function broadcast(plan, mustSpend = []) {
  const outs = {};
  let count = 0;
  for (const o of plan.outputs) {
    if (o.isOpReturn) { outs.data = o.data.toString('hex'); count += 1; continue; }
    if (o.isChange) continue;
    outs[o.address] = Number((o.value / COIN).toFixed(6));
    count += 1;
  }
  const raw = await rpc('createrawtransaction', [mustSpend, outs]);
  // changePosition pinned to the end: the wallet default is random, which would renumber the outputs
  // an edict points at.
  const funded = await rpc('fundrawtransaction', [raw, { changePosition: count }]);
  const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
  return rpc('sendrawtransaction', [signed.hex]);
}

const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (hash, v) => rpc('getblock', [hash, v]),
};

let node = null;
let dir = null;

async function main() {
  const bin = findBinary();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verge-assets-demo-'));
  fs.writeFileSync(path.join(dir, 'VERGE.conf'),
    `regtest=1\nserver=1\nlisten=0\ntxindex=1\ndatacarrier=1\ndatacarriersize=83\n\n`
    + `[regtest]\nrpcuser=${USER}\nrpcpassword=${PASS}\nrpcport=${PORT}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\n`);

  say('\x1b[1mVerge Assets: a live demonstration\x1b[0m');
  say('A fungible token protocol running on Verge. Everything below is a real transaction');
  say('on a throwaway regtest chain created for this run.');
  say(`\nbinary   ${bin}`);
  say(`datadir  ${dir}  (deleted when this finishes)`);

  step(1, 'Starting a private regtest chain');
  node = spawn(bin, [`-datadir=${dir}`, '-regtest', '-server=1', '-listen=0'], { stdio: 'ignore' });
  await waitForRpc();
  ok('node up, isolated from any real wallet');

  const addr = await rpc('getnewaddress');
  let mined = 0;
  const t0 = Date.now();
  while (mined < 130) { const n = Math.min(20, 130 - mined); await rpc('generate', [n]); mined += n; }
  ok(`130 blocks mined in ${((Date.now() - t0) / 1000).toFixed(1)}s, balance ${await rpc('getbalance')} XVG`);

  const start = (await rpc('getblockchaininfo')).blocks;
  const alice = await rpc('getnewaddress');
  const bob = await rpc('getnewaddress');

  // --- 2. create a token -----------------------------------------------------------------------
  step(2, 'Creating a token called DEMO');
  const etch = buildEtch({
    ticker: 'DEMO', name: 'Demonstration', divisibility: 2,
    supply: 1000000, premine: 400000, terms: { amount: 5000, cap: 20 },
  }, { address: alice, value: DUST_UNITS });
  say(`      supply 10,000.00   premine 4,000.00   open mint 50.00 per mint, 20 mints`);
  say(`      the definition is ${etch.body.length} bytes of CBOR, carried in an inscription`);

  const { network } = pickNetwork('regtest');
  const plan = buildPlan({
    body: etch.body, contentType: etch.contentType, networkName: 'regtest',
    amount: 2 * DUST_UNITS, file: 'demo.cbor',
  });
  const commitOuts = {};
  for (const inp of plan.inputs) commitOuts[inp.address] = Number((2 * DUST_UNITS / COIN).toFixed(6));
  const cRaw = await rpc('createrawtransaction', [[], commitOuts]);
  const cFunded = await rpc('fundrawtransaction', [cRaw]);
  const cSigned = await rpc('signrawtransactionwithwallet', [cFunded.hex]);
  const commitTxid = await rpc('sendrawtransaction', [cSigned.hex]);
  await rpc('generate', [1]);

  const commitTx = await rpc('getrawtransaction', [commitTxid, true]);
  const utxos = [];
  const values = [];
  for (const inp of plan.inputs) {
    const v = commitTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(inp.address));
    utxos.push(`${commitTxid}:${v}`);
    values.push(2 * DUST_UNITS);
  }
  const reveal = revealFromPlan({ plan, utxos, to: alice, fee: DUST_UNITS, values, network });
  const etchTxid = await rpc('sendrawtransaction', [reveal.hex]);
  await rpc('generate', [1]);
  ok(`etched on chain in ${etchTxid.slice(0, 16)}...`);
  say(`      a 4-character ticker costs ${(priceOf('DEMO') / COIN).toLocaleString()} XVG on mainnet, to price out squatters`);

  // --- 3. an indexer discovers it unaided -------------------------------------------------------
  step(3, 'An indexer finds the token by itself, from blocks alone');
  const found = detectEtching(await rpc('getrawtransaction', [etchTxid, true]));
  ok(`discovered: ${found.ticker}, supply ${found.supply}, premine ${found.premine}, mint ${found.terms.amount} per claim`);

  const state = new AssetState();
  const afterEtch = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, start + 1, afterEtch, applyTx);
  const REF = state.tickers.get('DEMO');
  ok(`registered from a replay of the chain, nothing was told to the indexer`);

  // --- 4. mint ----------------------------------------------------------------------------------
  step(4, 'Bob claims from the open mint');
  const mintTxid = await broadcast(buildMint(REF, { address: bob, value: DUST_UNITS }));
  await rpc('generate', [1]);
  const afterMint = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterEtch + 1, afterMint, applyTx);
  const mintTx = await rpc('getrawtransaction', [mintTxid, true]);
  const bobVout = mintTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(bob));
  ok(`Bob holds ${(state.balanceOf(`${mintTxid}:${bobVout}`, REF) / 100).toFixed(2)} DEMO`);
  say('      one transaction, 83 bytes of OP_RETURN, no inscription needed to move value');

  // --- 5. transfer ------------------------------------------------------------------------------
  step(5, 'Bob sends 20.00 to Alice and keeps the rest');
  const tPlan = buildTransfer([
    { address: alice, value: DUST_UNITS, assets: [{ assetRef: REF, amount: 2000 }] },
    { address: bob, value: DUST_UNITS, assets: [{ assetRef: REF, amount: 3000 }] },
  ]);
  const tTxid = await broadcast(tPlan, [{ txid: mintTxid, vout: bobVout }]);
  await rpc('generate', [1]);
  const end = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterMint + 1, end, applyTx);
  const tTx = await rpc('getrawtransaction', [tTxid, true]);
  const aliceVout = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(alice));
  const bobBack = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(bob));
  ok(`Alice ${(state.balanceOf(`${tTxid}:${aliceVout}`, REF) / 100).toFixed(2)} DEMO, `
    + `Bob ${(state.balanceOf(`${tTxid}:${bobBack}`, REF) / 100).toFixed(2)} DEMO`);
  say('      balances live on outputs, like the coin itself, so ordinary utxo handling applies');

  // --- 6. the part nothing on Bitcoin has ------------------------------------------------------
  step(6, 'A wallet proves its balance without trusting any indexer');
  const root = stateRoot(state);
  say(`      the indexer commits to its ENTIRE balance set as one root:`);
  say(`      ${root.toString('hex')}`);
  const entry = [...state.entries()].find((e) => e.outpoint === `${tTxid}:${aliceVout}`);
  const proof = proveBalance(state, entry.outpoint, entry.assetRef);
  ok(`Alice verifies her balance with a ${proof.path.length}-node proof: `
    + `${verifyBalance(proof.entry, proof.path, root) ? 'valid' : 'FAILED'}`);
  const lie = Object.assign({}, proof.entry, { amount: proof.entry.amount * 10 });
  ok(`the same proof with an inflated amount: ${verifyBalance(lie, proof.path, root) ? 'ACCEPTED' : 'rejected'}`);
  say('      so a light wallet needs no indexer of its own, and cannot be lied to by one');

  // --- 7. two independent implementations agree -------------------------------------------------
  step(7, 'Two independently written indexers agree on the state');
  const rebuilt = new AssetState();
  await scanRange(chain, rebuilt, start + 1, end, applyTx);
  const txsForVerify = [];
  for (let h = start + 1; h <= end; h++) {
    const b = await chain.getBlock(await chain.getBlockHash(h), 2);
    b.tx.forEach((tx, i) => {
      const { toIndexerTx } = require(path.join(ROOT, 'src/assets/scanner'));
      txsForVerify.push(toIndexerTx(tx, h, i));
    });
  }
  const second = verifyIndex(txsForVerify);
  const rootA = stateRoot(rebuilt).toString('hex');
  const { buildTree } = require(path.join(ROOT, 'src/assets/checkpoint'));
  const rootB = buildTree([...second.entries()]).root.toString('hex');
  ok(`implementation A: ${rootA.slice(0, 24)}...`);
  ok(`implementation B: ${rootB.slice(0, 24)}...`);
  ok(rootA === rootB ? 'identical, so a divergence would be publicly detectable' : 'DIVERGED');

  say('\n\x1b[1mWhat this means for Verge\x1b[0m');
  say('  - a token standard native to Verge, with 30-second settlement rather than an hour');
  say('  - one protocol for fungible tokens and for inscriptions, so one indexer and one wallet');
  say('  - balances a light client can verify, which no metaprotocol on Bitcoin offers');
  say('  - designed around what Verge actually has: no SegWit, no CSV, CLTV active, 83-byte OP_RETURN');
  say('\n  The specification is spec/ASSETS-SPEC-v0.md. Criticism is more useful than agreement.');
}

function cleanup() {
  if (node) { try { node.kill(); } catch { /* already gone */ } }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
}

main()
  .then(() => { cleanup(); say(''); process.exit(0); })
  .catch((e) => { console.error(`\n\x1b[31mfailed:\x1b[0m ${e.message}`); cleanup(); process.exit(1); });
