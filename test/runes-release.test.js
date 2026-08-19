// The pre-signed release: signed at etch time, verified as a stranger would in 2030.
// Run: node test/runes-release.test.js
const assert = require('assert');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { ECPair, toBitcoinjsNetwork } = require('../src/builder');
const { mainnet } = require('../src/networks');
const recover = require('../src/runes/recover');
const R = require('../src/runes/release');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const net = toBitcoinjsNetwork(mainnet);
const COIN = 1e6;
const PRICE = 2500 * COIN;
const FOUR_YEARS = 1460 * 86400;

/** Everything an etcher has at the moment of etching, and nothing they would have four years on. */
function anEtch(seed = 'etch-1') {
  const lockKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update(seed).digest(), { network: net });
  const homeKey = ECPair.fromPrivateKey(crypto.createHash('sha256').update(seed + ':home').digest(), { network: net });
  const home = bitcoin.payments.p2pkh({ pubkey: homeKey.publicKey, network: net }).address;
  const locktime = Math.floor(Date.now() / 1000) + FOUR_YEARS;
  const lock = recover.lockAddress({ locktime, wif: lockKey.toWIF(), network: net });
  // The reveal is fully signed before it is broadcast, so its txid is known while the key is still
  // in hand. That is the whole reason this can be pre-signed at all.
  const revealTxid = crypto.createHash('sha256').update(seed + ':reveal').digest().toString('hex');
  return { lockKey, homeKey, home, locktime, lock, revealTxid, lockVout: 1 };
}

function releaseFor(e, fee = R.DEFAULT_FEE) {
  return recover.buildUnlock({
    wif: e.lockKey.toWIF(), locktime: e.locktime, network: net, to: e.home, fee,
    utxos: [{ txid: e.revealTxid, vout: e.lockVout, value: PRICE }],
  });
}

console.log('signing it at etch time');

test('the release can be signed before the reveal is even broadcast', () => {
  const e = anEtch();
  const rel = releaseFor(e);
  assert.ok(rel.hex.length > 200, 'a transaction came out');
  assert.strictEqual(rel.address, e.lock.address, 'it spends the lock we built');
});

test('it is small enough to inscribe', () => {
  const e = anEtch();
  const payload = R.encodeRelease(releaseFor(e).hex);
  assert.ok(payload.length < 400, 'payload is ' + payload.length + ' bytes');
  console.log('     (' + payload.length + ' bytes on chain, once, forever)');
});

console.log('reading it back as a stranger would');

test('the payload survives a round trip through the inscription envelope', () => {
  const e = anEtch();
  const hex = releaseFor(e).hex;
  const back = R.decodeRelease(R.encodeRelease(hex));
  assert.ok(back, 'it decoded');
  assert.strictEqual(back.txHex, hex, 'byte for byte');
});

test('junk decodes to null instead of throwing', () => {
  assert.strictEqual(R.decodeRelease(Buffer.from('not a release')), null);
  assert.strictEqual(R.decodeRelease(Buffer.alloc(3)), null);
  assert.strictEqual(R.decodeRelease(Buffer.concat([R.MAGIC, Buffer.from([99]), Buffer.alloc(10)])), null);
});

test('the parser reads a Verge transaction it did not build', () => {
  const e = anEtch();
  const hex = releaseFor(e).hex;
  const tx = R.parseTx(hex);
  assert.strictEqual(tx.vin.length, 1);
  assert.strictEqual(tx.vout.length, 1);
  assert.strictEqual(tx.vin[0].txid, e.revealTxid);
  assert.strictEqual(tx.vin[0].vout, e.lockVout);
  assert.strictEqual(tx.locktime, e.locktime, 'nLockTime is the release date');
  assert.notStrictEqual(tx.vin[0].sequence, 0xffffffff, 'non-final, so nLockTime is enforced');
});

console.log('verifying it with the key destroyed');

test('a stranger can verify the whole thing from the bytes and the chain alone', () => {
  const e = anEtch();
  const hex = releaseFor(e).hex;

  // Everything the etcher had is thrown away here. What is left is what 2030 has: the raw
  // transaction, and the two facts anybody can read off the chain about the output it spends.
  const lockScriptPubKey = e.lock.output || bitcoin.address.toOutputScript(e.lock.address, net);
  const v = R.verifyRelease({ hex, lockScriptPubKey, lockValue: PRICE, network: net });

  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.to, e.home, 'it pays the etcher, and only the etcher');
  assert.strictEqual(v.locktime, e.locktime);
  assert.strictEqual(v.fee, R.DEFAULT_FEE);
  assert.strictEqual(v.value, PRICE - R.DEFAULT_FEE);
  assert.strictEqual(v.spends.txid, e.revealTxid);
});

