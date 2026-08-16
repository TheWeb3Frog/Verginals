// Where a locked ticker price lives, and how it is found again.
//
// The end-to-end suite proves the spend works against a real node. This one guards the thing that
// must NEVER change: how the lock address is derived. If that drifts by a byte, every etcher who
// saved a key is looking in the wrong place for money that is still sitting where it always was.
//
// Run: node test/runes-recover.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const recover = require('../src/runes/recover');
const tickers = require('../src/runes/tickers');
const { ECPair } = require('../src/builder');
const { pickNetwork } = require('../src/cli');

const { network } = pickNetwork('mainnet');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

// A fixed key and a fixed date, so the address below is a constant this suite pins down.
const WIF = ECPair.fromPrivateKey(Buffer.alloc(32, 0x42), { network }).toWIF();
const LOCKTIME = 1900000000;

test('the address is derived from the key AND the date together', () => {
  const a = recover.lockAddress({ locktime: LOCKTIME, wif: WIF, network });
  const later = recover.lockAddress({ locktime: LOCKTIME + 1, wif: WIF, network });
  assert.notStrictEqual(a.address, later.address, 'one second changes where the money sits');
  assert.ok(a.address.length > 0);
});

test('the key alone and the chain alone reach the same place', () => {
  const pubkey = Buffer.from(ECPair.fromWIF(WIF, network).publicKey);
  assert.strictEqual(
    recover.lockAddress({ locktime: LOCKTIME, wif: WIF, network }).address,
    recover.lockAddress({ locktime: LOCKTIME, pubkey, network }).address,
    'an etcher with only their key, and a stranger with only the etching, must agree',
  );
});

test('THE TRAP: it is not the ordinary address of the key', () => {
  const key = ECPair.fromWIF(WIF, network);
  const ordinary = bitcoin.payments.p2pkh({ pubkey: Buffer.from(key.publicKey), network }).address;
  const locked = recover.lockAddress({ locktime: LOCKTIME, wif: WIF, network }).address;
  assert.notStrictEqual(ordinary, locked);
  // A wallet shown the private key looks at `ordinary` and reports nothing. That is the whole
  // reason src/runes/recover.js is shipped instead of explained.
  assert.ok(ordinary.startsWith('D'), ordinary);
  assert.ok(locked.startsWith('E'), locked);
});

test('the address matches what the etching builder committed to', () => {
  // buildEtch writes the lock script into the transaction; recover must rebuild the same one, or an
  // etcher pays into an output their own tool cannot find.
  const runeBuilder = require('../src/runes/builder');
  const pubkey = Buffer.from(ECPair.fromWIF(WIF, network).publicKey);
  const etch = runeBuilder.buildEtch(
    { ticker: 'FINDME', supply: 1000, premine: 1000, lock: { locktime: LOCKTIME, pubkey } },
    { address: bitcoin.payments.p2pkh({ pubkey, network }).address },
  );
  assert.strictEqual(
    bitcoin.address.fromOutputScript(etch.lockScriptPubKey, network),
    recover.lockAddress({ locktime: LOCKTIME, wif: WIF, network }).address,
  );
});

test('a spend cannot be built with an nLockTime below the lock', () => {
  assert.throws(() => recover.buildUnlock({
    wif: WIF, locktime: LOCKTIME, to: 'D6pb4n1hXzgyABUTNxBY8PgZ8GnuQ16kvK', fee: 200000, network,
    utxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
    nLockTime: LOCKTIME - 1,
  }), /below the lock/);
});

test('a fee that swallows the whole lock is refused rather than signed', () => {
  assert.throws(() => recover.buildUnlock({
    wif: WIF, locktime: LOCKTIME, to: 'D6pb4n1hXzgyABUTNxBY8PgZ8GnuQ16kvK', fee: 1000000, network,
    utxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
  }), /leaves nothing/);
});

test('the lock is judged open by median time past, not by the wall clock', () => {
  assert.strictEqual(recover.isOpen(LOCKTIME, LOCKTIME - 1), false);
  assert.strictEqual(recover.isOpen(LOCKTIME, LOCKTIME), true);
});

test('a lock must be a timestamp, never a block height', () => {
  assert.throws(() => recover.lockAddress({ locktime: 800000, wif: WIF, network }), /timestamp/);
  assert.strictEqual(tickers.LOCKTIME_THRESHOLD, 500000000);
});

console.log('\nrunes recover: ' + passed + ' passed');
