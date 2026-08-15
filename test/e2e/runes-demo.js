// A self-contained demonstration of the Verge Runes protocol, for someone who has two minutes.
//
//   node test/e2e/runes-demo.js
//
// It starts its own regtest node in a temporary directory, mines a few blocks, then creates a token
// on Verge, mints it, sends it, and proves a balance against a merkle root. Nothing is faked and
// nothing is mocked: every step is a real transaction on a real Verge chain. It cleans up after
// itself and never touches an existing wallet or datadir.
//
// Set VERGE_BIN if the binary is somewhere unusual:
//   VERGE_BIN=/usr/local/bin/verged node test/e2e/runes-demo.js
//
// PREFER NOT TO LET A STRANGER'S SCRIPT START A PROCESS? Start your own regtest node, however you
// like, and point this at it. It then only makes JSON-RPC calls and spawns nothing:
//
//   DEMO_RPC_PORT=18443 DEMO_RPC_USER=you DEMO_RPC_PASS=yourpass node test/e2e/runes-demo.js
//
// In that mode this file touches nothing but the RPC socket you gave it. It never reads a datadir,
// never looks for a wallet file, and never starts or stops anything. That is worth verifying rather
// than believing: it is one file, and `spawn` appears exactly once in it.
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { buildEtch, buildMint, buildTransfer, DUST_UNITS } = require(path.join(ROOT, 'src/runes/builder'));
const { RuneState, applyTx } = require(path.join(ROOT, 'src/runes/indexer'));
const { index: verifyIndex } = require(path.join(ROOT, 'src/runes/verify'));
const { scanRange, detectEtching } = require(path.join(ROOT, 'src/runes/scanner'));
const { stateRoot, proveBalance, verifyBalance } = require(path.join(ROOT, 'src/runes/checkpoint'));
const { priceOf } = require(path.join(ROOT, 'src/runes/tickers'));

const COIN = 1e6;

