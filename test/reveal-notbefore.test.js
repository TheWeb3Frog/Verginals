// A reveal that cannot be mined before a chosen block.
//
// Why this exists: an etching mined one block under the activation height is NOT a rune, and yet the
// ticker deposit still went into a real locked output. 5,000 XVG parked for four years in exchange
// for nothing, decided by a miner's timing rather than by any mistake of the etcher's. nLockTime
// removes the possibility instead of reducing it.
//
// The trap this file mostly exists to guard: nLockTime does nothing at all unless an input carries a
// non-final sequence. A transaction with every sequence at 0xffffffff is final whatever nLockTime
// says, so a build that sets one without the other looks protected and is not.
//
// Run: node test/reveal-notbefore.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { buildReveal } = require('../src/builder');
const { parseTx } = require('../src/runes/release');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const signer = ECPair.makeRandom({ network });
const addr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(signer.publicKey), network }).address;
const script = bitcoin.payments.p2pkh({ pubkey: Buffer.from(signer.publicKey), network }).output;
const H = (c) => c.repeat(64);

const mk = (over = {}) => buildReveal(Object.assign({
  network,
  inputs: [{ txid: H('a'), vout: 0, value: 10_000_000, p2pkh: true, signer }],
  outputs: [{ address: addr, value: 9_000_000 }],
  signer,
  time: 1_787_000_000,
}, over));

test('without notBefore nothing changes: final sequences, no locktime', () => {
  const r = mk();
  const w = parseTx(r.hex);
  assert.strictEqual(w.locktime, 0);
  assert.strictEqual(w.vin[0].sequence, 0xffffffff);
});

test('with notBefore the locktime is set AND the sequence goes non-final', () => {
  // Both, or neither works. This is the whole point of the file.
  const r = mk({ notBefore: 9_420_419 });
  const w = parseTx(r.hex);
  assert.strictEqual(w.locktime, 9_420_419);
  assert.strictEqual(w.vin[0].sequence, 0xfffffffe);
  assert.notStrictEqual(w.vin[0].sequence, 0xffffffff, 'a final sequence would make the lock decorative');
});

test('every input goes non-final, not just the first', () => {
  const r = mk({
    notBefore: 9_420_419,
    inputs: [
      { txid: H('a'), vout: 0, value: 5_000_000, p2pkh: true, signer },
      { txid: H('b'), vout: 1, value: 5_000_000, p2pkh: true, signer },
    ],
  });
  const w = parseTx(r.hex);
  for (const v of w.vin) assert.strictEqual(v.sequence, 0xfffffffe);
});

test('the height is the one asked for, so H-1 is what lets you land in H', () => {
  // Consensus reads it as "final when nLockTime < the block's height". A transaction locked to
  // 9,420,419 is therefore first legal in 9,420,420, which is the block being aimed at.
  const r = mk({ notBefore: 9_420_419 });
  assert.strictEqual(parseTx(r.hex).locktime, 9_420_419);
});

test('a timestamp is refused, because it would be read as a height and silently do nothing', () => {
  // 500000000 is the boundary. Anything at or above it is a unix time, and a caller who passed one
  // by mistake would get a transaction that is final immediately while believing it was locked.
  assert.throws(() => mk({ notBefore: 1_787_000_000 }), /never a timestamp/);
  assert.throws(() => mk({ notBefore: 500_000_000 }), /never a timestamp/);
  assert.doesNotThrow(() => mk({ notBefore: 499_999_999 }));
});

test('the signatures cover the locktime, so it cannot be stripped in flight', () => {
  const locked = mk({ notBefore: 9_420_419 });
  const open = mk();
  assert.notStrictEqual(locked.txid, open.txid);
  // Take the locked transaction, put the locktime back to zero, and the signature no longer verifies.
  const w = parseTx(locked.hex);
  const tampered = { version: w.version, time: w.time, locktime: 0, vin: w.vin, vout: w.vout };
  const { legacySighash, SIGHASH_ALL } = require('../src/vergetx');
  const sighash = legacySighash(tampered, 0, script, SIGHASH_ALL);
  const parts = bitcoin.script.decompile(w.vin[0].script);
  const sig = bitcoin.script.signature.decode(parts[0]);
  assert.strictEqual(ecc.verify(sighash, parts[1], sig.signature), false, 'stripping the lock must break the signature');

  // CONTROL: against the untampered transaction that same signature DOES verify, so the check above
  // is failing for the reason claimed rather than because the harness is wrong.
  const honest = { version: w.version, time: w.time, locktime: w.locktime, vin: w.vin, vout: w.vout };
  const good = legacySighash(honest, 0, script, SIGHASH_ALL);
  assert.strictEqual(ecc.verify(good, parts[1], sig.signature), true);
});

console.log(`\n${passed} passed`);
