// The derived lock key: same twelve words, same key, four years later.
// Run: node extension/test-runelock.mjs
import { mnemonicToSeed } from './lib/bip39.js';
import { derivePrivateKey } from './lib/bip32.js';
import * as verge from './lib/verge.js';
import { LOCK_ACCOUNT, lockPath, deriveLockKey, lockPubkeys, matchPublishedLocks, nextLockIndex, timeUntil, buildRelease, lockAddress } from './lib/runelock.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const seed = await mnemonicToSeed(PHRASE);
const other = await mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');

console.log('the path');
ok(LOCK_ACCOUNT === "m/44'/77'/1'/0", 'the lock account is a hardened BIP-44 account of its own');
ok(lockPath(7) === "m/44'/77'/1'/0/7", 'and an index hangs off it');

console.log('\nderivation');
const k0 = await deriveLockKey(seed, 0);
const again = await deriveLockKey(seed, 0);
ok(k0.pubkey === again.pubkey, 'the same seed and index give the same key, every time');
ok(/^0[23][0-9a-f]{64}$/.test(k0.pubkey), 'it is a 33 byte compressed public key');

const k1 = await deriveLockKey(seed, 1);
ok(k0.pubkey !== k1.pubkey, 'a different index is a different key');

const theirs = await deriveLockKey(other, 0);
ok(k0.pubkey !== theirs.pubkey, 'a different seed is a different key');

console.log('\nthe private half never leaks unless asked');
ok(k0.privateKey === undefined, 'the default answer carries the public half only');
const withPriv = await deriveLockKey(seed, 0, { includePrivate: true });
ok(withPriv.privateKey && withPriv.privateKey.length === 32, 'and the private half comes only on request');
ok(verge.bytesToHex(verge.publicKeyFromPrivate(withPriv.privateKey)) === k0.pubkey, 'the two halves match');

console.log('\nit is a separate account from the spending keys');
const spending = await derivePrivateKey(seed, "m/44'/77'/0'/0/0");
ok(verge.bytesToHex(verge.publicKeyFromPrivate(spending)) !== k0.pubkey,
  'the lock key is never the wallet address key');

console.log('\nfinding your own locks in what the chain published');
// Every etching publishes its lock pubkey, so the whole set is public. The wallet compares locally
// and tells nobody anything.
const published = [
  { ticker: 'SOMEONEELSE', pubkey: theirs.pubkey, locktime: 2000000000 },
  { ticker: 'MINE', pubkey: k0.pubkey, locktime: 2000000000 },
  { ticker: 'ALSOMINE', pubkey: k1.pubkey, locktime: 2100000000 },
  { ticker: 'NOTALOCK', pubkey: 'ff'.repeat(33), locktime: 1 },
];
const mine = await matchPublishedLocks(seed, published, 8);
ok(mine.length === 2, 'it found both of mine and neither of the others');
ok(mine.map((m) => m.ticker).sort().join(',') === 'ALSOMINE,MINE', 'the right two');
ok(mine.find((m) => m.ticker === 'MINE').index === 0, 'and it knows which index each came from');
ok(mine.find((m) => m.ticker === 'MINE').path === lockPath(0), 'and the path to rederive it');

ok((await matchPublishedLocks(other, published, 8)).length === 1, 'the other seed sees only its own');
ok((await matchPublishedLocks(seed, [], 8)).length === 0, 'nothing published, nothing matched');
ok((await matchPublishedLocks(seed, null, 8)).length === 0, 'and a missing list does not throw');

console.log('\nnever reusing a key');
ok(nextLockIndex(mine) === 2, 'the next etch takes the index after the highest already used');
ok(nextLockIndex([]) === 0, 'a first etch starts at zero');