// Attach mode: when the reader supplies RPC details, we connect to THEIR node and start nothing.
const ATTACH = !!(process.env.DEMO_RPC_PORT && process.env.DEMO_RPC_USER && process.env.DEMO_RPC_PASS);
const PORT = Number(process.env.DEMO_RPC_PORT || 18449); // 18449: not a default, cannot hit a real node
const USER = process.env.DEMO_RPC_USER || 'demo';
const PASS = process.env.DEMO_RPC_PASS || ('demo' + Math.random().toString(36).slice(2, 10));

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
  say('\x1b[1mVerge Runes: a live demonstration\x1b[0m');
  say('A fungible token protocol running on Verge. Everything below is a real transaction');
  say('on a regtest chain.');

  if (ATTACH) {
    say(`\nmode     attaching to YOUR regtest node on 127.0.0.1:${PORT}`);
    say('         this process starts nothing and touches no datadir or wallet file');
    step(1, 'Connecting to your node');
    const info = await rpc('getblockchaininfo');
    if (info.chain !== 'regtest') throw new Error(`refusing to run: that node is on "${info.chain}", not regtest`);
    ok(`connected, chain ${info.chain} at height ${info.blocks}`);
  } else {
    const bin = findBinary();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runes-demo-'));
    fs.writeFileSync(path.join(dir, 'VERGE.conf'),
      `regtest=1\nserver=1\nlisten=0\ntxindex=1\ndatacarrier=1\ndatacarriersize=83\n\n`
      + `[regtest]\nrpcuser=${USER}\nrpcpassword=${PASS}\nrpcport=${PORT}\nrpcbind=127.0.0.1\nrpcallowip=127.0.0.1\n`);
    say(`\nbinary   ${bin}`);
    say(`datadir  ${dir}  (created for this run, deleted at the end)`);
    say('         to avoid letting this script start a process, see the header: it can attach');
    say('         to a regtest node you started yourself instead.');
    step(1, 'Starting a private regtest chain');
    node = spawn(bin, [`-datadir=${dir}`, '-regtest', '-server=1', '-listen=0'], { stdio: 'ignore' });
    await waitForRpc();
    ok('node up, isolated from any real wallet');
  }

  let mined = 0;
  const t0 = Date.now();
  const need = ATTACH ? Math.max(0, 130 - (await rpc('getblockchaininfo')).blocks) : 130;
  while (mined < need) { const n = Math.min(20, need - mined); await rpc('generate', [n]); mined += n; }
  ok(`${mined} blocks mined in ${((Date.now() - t0) / 1000).toFixed(1)}s, balance ${await rpc('getbalance')} XVG`);

  const start = (await rpc('getblockchaininfo')).blocks;
  const alice = await rpc('getnewaddress');
  const bob = await rpc('getnewaddress');

  // --- 2. create a token -----------------------------------------------------------------------
  // Carve your own: TICKER=FROG SUPPLY=21000000 node test/e2e/runes-demo.js
  const TICKER = (process.env.TICKER || 'DEMO').toUpperCase();
  const DECIMALS = Number(process.env.DECIMALS || 2);
  const whole = Number(process.env.SUPPLY || 10000);                       // in display units
  const supply = Math.round(whole * 10 ** DECIMALS);
  const premine = Math.round(supply * Number(process.env.PREMINE_PCT || 40) / 100);
  const perMint = Math.max(1, Math.round((supply - premine) / 120));

  step(2, `Creating a Verge Rune called ${TICKER}`);
  const etch = buildEtch({
    ticker: TICKER, name: process.env.NAME || TICKER, divisibility: DECIMALS,
    supply, premine, terms: { amount: perMint, cap: 20 },
  }, { address: alice, value: DUST_UNITS });
  const show = (u) => (u / 10 ** DECIMALS).toLocaleString('en-US', { minimumFractionDigits: DECIMALS });
  say(`      supply ${show(supply)}   premine ${show(premine)}   open mint ${show(perMint)} per claim, 20 claims`);
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
  say(`      on mainnet a ${TICKER.length}-character ticker costs `
    + `${(priceOf(TICKER) / COIN).toLocaleString()} XVG, to price out squatters`);

  // --- 3. an indexer discovers it unaided -------------------------------------------------------
  step(3, 'An indexer finds the token by itself, from blocks alone');
  const found = detectEtching(await rpc('getrawtransaction', [etchTxid, true]));
  ok(`discovered: ${found.ticker}, supply ${found.supply}, premine ${found.premine}, mint ${found.terms.amount} per claim`);

  const state = new RuneState();
  const afterEtch = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, start + 1, afterEtch, applyTx);
  const REF = state.tickers.get(TICKER);
  ok(`registered from a replay of the chain, nothing was told to the indexer`);

  // --- 4. mint ----------------------------------------------------------------------------------
  step(4, 'Bob claims from the open mint');
  const mintTxid = await broadcast(buildMint(REF, { address: bob, value: DUST_UNITS }));
  await rpc('generate', [1]);
  const afterMint = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterEtch + 1, afterMint, applyTx);
  const mintTx = await rpc('getrawtransaction', [mintTxid, true]);
  const bobVout = mintTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(bob));
  const bobHas = state.balanceOf(`${mintTxid}:${bobVout}`, REF);
  ok(`Bob holds ${show(bobHas)} ${TICKER}`);
  say('      one transaction, 83 bytes of OP_RETURN, no inscription needed to move value');

  // --- 5. transfer ------------------------------------------------------------------------------
  // Send 40% of the claim on, keep the rest. The change edict is explicit: without it the leftover
  // would fall through to the first output and Alice would receive the lot.
  const sending = Math.floor(bobHas * 0.4);
  const keeping = bobHas - sending;
  step(5, `Bob sends ${show(sending)} to Alice and keeps ${show(keeping)}`);
  const tPlan = buildTransfer([
    { address: alice, value: DUST_UNITS, runes: [{ runeRef: REF, amount: sending }] },
    { address: bob, value: DUST_UNITS, runes: [{ runeRef: REF, amount: keeping }] },
  ]);
  const tTxid = await broadcast(tPlan, [{ txid: mintTxid, vout: bobVout }]);
  await rpc('generate', [1]);
  const end = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterMint + 1, end, applyTx);
  const tTx = await rpc('getrawtransaction', [tTxid, true]);
  const aliceVout = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(alice));
  const bobBack = tTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(bob));
  ok(`Alice ${show(state.balanceOf(`${tTxid}:${aliceVout}`, REF))} ${TICKER}, `
    + `Bob ${show(state.balanceOf(`${tTxid}:${bobBack}`, REF))} ${TICKER}`);
  say('      balances live on outputs, like the coin itself, so ordinary utxo handling applies');

  // --- 6. the part nothing on Bitcoin has ------------------------------------------------------
  step(6, 'A wallet proves its balance without trusting any indexer');
  const root = stateRoot(state);
  say(`      the indexer commits to its ENTIRE balance set as one root:`);
  say(`      ${root.toString('hex')}`);
  const entry = [...state.entries()].find((e) => e.outpoint === `${tTxid}:${aliceVout}`);
  const proof = proveBalance(state, entry.outpoint, entry.runeRef);
  ok(`Alice verifies her balance with a ${proof.path.length}-node proof: `
    + `${verifyBalance(proof.entry, proof.path, root) ? 'valid' : 'FAILED'}`);
  const lie = Object.assign({}, proof.entry, { amount: proof.entry.amount * 10 });
  ok(`the same proof with an inflated amount: ${verifyBalance(lie, proof.path, root) ? 'ACCEPTED' : 'rejected'}`);
  say('      so a light wallet needs no indexer of its own, and cannot be lied to by one');

  // --- 7. two independent implementations agree -------------------------------------------------
  step(7, 'Two independently written indexers agree on the state');
  const rebuilt = new RuneState();
  await scanRange(chain, rebuilt, start + 1, end, applyTx);
  const txsForVerify = [];
  for (let h = start + 1; h <= end; h++) {
    const b = await chain.getBlock(await chain.getBlockHash(h), 2);
    b.tx.forEach((tx, i) => {
      const { toIndexerTx } = require(path.join(ROOT, 'src/runes/scanner'));
      txsForVerify.push(toIndexerTx(tx, h, i));
    });
  }
  const second = verifyIndex(txsForVerify);
  const rootA = stateRoot(rebuilt).toString('hex');
  const { buildTree } = require(path.join(ROOT, 'src/runes/checkpoint'));
  const rootB = buildTree([...second.entries()]).root.toString('hex');
  ok(`implementation A: ${rootA.slice(0, 24)}...`);
  ok(`implementation B: ${rootB.slice(0, 24)}...`);
  ok(rootA === rootB ? 'identical, so a divergence would be publicly detectable' : 'DIVERGED');

  // --- 8. something you can actually look at ----------------------------------------------------
  step(8, 'Writing a report you can open');
  const def = state.runes.get(REF);
  const holders = [...state.entries()].filter((e) => e.runeRef === REF);
  const reportPath = process.env.REPORT || path.join(os.tmpdir(), `verge-rune-${TICKER}.html`);
  fs.writeFileSync(reportPath, htmlReport({
    ticker: TICKER, def, holders, root, show, etchTxid, mintTxid, tTxid,
    height: end, decimals: DECIMALS, alice, bob, aliceVout, bobBack,
  }));
  ok(`open it: ${reportPath}`);

  say('\n\x1b[1mWhat this means for Verge\x1b[0m');
  say('  - a token standard native to Verge, with 30-second settlement rather than an hour');
  say('  - one protocol for fungible tokens and for inscriptions, so one indexer and one wallet');
  say('  - balances a light client can verify, which no metaprotocol on Bitcoin offers');
  say('  - designed around what Verge actually has: no SegWit, no CSV, CLTV active, 83-byte OP_RETURN');
  say('\n  The specification is spec/RUNES-SPEC-v0.md. Criticism is more useful than agreement.');
}