test('the destination is an ordinary address every Verge wallet already watches', () => {
  const e = anEtch();
  const v = R.verifyRelease({
    hex: releaseFor(e).hex,
    lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.to[0], 'D', 'a D address, not the E of the lock');
  assert.notStrictEqual(v.to, e.lock.address);
});

console.log('what the verifier has to refuse');

test('a release for a different lock is refused', () => {
  const a = anEtch('a'), b = anEtch('b');
  const v = R.verifyRelease({
    hex: releaseFor(a).hex,
    lockScriptPubKey: bitcoin.address.toOutputScript(b.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /does not open that lock/);
});

test('a tampered destination breaks the signature', () => {
  const e = anEtch(), thief = anEtch('thief');
  const tx = R.parseTx(releaseFor(e).hex);
  tx.vout[0].script = bitcoin.address.toOutputScript(thief.home, net);
  const { serializeTx } = require('../src/vergetx');
  const v = R.verifyRelease({
    hex: serializeTx(tx).toString('hex'),
    lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /signature does not verify/);
});

test('flipping one byte of the signature is caught', () => {
  // The control for the check above it. A verifier that accepts everything would still have passed
  // the tampered-destination test if it never reached the signature at all.
  const e = anEtch();
  const tx = R.parseTx(releaseFor(e).hex);
  const sig = Buffer.from(tx.vin[0].script);
  sig[10] ^= 0x01;
  tx.vin[0].script = sig;
  const { serializeTx } = require('../src/vergetx');
  const v = R.verifyRelease({
    hex: serializeTx(tx).toString('hex'),
    lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false, 'a corrupted signature must not verify');
});

test('a final sequence is refused, because nLockTime would be ignored', () => {
  const e = anEtch();
  const tx = R.parseTx(releaseFor(e).hex);
  tx.vin[0].sequence = 0xffffffff;
  const { serializeTx } = require('../src/vergetx');
  const v = R.verifyRelease({
    hex: serializeTx(tx).toString('hex'),
    lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /final/);
});

test('a release that pays no fee is refused, because nothing would relay it', () => {
  const e = anEtch();
  const hex = releaseFor(e, 0).hex;
  const v = R.verifyRelease({
    hex, lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /no fee/);
});

test('a release paying into a script rather than an address is refused', () => {
  const e = anEtch();
  const other = recover.lockAddress({ locktime: e.locktime, wif: e.homeKey.toWIF(), network: net });
  const rel = recover.buildUnlock({
    wif: e.lockKey.toWIF(), locktime: e.locktime, network: net, to: other.address, fee: R.DEFAULT_FEE,
    utxos: [{ txid: e.revealTxid, vout: e.lockVout, value: PRICE }],
  });
  const v = R.verifyRelease({
    hex: rel.hex, lockScriptPubKey: bitcoin.address.toOutputScript(e.lock.address, net),
    lockValue: PRICE, network: net,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /ordinary address/);
});

console.log('storing it and finding it again');

test('it goes on chain as an inscription with its own content type', () => {
  const e = anEtch();
  const ins = R.releaseInscription(releaseFor(e).hex);
  assert.strictEqual(ins.contentType, R.CONTENT_TYPE);
  assert.ok(Buffer.isBuffer(ins.body));
  assert.strictEqual(R.decodeRelease(ins.body).txHex, releaseFor(e).hex);
});

test('reading it back copes with whatever shape a future tool hands over', () => {
  // In four years the thing reading this may not be our code. Refusing a valid release because the
  // wrapper looked unfamiliar is exactly the failure this design exists to prevent.
  const e = anEtch();
  const hex = releaseFor(e).hex;
  const payload = R.encodeRelease(hex);
  for (const shape of [
    payload,
    payload.toString('hex'),
    payload.toString('base64'),
    { body: payload },
    { content: payload.toString('hex') },
    { data: payload.toString('base64') },
  ]) {
    const got = R.readInscribedRelease(shape);
    assert.ok(got, 'shape rejected: ' + (typeof shape));
    assert.strictEqual(got.txHex, hex);
  }
});

test('and it says no to things that are not a release', () => {
  assert.strictEqual(R.readInscribedRelease(null), null);
  assert.strictEqual(R.readInscribedRelease(''), null);
  assert.strictEqual(R.readInscribedRelease('hello there'), null);
  assert.strictEqual(R.readInscribedRelease(Buffer.from('deadbeef', 'hex')), null);
  assert.strictEqual(R.readInscribedRelease({ body: Buffer.alloc(0) }), null);
});

console.log('the fee, four years out');

test('the default fee clears a policy far stricter than today', () => {
  const e = anEtch();
  const hex = releaseFor(e).hex;
  const bytes = hex.length / 2;
  const perKb = (R.DEFAULT_FEE / bytes) * 1000;
  // Verge relays at 0.1 XVG absolute today. This asks how much the floor could rise before a
  // release stops relaying, which is the only part of this scheme that decays with time.
  console.log('     (' + bytes + ' bytes, ' + (R.DEFAULT_FEE / COIN) + ' XVG, '
    + (perKb / COIN).toFixed(1) + ' XVG/kB, and ' + Math.round(R.DEFAULT_FEE / (0.1 * COIN)) + 'x the 0.1 XVG absolute floor that actually binds at this size)');
  assert.ok(perKb / COIN >= 2, 'at least ten times the current relay rate');
});

console.log(`\n${passed} checks passed`);
