#!/usr/bin/env node
'use strict';
/**
 * Build the offline recovery kit: one HTML file that reopens a locked ticker price and needs
 * NOTHING to do it. No server, no extension, no store, no internet.
 *
 * Why this exists rather than only a page or only a wallet:
 *
 *   the /unlock page      dies with verginals.com
 *   the wallet extension  survives verginals.com, but leans on two ElectrumX servers run by other
 *                         people and on a browser store that can delist it
 *   this file             leans on nothing. It is a file. Keep it with your key.
 *
 * The trick that makes it possible is that SIGNING NEEDS NO NETWORK. Everything except the final
 * broadcast is arithmetic, and a signed transaction is just a hex string that any Verge node, any
 * explorer with a paste-transaction box, or anybody else's wallet will relay for you.
 *
 * It is built rather than hand-written so the cryptography stays the SAME CODE the wallet uses. A
 * hand-copied recovery tool is a second implementation of the thing that must not be wrong.
 *
 *   node tools/recovery-kit/build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Two homes, on purpose.
//
//   web/    the site hands it over as a download, for anybody who wants a copy of their own
//   docs/   GitHub Pages serves it at a URL that outlives this project's server
//
// The second is the durable one, and not only because GitHub is bigger than a VPS. The repository
// is PUBLIC, so the file travels in every clone and every fork: even if the account went away,
// anybody who ever cloned it still holds a working copy, and can serve it again. A recovery tool
// that depends on one machine staying up is a recovery tool with an expiry date.
const OUTPUTS = [
  path.join(ROOT, 'web', 'recovery-kit.html'),
  path.join(ROOT, 'docs', 'index.html'),
];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Turn one ES module into an expression that evaluates to its exports.
 *
 * Each module keeps its OWN SCOPE, inside an arrow function. The first attempt at this poured all
 * three into one scope with the `export` keywords stripped, and it did not survive contact with
 * reality: secp256k1.js and verge.js both declare `hexToBytes`, so the whole file failed to parse
 * and every button on the page silently did nothing. Modules have scopes for a reason and taking
 * them away costs more than it saves.
 *
 * `import` lines go, since the names they bound are passed in as arguments instead.
 */