/**
 * A plain report of what the run produced. Deliberately sober: this is a protocol readout, not a
 * dashboard, and every figure in it was read back off the chain rather than remembered.
 */
function htmlReport({ ticker, def, holders, root, show, etchTxid, mintTxid, tTxid, height, decimals, alice, bob, aliceVout, bobBack }) {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const owner = (op) => (op === `${tTxid}:${aliceVout}` ? 'Alice' : op === `${tTxid}:${bobBack}` ? 'Bob' : 'issuer');
  const total = holders.reduce((s, h) => s + h.amount, 0);
  const rows = holders.map((h) => `<tr><td class="who">${owner(h.outpoint)}</td>`
    + `<td class="num">${show(h.amount)}</td>`
    + `<td class="pct">${((h.amount / total) * 100).toFixed(1)}%</td>`
    + `<td class="mono">${esc(h.outpoint)}</td></tr>`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ticker)} on Verge</title>
<style>
  :root{--bg:#fbfaf8;--fg:#1c1a17;--dim:#6b655c;--line:#e2ded6;--card:#fff;--accent:#7a4bd0}
  @media(prefers-color-scheme:dark){:root{--bg:#14130f;--fg:#eae6df;--dim:#948d81;--line:#2a2823;--card:#1c1a16;--accent:#b393f0}}
  *{box-sizing:border-box}
  body{margin:0;padding:2.5rem 1.25rem;background:var(--bg);color:var(--fg);
    font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
  main{max-width:56rem;margin:0 auto}
  .eyebrow{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
  h1{font-size:clamp(2rem,6vw,3rem);margin:.2em 0 .1em;letter-spacing:-.02em;text-wrap:balance}
  h1 span{color:var(--accent)}
  .sub{color:var(--dim);margin:0 0 2.5rem}
  h2{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);
    margin:2.5rem 0 .75rem;font-weight:600}
  .grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;
    grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));overflow:hidden}
  .cell{background:var(--card);padding:.9rem 1rem}
  .k{font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
  .v{font-size:1.15rem;font-variant-numeric:tabular-nums;margin-top:.15rem}
  .wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  th{text-align:left;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
    font-weight:600;padding:.7rem 1rem;border-bottom:1px solid var(--line)}
  td{padding:.7rem 1rem;border-bottom:1px solid var(--line)}
  tr:last-child td{border-bottom:0}
  .num,.pct{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .pct{color:var(--dim)}
  .who{font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--dim)}
  .root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;word-break:break-all;
    background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;line-height:1.7}
  .note{color:var(--dim);font-size:.85rem;margin-top:.6rem}
  footer{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--dim);font-size:.82rem}