console.log('\nthe countdown a person reads');
const now = 1_700_000_000;
ok(timeUntil(now + 1460 * 86400, now).text === '4 years', 'a fresh lock reads as four years');
ok(timeUntil(now + 400 * 86400, now).text.startsWith('1 year'), 'and a year and a bit reads that way');
ok(timeUntil(now + 3 * 86400, now).text === '3 days', 'days when it is days');
ok(timeUntil(now - 1, now).open === true, 'and it says so once it is open');



// --- the release, against the node implementation -------------------------------------------------
//
// Two implementations of the same transaction: this one, where the key lives, and
// src/runes/recover.js, which the CLI and the offline recovery kit use. They must agree byte for
// byte. A disagreement here is a lock nobody can open, discovered four years too late.

console.log('\nthe pre-signed release');
const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
const recover = require_('../src/runes/recover.js');
const releaseMod = require_('../src/runes/release.js');
const { ECPair, toBitcoinjsNetwork } = require_('../src/builder.js');
const { mainnet } = require_('../src/networks.js');
const bjsNet = toBitcoinjsNetwork(mainnet);

const { privateKey } = await deriveLockKey(seed, 3, { includePrivate: true });
const wif = await verge.privateKeyToWIF(privateKey, verge.NETWORKS.mainnet);
const homePriv = await derivePrivateKey(seed, "m/44'/77'/0'/0/0");
const home = await verge.addressFromPrivate(homePriv, verge.NETWORKS.mainnet);

const LOCKTIME = 1_800_000_000;
const FUND = 'ab'.repeat(32);
const VALUE = 2500 * 1_000_000;
const FEE = 2 * 1_000_000;
const TIME = 1_700_000_000;   // pinned, so the two builders serialize the same nTime

const relMine = await buildRelease(privateKey, {
  locktime: LOCKTIME, txid: FUND, vout: 1, value: VALUE, to: home, fee: FEE,
  network: verge.NETWORKS.mainnet, time: TIME,
});

const relNode = recover.buildUnlock({
  wif, locktime: LOCKTIME, network: bjsNet, to: home, fee: FEE, time: TIME,
  utxos: [{ txid: FUND, vout: 1, value: VALUE }],
});
ok(relMine.hex === relNode.hex, 'the extension and the node build the same release, byte for byte');
ok(relMine.txid === relNode.txid, 'down to the same transaction id');

// Verge signs over nTime, so a builder that stamps the wall clock cannot be reproduced. Both sides
// take the time as an input now, and this is the check that keeps it that way.
const later = recover.buildUnlock({
  wif, locktime: LOCKTIME, network: bjsNet, to: home, fee: FEE, time: TIME + 1,
  utxos: [{ txid: FUND, vout: 1, value: VALUE }],
});
ok(later.hex !== relNode.hex, 'and a different nTime really does change the transaction');

const spk = Buffer.from((await lockAddress(LOCKTIME, verge.publicKeyFromPrivate(privateKey), verge.NETWORKS.mainnet)).redeem);
const { default: bitcoin } = await import('bitcoinjs-lib');
const lockAddr = (await lockAddress(LOCKTIME, verge.publicKeyFromPrivate(privateKey), verge.NETWORKS.mainnet)).address;
ok(lockAddr === recover.lockAddress({ locktime: LOCKTIME, wif, network: bjsNet }).address,
  'and the same lock address, so both agree where the money is');

const v = releaseMod.verifyRelease({
  hex: relMine.hex,
  lockScriptPubKey: bitcoin.address.toOutputScript(lockAddr, bjsNet),
  lockValue: VALUE, network: bjsNet,
});
ok(v.ok === true, 'the independent verifier accepts what the extension signed' + (v.ok ? '' : ': ' + v.reason));
ok(v.to === home, 'and it pays the wallet own address');

let threw = false;
try { await buildRelease(privateKey, { locktime: LOCKTIME, txid: FUND, vout: 1, value: 100, to: home, fee: 200, network: verge.NETWORKS.mainnet }); }
catch (_) { threw = true; }
ok(threw, 'a fee bigger than the lock is refused rather than signed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