function isolate(src, exports, params = '') {
  const body = src
    .replace(/^\s*import\s[^;]+;\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  return `((${params}) => {\n${body}\nreturn { ${exports.join(', ')} };\n})`;
}

// Only what the layer above actually reaches for. Listing them is the point: a name that stops
// being exported becomes a build error here instead of a dead button in four years.
const SECP_USES = ['getPublicKey', 'signAsync', 'utils', 'verify'];
const VERGE_USES = [
  'NETWORKS', 'SIGHASH_ALL', 'concatBytes', 'bytesToHex', 'sha256', 'hash160', 'base58Encode',
  'wifToPrivateKey', 'publicKeyFromPrivate', 'outputScript', 'legacySighash', 'signHashWith',
  'serializeTx',
];

const secpMod = isolate(read('extension/vendor/secp256k1.js'), SECP_USES);
const ripeMod = isolate(read('extension/vendor/ripemd160.js'), ['ripemd160']);
const vergeMod = isolate(read('extension/lib/verge.js'), VERGE_USES, 'secp, ripemd160');

const bridge = `
const __secp = ${secpMod}();
const { ripemd160: __ripemd160 } = ${ripeMod}();
const {
  ${VERGE_USES.join(', ')}
} = ${vergeMod}(__secp, __ripemd160);
`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verge Runes recovery kit</title>
<style>
:root { color-scheme: dark light; }
body {
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  max-width: 680px; margin: 0 auto; padding: 40px 20px 80px;
  background: #0d1117; color: #e6edf3;
}
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 18px; margin: 32px 0 8px; }
p { opacity: .84; }
.lede { font-size: 16px; }
label { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 5px; opacity: .8; }
input {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 14px;
  font-family: ui-monospace, Menlo, monospace;
  padding: 9px 11px; border-radius: 7px; border: 1px solid #30363d;
  background: #161b22; color: inherit;
}
button {
  margin-top: 18px; font: inherit; font-size: 15px; font-weight: 650;
  padding: 11px 22px; border-radius: 8px; border: 0;
  background: #4fd1c5; color: #06201d; cursor: pointer;
}
button[disabled] { opacity: .45; cursor: not-allowed; }
.box {
  margin-top: 18px; border: 1px solid #30363d; border-radius: 9px; padding: 14px 16px;
  font-size: 13.5px;
}
.hex {
  font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; line-height: 1.5;
  word-break: break-all; background: #161b22; padding: 10px; border-radius: 6px;
  margin-top: 10px; max-height: 220px; overflow-y: auto; user-select: all;
}
.warn { border-color: #d29922; background: rgba(210, 153, 34, .08); }
.err { color: #f85149; }
.ok { color: #56d364; }
.kv { display: flex; justify-content: space-between; gap: 14px; padding: 5px 0; border-bottom: 1px solid #21262d; }
.kv:last-child { border-bottom: 0; }
.kv span:first-child { opacity: .7; }
.kv span:last-child { font-weight: 600; text-align: right; word-break: break-all; }
footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid #21262d; font-size: 12.5px; opacity: .62; }
code { background: #161b22; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>

<h1>Verge Runes recovery kit</h1>
<p class="lede">
  This file reopens a locked ticker price. It works with no internet, no server and no wallet
  installed. Keep it wherever you kept your key.
</p>

<div class="box warn">
  <b>Turn off your internet if you like.</b> Nothing here contacts anything. The transaction is built
  and signed on this machine, and you are handed a piece of text to broadcast however you wish.
</div>

<div class="box">
  <b>You cannot lose this page.</b> It lives in a public repository, so it travels in every copy
  anybody has ever made of it. Save the file, bookmark the address, or fetch it again from the
  source: <code>github.com/TheWeb3Frog/Verginals</code>, under <code>docs/</code>. If every website
  in this project disappeared tomorrow, any of those copies still opens your lock, because the maths
  is in the file and the money is on the chain.
</div>

<h2>What you saved</h2>
<label for="wif">Your unlock key</label>
<input id="wif" type="text" spellcheck="false" placeholder="the key from when you etched the coin">
<label for="locktime">Release date (the unix number)</label>
<input id="locktime" type="text" spellcheck="false" placeholder="1900000000">
<label for="txid">Etch transaction id</label>
<input id="txid" type="text" spellcheck="false" placeholder="64 hex characters">
<label for="vout">Which output holds the lock</label>
<input id="vout" type="text" spellcheck="false" placeholder="1">
<label for="value">How much is locked, in XVG</label>
<input id="value" type="text" spellcheck="false" placeholder="2500">
<label for="dest">Send it to</label>
<input id="dest" type="text" spellcheck="false" placeholder="D...">
<label for="fee">Miner fee, in XVG</label>
<input id="fee" type="text" spellcheck="false" value="0.2">

<button id="go">Build and sign</button>
<div id="out"></div>

<footer>
  <p>
    <b>How to broadcast it.</b> The signed transaction below is plain text. Paste it into any Verge
    node (<code>sendrawtransaction</code>), any block explorer that accepts a raw transaction, or
    hand it to anybody running a node. It is already signed, so nobody who relays it can change
    where the money goes.
  </p>
  <p>
    <b>If the date has not passed</b>, the network will refuse it. That is the lock doing its job.
    Verge judges the deadline by median time past, which trails the clock by roughly an hour, so
    wait a little past the date rather than trying at the exact second.
  </p>
</footer>

<script type="module">
${bridge}

const $ = (s) => document.querySelector(s);
const COIN = 1e6;

function scriptNum(n) {
  const b = []; let v = n;
  while (v > 0) { b.push(v & 0xff); v = Math.floor(v / 256); }
  if (b[b.length - 1] & 0x80) b.push(0);
  return Uint8Array.from(b);
}
const push = (d) => concatBytes(Uint8Array.from([d.length]), d);
const redeemScript = (lt, pk) =>
  concatBytes(push(scriptNum(lt)), Uint8Array.from([0xb1, 0x75]), push(pk), Uint8Array.from([0xac]));

async function withChecksum(p) {
  const d = await sha256(await sha256(p));
  return concatBytes(p, d.slice(0, 4));
}
async function p2sh(redeem, net) {
  return base58Encode(await withChecksum(Uint8Array.from([net.scriptHash, ...(await hash160(redeem))])));
}

function row(host, k, v, cls) {
  const d = document.createElement('div'); d.className = 'kv';
  const a = document.createElement('span'); a.textContent = k;
  const b = document.createElement('span'); b.textContent = v; if (cls) b.className = cls;
  d.append(a, b); host.append(d);
}

$('#go').addEventListener('click', async () => {
  const out = $('#out');
  out.textContent = '';
  const box = document.createElement('div'); box.className = 'box'; out.append(box);
  try {
    const wif = $('#wif').value.trim();
    const locktime = Number($('#locktime').value.trim());
    const txid = $('#txid').value.trim().toLowerCase();
    const vout = Number($('#vout').value.trim());
    const value = Math.round(Number($('#value').value.trim()) * COIN);
    const fee = Math.round(Number($('#fee').value.trim()) * COIN);
    const dest = $('#dest').value.trim();

    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('the transaction id must be 64 hex characters');
    if (!Number.isInteger(locktime) || locktime < 500000000) throw new Error('the release date must be a unix timestamp');
    if (!Number.isInteger(vout) || vout < 0) throw new Error('the output number must be a whole number');
    if (!(value > 0)) throw new Error('how much is locked?');
    if (!(fee > 0) || fee >= value) throw new Error('the fee must be positive and smaller than the amount');

    const { privateKey, network } = await wifToPrivateKey(wif);
    if (!network) throw new Error('that key is not for any Verge network this kit knows');
    const pub = publicKeyFromPrivate(privateKey);
    const redeem = redeemScript(locktime, pub);
    const lockAddr = await p2sh(redeem, network);

    row(box, 'Your key opens', lockAddr);
    row(box, 'Network', network.name);
    row(box, 'Recovering', ((value - fee) / COIN).toLocaleString() + ' XVG');
    row(box, 'To', dest);

    const tx = {
      version: 1,
      time: Math.floor(Date.now() / 1000),
      // Non-final, or the network ignores the deadline entirely and the lock means nothing.
      vin: [{ txid, vout, sequence: 0xfffffffe, script: new Uint8Array(0) }],
      vout: [{ value: value - fee, script: await outputScript(dest) }],
      locktime: locktime >>> 0,
    };
    const sighash = await legacySighash(tx, 0, redeem, SIGHASH_ALL);
    const sig = await signHashWith(sighash, privateKey, SIGHASH_ALL);
    tx.vin[0].script = concatBytes(push(sig), push(redeem));
    const hex = bytesToHex(serializeTx(tx));

    const done = document.createElement('p');
    done.className = 'ok';
    done.textContent = 'Signed. Check the address above is where your coins are, then broadcast this:';
    out.append(done);
    const pre = document.createElement('div'); pre.className = 'hex'; pre.textContent = hex;
    out.append(pre);
  } catch (e) {
    const p = document.createElement('p'); p.className = 'err'; p.textContent = e.message;
    box.append(p);
  }
});
</script>
</body>
</html>
`;

// Parse what was produced before writing it. The failure this guards against is silent: a module
// that does not evaluate leaves every button inert with nothing in the console.
const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
try {
  new (require('vm').Script)(script, { filename: 'recovery-kit' });
} catch (e) {
  console.error('the kit does not parse, refusing to write it: ' + e.message);
  process.exit(1);
}

for (const out of OUTPUTS) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`wrote ${path.relative(ROOT, out)}  (${kb} KB, self-contained)`);
}
