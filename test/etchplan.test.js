// POST /api/runes/etch/plan: the composer behind the etch page.
//
// The page is a form over this endpoint, so what is worth testing is not the arithmetic (builder.js
// and cli.js own that, and their own suites cover it) but the BOUNDARY: what it accepts, what it
// refuses, and whether what it hands back is an etching the indexer would actually register. A page
// that composed something the protocol rejects would take somebody's money for nothing.
//
// Run: node test/etchplan.test.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const bitcoin = require('bitcoinjs-lib');
const cbor = require(path.join(ROOT, 'src/cbor'));
const { ECPair } = require(path.join(ROOT, 'src/builder'));
const { pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { RuneState, applyTx: rawApplyTx, runeRefOf } = require(path.join(ROOT, 'src/runes/indexer'));
// Synthetic heights, so the mainnet activation and maturity rules are switched off explicitly here.
// They are covered against the real defaults in test/runes-maturity.test.js.
const applyTx = (state, tx, o) => rawApplyTx(state, tx, Object.assign({ activationHeight: 0, etchMaturity: 0 }, o));
const tickers = require(path.join(ROOT, 'src/runes/tickers'));

const PORT = 8900 + Math.floor(Math.random() * 90);
const { network } = pickNetwork('mainnet');

let passed = 0;
const queued = [];
const test = (name, fn) => queued.push([name, fn]);

function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/api/runes/etch/plan', timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(payload);
  });
}

const key = ECPair.makeRandom({ network });
const PUB = Buffer.from(key.publicKey).toString('hex');
const ADDR = bitcoin.payments.p2pkh({ pubkey: Buffer.from(key.publicKey), network }).address;
const base = () => ({
  ticker: 'GRUMPY', divisibility: 2, supply: 21000000, premine: 1000000,
  recipient: ADDR, lockPubkey: PUB,
});

// --- what it refuses ------------------------------------------------------------------------------

test('a bad recipient address is refused, not composed around', async () => {
  const r = await post(Object.assign(base(), { recipient: 'not-an-address' }));
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /recipient/);
});

test('the lock key must be a real compressed public key', async () => {
  for (const bad of ['', 'zz', '02' + '11'.repeat(20), '04' + '11'.repeat(32)]) {
    const r = await post(Object.assign(base(), { lockPubkey: bad }));
    assert.strictEqual(r.status, 400, 'accepted ' + bad);
    assert.match(r.body.error, /lockPubkey/);
  }
});

test('a ticker the protocol cannot hold is refused', async () => {
  for (const bad of ['', 'A'.repeat(27), 'HAS SPACE', 'lower$case']) {
    const r = await post(Object.assign(base(), { ticker: bad }));
    assert.strictEqual(r.status, 400, 'accepted "' + bad + '"');
  }
});

test('mint terms that could never work are refused at composition', async () => {
  const over = await post(Object.assign(base(), { terms: { amount: 1000, price: 50 * 1e6 } }));
  assert.strictEqual(over.status, 400);
  assert.match(over.body.error, /49|ceiling|cannot be paid/i);

  const whole = await post(Object.assign(base(), { premine: 21000000, terms: { amount: 1000 } }));
  assert.strictEqual(whole.status, 400, 'a fully premined open mint can never mint');
});

// --- what it composes -----------------------------------------------------------------------------

test('a separator is free: the price is on the bare name', async () => {
  const spaced = await post(Object.assign(base(), { ticker: 'GRUM•PY' }));
  const bare = await post(Object.assign(base(), { ticker: 'GRUMPY' }));
  assert.strictEqual(spaced.status, 200, JSON.stringify(spaced.body));
  assert.strictEqual(spaced.body.ticker, 'GRUMPY');
  assert.strictEqual(spaced.body.display, 'GRUM•PY');
  assert.strictEqual(spaced.body.price, bare.body.price, 'a bullet must not change the price');
  assert.strictEqual(bare.body.spacers, 0);
});

test('the price follows the length schedule, and the lock outlasts four years', async () => {
  const r = await post(Object.assign(base(), { ticker: 'ABCD' }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.price, tickers.priceOf('ABCD'));
  const seconds = r.body.lock.locktime - Math.floor(Date.now() / 1000);
  assert.ok(seconds > tickers.LOCK_SECONDS, 'the lock must outlast the protocol minimum');
});

test('the private half of the unlock key is never in the answer', async () => {
  const r = await post(base());
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(key.toWIF()), 'the WIF must never come back from the server');
  // the commit key is a different, disposable thing and IS returned, deliberately
  assert.ok(r.body.commit.wif, 'the commit key funds the reveal and is spent in the same breath');
});

// --- and the decisive one -------------------------------------------------------------------------

test('what it composes is an etching the indexer actually registers', async () => {
  const r = await post(Object.assign(base(), { terms: { amount: 1000, cap: 20000, price: 20 * 1e6 } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const body = cbor.decode(Buffer.from(r.body.bodyHex, 'hex'));
  const lockSpk = bitcoin.address.toOutputScript(r.body.lock.address, network);
  const state = new RuneState();
  applyTx(state, {
    txid: 'reveal', height: 9410000, txIndex: 3, inputs: [],
    time: Math.floor(Date.now() / 1000) + 600,          // confirms shortly after composing
    outputs: [
      { value: 100000, scriptPubKey: Buffer.alloc(1), isOpReturn: false },
      { value: r.body.price, scriptPubKey: lockSpk, isOpReturn: false },
    ],
    etching: {
      ticker: body.t, name: body.n, divisibility: body.d, supply: body.s, premine: body.p,
      spacers: body.x,
      terms: { amount: body.m.a, cap: body.m.c, price: body.m.f },
      lock: { t: body.l.t, k: Buffer.from(Object.values(body.l.k)) },
    },
  });

  const ref = runeRefOf(9410000, 3);
  assert.ok(state.tickers.has('GRUMPY'), 'the composed etching did not register');
  assert.strictEqual(state.tickers.get('GRUMPY'), ref);
  assert.strictEqual(state.balanceOf('reveal:0', ref), 1000000, 'the premine must land on output 0');
  assert.strictEqual(state.runes.get(ref).terms.price, 20 * 1e6);
});

test('and it does NOT register if the lock output is left off', async () => {
  const r = await post(base());
  const body = cbor.decode(Buffer.from(r.body.bodyHex, 'hex'));
  const state = new RuneState();
  applyTx(state, {
    txid: 'reveal', height: 9410000, txIndex: 3, inputs: [],
    time: Math.floor(Date.now() / 1000) + 600,
    outputs: [{ value: 100000, scriptPubKey: Buffer.alloc(1), isOpReturn: false }], // no lock paid
    etching: {
      ticker: body.t, divisibility: body.d, supply: body.s, premine: body.p,
      lock: { t: body.l.t, k: Buffer.from(Object.values(body.l.k)) },
    },
  });
  assert.strictEqual(state.tickers.size, 0, 'an unpaid etching must claim nothing');
});

// --- run ------------------------------------------------------------------------------------------

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), VERGINALS_NETWORK: 'mainnet' }),
    stdio: 'ignore',
  });
  const stop = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
  process.on('exit', stop);

  try {
    for (let i = 0; i < 60; i++) {
      try { await post(base()); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    for (const [name, fn] of queued) { await fn(); passed += 1; console.log('  ok - ' + name); }
    console.log('\netch plan: ' + passed + ' passed');
  } catch (e) {
    console.error(e);
    stop();
    process.exit(1);
  }
  stop();
  process.exit(0);
})();