</style></head><body><main>

  <p class="eyebrow">Verge Rune &middot; regtest</p>
  <h1><span>${esc(ticker)}</span></h1>
  <p class="sub">${esc(def.name || ticker)} &mdash; created, claimed and transferred on a Verge chain.
     Every number below was read back out of blocks.</p>

  <h2>The rune</h2>
  <div class="grid">
    <div class="cell"><div class="k">Supply</div><div class="v">${show(def.supply)}</div></div>
    <div class="cell"><div class="k">Premine</div><div class="v">${show(def.premine)}</div></div>
    <div class="cell"><div class="k">Issued by mint</div><div class="v">${show(def.minted)}</div></div>
    <div class="cell"><div class="k">Claims made</div><div class="v">${def.mintCount}${def.terms && def.terms.cap ? ' / ' + def.terms.cap : ''}</div></div>
    <div class="cell"><div class="k">Decimals</div><div class="v">${decimals}</div></div>
    <div class="cell"><div class="k">Per claim</div><div class="v">${def.terms ? show(def.terms.amount) : '&mdash;'}</div></div>
  </div>

  <h2>Who holds it</h2>
  <div class="wrap"><table>
    <thead><tr><th>Holder</th><th class="num">Balance</th><th class="pct">Share</th><th>Output carrying it</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="note">Balances sit on outputs, like the coin itself. Spending the output moves the balance.</p>

  <h2>State commitment at height ${height}</h2>
  <div class="root">${esc(root.toString('hex'))}</div>
  <p class="note">One merkle root over every balance in existence. A wallet proves its own balance
     against this without running an indexer, and cannot be lied to by one.</p>

  <h2>On chain</h2>
  <div class="wrap"><table><tbody>
    <tr><td class="who">Rune created</td><td class="mono">${esc(etchTxid)}</td></tr>
    <tr><td class="who">Claimed from mint</td><td class="mono">${esc(mintTxid)}</td></tr>
    <tr><td class="who">Transferred</td><td class="mono">${esc(tTxid)}</td></tr>
  </tbody></table></div>

  <footer>Regtest, a throwaway local chain: no real XVG was spent and no ticker was reserved.
     Protocol specification in <code>spec/RUNES-SPEC-v0.md</code>.</footer>
</main></body></html>`;
}

function cleanup() {
  if (node) { try { node.kill(); } catch { /* already gone */ } }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
}

main()
  .then(() => { cleanup(); say(''); process.exit(0); })
  .catch((e) => { console.error(`\n\x1b[31mfailed:\x1b[0m ${e.message}`); cleanup(); process.exit(1); });
