// Builder tests: P2SH derivation + signed commit/reveal, offline. Run: node test/builder.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const {
  ECPair,
  toBitcoinjsNetwork,
  p2shFor,
  buildInscriptionScripts,
  buildReveal,
  parseInscriptionScript,
} = require('../src/builder');
const { extractRedeemScript } = require('../src/rpc');
const { testnet } = require('../src/networks');

const network = toBitcoinjsNetwork(testnet);
// Deterministic key (priv = 0x0101..01) so tests are reproducible.
const signer = ECPair.fromPrivateKey(Buffer.alloc(32, 1), { network });
const pubkey = Buffer.from(signer.publicKey);
const payout = bitcoin.payments.p2pkh({ pubkey, network }).address;

// Pull the revealed redeemScript (last push) out of a signed scriptSig buffer.
const redeemOf = (scriptSig) => extractRedeemScript({ hex: scriptSig.toString('hex') });

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Fabricate a confirmed commit UTXO sitting at the P2SH address (no node needed).
function fakeCommit(redeemScript, value, vout = 0) {
  return { txid: 'ab'.repeat(32), vout, value, redeemScript };
}

test('P2SH address uses the Verge testnet scriptHash version', () => {
  const [rs] = buildInscriptionScripts({ pubkey, contentType: 'text/plain', body: Buffer.from('x') });
  const { address } = p2shFor(rs, network);
  assert.strictEqual(bitcoin.address.fromBase58Check(address).version, testnet.scriptHash);
});

test('single-input reveal: signs, validates, and reveals the envelope', () => {
  const body = Buffer.from('Hello, Verge!', 'utf8');
  const scripts = buildInscriptionScripts({ pubkey, contentType: 'text/plain;charset=utf-8', body });
  assert.strictEqual(scripts.length, 1);

  const commitValue = 100_000; // atomic units (0.1 XVG)
  const inputs = [fakeCommit(scripts[0], commitValue)];
  const { tx, txid } = buildReveal({
    network,
    inputs,
    outputs: [{ address: payout, value: commitValue - 2_000 /* fee */ }],
    signer,
  });

  assert.strictEqual(tx.vin.length, 1);
  // scriptSig = <sig> <redeemScript>; the redeemScript is the last push.
  assert.deepStrictEqual(redeemOf(tx.vin[0].script), scripts[0]);
  const parsed = parseInscriptionScript(redeemOf(tx.vin[0].script));
  assert.strictEqual(parsed.contentType.toString('utf8'), 'text/plain;charset=utf-8');
  assert.strictEqual(parsed.body.toString('utf8'), 'Hello, Verge!');
  // A real, serializable tx with a txid.
  assert.match(txid, /^[0-9a-f]{64}$/);
});

test('multi-input reveal: large payload reassembles in input order', () => {
  const body = Buffer.alloc(8_000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
  const scripts = buildInscriptionScripts({ pubkey, contentType: 'image/png', body });
  assert.ok(scripts.length >= 3, `expected multiple inputs, got ${scripts.length}`);

  const perInput = 50_000;
  const inputs = scripts.map((rs, i) => fakeCommit(rs, perInput, i));
  const totalIn = perInput * inputs.length;
  const { tx } = buildReveal({
    network,
    inputs,
    outputs: [{ address: payout, value: totalIn - 5_000 }],
    signer,
  });

  assert.strictEqual(tx.vin.length, scripts.length);
  // Reassemble body from every input's revealed redeemScript, in order.
  const reassembled = Buffer.concat(
    tx.vin.map((inp) => parseInscriptionScript(redeemOf(inp.script)).body)
  );
  assert.deepStrictEqual(reassembled, body);
  // content-type only on the first input
  assert.strictEqual(
    parseInscriptionScript(redeemOf(tx.vin[0].script)).contentType.toString('utf8'),
    'image/png'
  );
  assert.strictEqual(parseInscriptionScript(redeemOf(tx.vin[1].script)).contentType, null);
});

console.log(`\n${passed} tests passed`);
