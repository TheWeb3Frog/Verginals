// Output-script selection by address type (lib/verge.js outputScript).
//
//   node extension/test-address.mjs
//
// Why this file exists. Every output used to be built with p2pkhScript(), which ignores the
// address version byte. Paying a P2SH address ('E...' on Verge mainnet, a multisig treasury say)
// therefore wrapped a SCRIPT hash in a P2PKH script: an output demanding a private key for a hash
// that is not a public-key hash, i.e. coins destroyed with no way back. The first test below
// reproduces exactly that, so if the dispatch is ever removed the failure is visible rather than
// silent.
//
// bitcoinjs-lib is used as an independent oracle: our hand-rolled Uint8Array scripts must match
// what a mature library produces for the same address, byte for byte.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bitcoin = require('bitcoinjs-lib');
const { mainnet, testnet } = require('../src/networks.js');

const V = await import('./lib/verge.js');
const E = await import('./lib/electrum.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); }
}
const bjs = (n) => ({
  messagePrefix: n.messagePrefix, bech32: n.bech32, bip32: n.bip32,
  pubKeyHash: n.pubKeyHash, scriptHash: n.scriptHash, wif: n.wif,
});
const hex = (u8) => V.bytesToHex(u8);
const oracle = (addr, net) => bitcoin.address.toOutputScript(addr, bjs(net)).toString('hex');

// A real Verge mainnet 2-of-3 P2SH address, produced by `createmultisig` on verge 26.5.0. The
// exact shape a multisig treasury would use. Mainnet scriptHash is 33 (0x21), giving an 'E' prefix.
const P2SH_MAIN = 'EewdNAAk84J6E7gHcekX1wsVLUC7Dgtmxa';
const P2PKH_MAIN = 'DU8rvf7eHDwyvshWGJMqBduPRs1X6K652M';

console.log('address -> output script\n');

// --- the regression the whole change exists for ------------------------------------------------
{
  const correct = hex(await V.outputScript(P2SH_MAIN));
  const oldWay = hex(await V.p2pkhScript(P2SH_MAIN)); // what every output used to be built with
  ok('P2SH address does NOT get a P2PKH script', correct !== oldWay,
    `both produced ${correct}`);
  ok('the old path really did produce an unspendable script', oldWay.startsWith('76a914') && oldWay.endsWith('88ac'),
    oldWay);
  ok('P2SH script is OP_HASH160 <20> OP_EQUAL', /^a914[0-9a-f]{40}87$/.test(correct), correct);
}

// --- agreement with bitcoinjs-lib --------------------------------------------------------------
{
  ok('mainnet P2SH matches bitcoinjs', hex(await V.outputScript(P2SH_MAIN)) === oracle(P2SH_MAIN, mainnet),
    `${hex(await V.outputScript(P2SH_MAIN))} vs ${oracle(P2SH_MAIN, mainnet)}`);
  ok('mainnet P2PKH matches bitcoinjs', hex(await V.outputScript(P2PKH_MAIN)) === oracle(P2PKH_MAIN, mainnet),
    `${hex(await V.outputScript(P2PKH_MAIN))} vs ${oracle(P2PKH_MAIN, mainnet)}`);
}

// --- P2PKH behaviour is unchanged ---------------------------------------------------------------
{
  ok('P2PKH addresses route exactly as before',
    hex(await V.outputScript(P2PKH_MAIN)) === hex(await V.p2pkhScript(P2PKH_MAIN)));
}

// --- testnet, both shapes -----------------------------------------------------------------------
{
  const h20 = Buffer.alloc(20, 0x42);
  const tP2PKH = bitcoin.address.toBase58Check(h20, testnet.pubKeyHash);
  const tP2SH = bitcoin.address.toBase58Check(h20, testnet.scriptHash);
  ok('testnet P2PKH matches bitcoinjs', hex(await V.outputScript(tP2PKH)) === oracle(tP2PKH, testnet));
  ok('testnet P2SH matches bitcoinjs', hex(await V.outputScript(tP2SH)) === oracle(tP2SH, testnet));
  ok('testnet P2SH is not confused with mainnet P2PKH',
    hex(await V.outputScript(tP2SH)) !== hex(await V.outputScript(P2PKH_MAIN)));
}

// --- unknown version bytes are refused, never guessed --------------------------------------------
{
  const stranger = bitcoin.address.toBase58Check(Buffer.alloc(20, 0x11), 0x05); // Bitcoin P2SH
  let threw = null;
  try { await V.outputScript(stranger); } catch (e) { threw = e; }
  ok('an unknown version byte throws instead of guessing', threw !== null && /unknown version byte/.test(threw.message),
    threw ? threw.message : 'no throw');
}

// --- the whole builder, not just the helper ------------------------------------------------------
{
  const priv = V.generatePrivateKey();
  const from = await V.addressFromPubkey(V.publicKeyFromPrivate(priv));
  const built = await V.buildAndSignP2PKH({
    inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 5_000_000, privateKey: priv }],
    outputs: [{ address: P2SH_MAIN, value: 1_000_000 }, { address: from, value: 3_800_000 }],
    time: 1_700_000_000,
  });
  ok('a built tx pays a P2SH address with a real P2SH script', built.hex.includes(oracle(P2SH_MAIN, mainnet)),
    'P2SH scriptPubKey missing from the serialized tx');
  ok('the same tx still pays P2PKH change correctly', built.hex.includes(oracle(from, mainnet)));
}

// --- ElectrumX lookups ask for the right script ---------------------------------------------------
{
  const shP2SH = await E.addressToScripthash(P2SH_MAIN);
  const shP2PKH = await E.addressToScripthash(P2PKH_MAIN);
  ok('scripthash differs by address shape', shP2SH !== shP2PKH);
  // Electrum scripthash = reverse(sha256(scriptPubKey)); derive it independently from the oracle.
  const { createHash } = require('node:crypto');
  const expect = createHash('sha256').update(Buffer.from(oracle(P2SH_MAIN, mainnet), 'hex')).digest()
    .reverse().toString('hex');
  ok('P2SH scripthash is computed over the P2SH script', shP2SH === expect, `${shP2SH} vs ${expect}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
