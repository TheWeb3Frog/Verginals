// Validates the HD stack (bip39.js + bip32.js) against the canonical published test vectors, so we
// KNOW a mnemonic here derives exactly what every other wallet derives before any coin depends on it.
//   - BIP-39: Trezor vector (all-zero 128-bit entropy + passphrase "TREZOR").
//   - BIP-32: Test Vector 1 (seed 000102...0f), master + m/0' + m/0'/1/2'/2/1000000000.
// Then an end-to-end check: mnemonic -> seed -> m/44'/77'/0'/0/0 -> a valid Verge P2PKH address,
// and determinism (same phrase -> same address).

import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeed, generateMnemonic, validateMnemonic } from './lib/bip39.js';
import { masterFromSeed, derivePath, derivePrivateKey } from './lib/bip32.js';
import * as verge from './lib/verge.js';

let pass = 0, fail = 0;
const hex = (b) => Buffer.from(b).toString('hex');
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

// --- BIP-39 Trezor vector -----------------------------------------------------
console.log('BIP-39 (Trezor vector):');
{
  const entropy = new Uint8Array(16); // all zeros
  const m = await entropyToMnemonic(entropy);
  ok(m === 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
     'entropy 0x00..00 -> expected 12-word mnemonic');
  const seed = await mnemonicToSeed(m, 'TREZOR');
  ok(hex(seed) === 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
     'mnemonic + "TREZOR" -> expected 64-byte seed');
  ok(hex(await mnemonicToEntropy(m)) === '00000000000000000000000000000000', 'round-trips back to entropy');
  ok((await validateMnemonic(m)) === true, 'valid phrase accepted');
  ok((await validateMnemonic(m.replace('about', 'abandon'))) === false, 'bad checksum rejected');
}

// --- BIP-32 Test Vector 1 -----------------------------------------------------
console.log('\nBIP-32 (Test Vector 1):');
{
  const seed = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  const master = await masterFromSeed(seed);
  ok(hex(master.privateKey) === 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'master private key');
  ok(hex(master.chainCode) === '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508', 'master chain code');

  const m0h = await derivePath(seed, "m/0'");
  ok(hex(m0h.privateKey) === 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea', "m/0' private key");
  ok(hex(m0h.chainCode) === '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141', "m/0' chain code");

  const full = await derivePath(seed, "m/0'/1/2'/2/1000000000");
  ok(hex(full.privateKey) === '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8', "m/0'/1/2'/2/1000000000 private key (normal+hardened mix)");
  ok(hex(full.chainCode) === 'c783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e', 'full path chain code');
}

// --- end-to-end: mnemonic -> Verge address ------------------------------------
console.log('\nend-to-end (mnemonic -> Verge address):');
{
  const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await mnemonicToSeed(m, '');
  const priv = await derivePrivateKey(seed, "m/44'/77'/0'/0/0");
  const addr = await verge.addressFromPrivate(priv, verge.NETWORKS.mainnet);
  ok(/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr), `derives a valid Verge P2PKH address (${addr})`);
  // determinism
  const priv2 = await derivePrivateKey(await mnemonicToSeed(m, ''), "m/44'/77'/0'/0/0");
  ok(hex(priv) === hex(priv2), 'same phrase -> same key (deterministic)');
  // a fresh random 12-word phrase validates + derives
  const g = await generateMnemonic(128);
  ok((await validateMnemonic(g)) && g.split(' ').length === 12, 'generateMnemonic(128) -> valid 12 words');
  const g24 = await generateMnemonic(256);
  ok((await validateMnemonic(g24)) && g24.split(' ').length === 24, 'generateMnemonic(256) -> valid 24 words');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
