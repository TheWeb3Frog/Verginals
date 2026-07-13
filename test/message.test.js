// Verge signed-message verification: sign in Node the exact way the wallet does, then verify.
// Browser (@noble) and server (tiny-secp256k1) produce byte-identical RFC6979 low-S signatures,
// so this round-trip proves the server accepts real wallet signatures.
// Run: node test/message.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const crypto = require('crypto');
const { magicHash, recoverAddress, verifyMessage } = require('../src/message');
const { mainnet, testnet } = require('../src/networks');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

// Build a bitcoinjs network object from our networks.js entry (same fields the server uses).
function bjs(net) {
  return {
    messagePrefix: net.messagePrefix,
    bech32: net.bech32 || 'xvg',
    bip32: net.bip32 || { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: net.pubKeyHash,
    scriptHash: net.scriptHash,
    wif: net.wif,
  };
}

// Sign a message exactly like extension/lib/verge.js: magicHash, recoverable sign, base64 header+rs.
function signMessage(message, priv, compressed = true) {
  const h = magicHash(message);
  const { signature, recoveryId } = ecc.signRecoverable(h, priv);
  const header = Buffer.from([27 + (recoveryId & 1) + (compressed ? 4 : 0)]);
  return Buffer.concat([header, Buffer.from(signature)]).toString('base64');
}

function freshKey(network) {
  let priv;
  do { priv = crypto.randomBytes(32); } while (!ecc.isPrivate(priv));
  const pubkey = Buffer.from(ecc.pointFromScalar(priv, true));
  const address = bitcoin.payments.p2pkh({ pubkey, network }).address;
  return { priv, address };
}

const mnet = bjs(mainnet);
const tnet = bjs(testnet);

test('mainnet addresses start with D', () => {
  const { address } = freshKey(mnet);
  assert.ok(address.startsWith('D'), `expected D..., got ${address}`);
});

test('round-trip: a wallet-style signature verifies for the signer address', () => {
  const { priv, address } = freshKey(mnet);
  const msg = 'verginals-arena:D...:abc123:1789999999';
  const sig = signMessage(msg, priv);
  assert.strictEqual(verifyMessage(address, msg, sig, mnet), true);
});

test('a different message does not verify', () => {
  const { priv, address } = freshKey(mnet);
  const sig = signMessage('hello', priv);
  assert.strictEqual(verifyMessage(address, 'hello tampered', sig, mnet), false);
});

test('a different address does not verify', () => {
  const { priv } = freshKey(mnet);
  const other = freshKey(mnet).address;
  const sig = signMessage('hello', priv);
  assert.strictEqual(verifyMessage(other, 'hello', sig, mnet), false);
});

test('recoverAddress returns the exact signer', () => {
  const { priv, address } = freshKey(mnet);
  const sig = signMessage('who am i', priv);
  assert.strictEqual(recoverAddress('who am i', sig, mnet), address);
});

test('a signature from the wrong network recovers a different address', () => {
  // Same key, but deriving on testnet gives a different address than the mainnet signer.
  const { priv, address } = freshKey(mnet);
  const sig = signMessage('x', priv);
  assert.notStrictEqual(recoverAddress('x', sig, tnet), address);
});

test('malformed signatures return null / false, never throw', () => {
  assert.strictEqual(recoverAddress('m', 'not-base64!!', mnet), null);
  assert.strictEqual(recoverAddress('m', Buffer.alloc(10).toString('base64'), mnet), null); // wrong length
  assert.strictEqual(recoverAddress('m', Buffer.alloc(65).toString('base64'), mnet), null); // header 0
  assert.strictEqual(verifyMessage('D1', 'm', '', mnet), false);
  assert.strictEqual(verifyMessage('', 'm', 'sig', mnet), false);
});

test('uncompressed header (27-30) is accepted', () => {
  const { priv } = freshKey(mnet);
  const h = magicHash('u');
  const { signature, recoveryId } = ecc.signRecoverable(h, priv);
  const header = Buffer.from([27 + (recoveryId & 1)]); // no +4 -> claims uncompressed
  const sig = Buffer.concat([header, Buffer.from(signature)]).toString('base64');
  const pubkeyUncompressed = Buffer.from(ecc.pointFromScalar(priv, false));
  const addr = bitcoin.payments.p2pkh({ pubkey: pubkeyUncompressed, network: mnet }).address;
  assert.strictEqual(verifyMessage(addr, 'u', sig, mnet), true);
});

console.log(`\n${passed} passed`);
