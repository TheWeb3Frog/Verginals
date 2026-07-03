// Proves the browser wallet core (lib/verge.js) against the server-side path
// (src/vergetx.js + bitcoinjs/ecpair) and against libsecp verification.
//
//   node extension/test-verge.mjs
//
// Checks: base58check roundtrip, WIF import matches ecpair, address derivation matches bitcoinjs,
// tx serialization byte-identical to src/vergetx.js, sighash identical, DER signature verifies
// under libsecp, and a full transfer tx is well-formed + every input signature verifies.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const ecpair = require('ecpair');
const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const vergetx = require('../src/vergetx.js');
const { mainnet } = require('../src/networks.js');

const V = await import('./lib/verge.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } }
const eqHex = (a, b) => a.toLowerCase() === b.toLowerCase();

// bitcoinjs network object for Verge mainnet
const net = {
  messagePrefix: mainnet.messagePrefix, bech32: mainnet.bech32, bip32: mainnet.bip32,
  pubKeyHash: mainnet.pubKeyHash, scriptHash: mainnet.scriptHash, wif: mainnet.wif,
};

// --- Fixed test key (deterministic) ---
const privHex = '1111111111111111111111111111111111111111111111111111111111111111';
const priv = V.hexToBytes(privHex);
const kp = ECPair.fromPrivateKey(Buffer.from(priv), { network: net });

// 1. pubkey matches
const pubOurs = V.bytesToHex(V.publicKeyFromPrivate(priv));
const pubRef = Buffer.from(kp.publicKey).toString('hex');
ok('compressed pubkey matches bitcoinjs', eqHex(pubOurs, pubRef), `${pubOurs} vs ${pubRef}`);

// 2. address matches bitcoinjs p2pkh
const addrOurs = await V.addressFromPrivate(priv, V.NETWORKS.mainnet);
const addrRef = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: net }).address;
ok('P2PKH address matches bitcoinjs', addrOurs === addrRef, `${addrOurs} vs ${addrRef}`);

// 3. WIF export matches ecpair, and re-import roundtrips
const wifOurs = await V.privateKeyToWIF(priv, V.NETWORKS.mainnet);
const wifRef = kp.toWIF();
ok('WIF export matches ecpair', wifOurs === wifRef, `${wifOurs} vs ${wifRef}`);
const back = await V.wifToPrivateKey(wifOurs);
ok('WIF import roundtrips priv', eqHex(V.bytesToHex(back.privateKey), privHex) && back.compressed === true);

// 4. p2pkhScript matches bitcoinjs
const scriptOurs = V.bytesToHex(await V.p2pkhScript(addrOurs));
const scriptRef = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: net }).output.toString('hex');
ok('p2pkhScript matches bitcoinjs', eqHex(scriptOurs, scriptRef), `${scriptOurs} vs ${scriptRef}`);

// 5. serialization byte-identical to src/vergetx.js
const sampleTx = {
  version: 1, time: 1700000000, locktime: 0,
  vin: [{ txid: 'aa'.repeat(32), vout: 1, sequence: 0xffffffff, script: Buffer.alloc(0) }],
  vout: [{ value: 12345678, script: Buffer.from(scriptRef, 'hex') }],
};
const serRef = vergetx.serializeTx(sampleTx).toString('hex');
const serOurs = V.bytesToHex(V.serializeTx({
  version: 1, time: 1700000000, locktime: 0,
  vin: [{ txid: 'aa'.repeat(32), vout: 1, sequence: 0xffffffff, script: new Uint8Array(0) }],
  vout: [{ value: 12345678, script: V.hexToBytes(scriptRef) }],
}));
ok('serializeTx byte-identical to vergetx.js', eqHex(serOurs, serRef), `\n    ours=${serOurs}\n    ref =${serRef}`);

// 6. legacy sighash identical to src/vergetx.js
const scriptCode = Buffer.from(scriptRef, 'hex');
const shRef = vergetx.legacySighash(sampleTx, 0, scriptCode, vergetx.SIGHASH_ALL).toString('hex');
const shOurs = V.bytesToHex(await V.legacySighash({
  version: 1, time: 1700000000, locktime: 0,
  vin: [{ txid: 'aa'.repeat(32), vout: 1, sequence: 0xffffffff }],
  vout: [{ value: 12345678, script: V.hexToBytes(scriptRef) }],
}, 0, V.hexToBytes(scriptRef), 0x01));
ok('legacySighash identical to vergetx.js', eqHex(shOurs, shRef), `\n    ours=${shOurs}\n    ref =${shRef}`);

// 7. DER signature over that sighash verifies under libsecp, and is low-S
const sigFull = await V.signHash(V.hexToBytes(shRef), priv);
const sigDer = sigFull.slice(0, sigFull.length - 1); // strip hashType byte
ok('signature hashType byte is SIGHASH_ALL', sigFull[sigFull.length - 1] === 0x01);
const verified = ecc.verify(Buffer.from(shRef, 'hex'), Buffer.from(kp.publicKey), derToCompact(sigDer));
ok('DER signature verifies under libsecp', verified);
ok('signature is low-S', isLowS(sigDer));

// 8. Full inscription transfer: well-formed, every input signature verifies, ordinal-safe layout
const carrierKey = ECPair.fromPrivateKey(Buffer.from(V.hexToBytes('22'.repeat(32))), { network: net });
const funderKey = ECPair.fromPrivateKey(Buffer.from(V.hexToBytes('33'.repeat(32))), { network: net });
const carrierAddr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(carrierKey.publicKey), network: net }).address;
const recipient = await V.addressFromPrivate(V.hexToBytes('44'.repeat(32)), V.NETWORKS.mainnet);

const transfer = await V.buildInscriptionTransfer({
  carrier: { txid: 'bb'.repeat(32), vout: 0, value: 3_000_000, privateKey: V.hexToBytes('22'.repeat(32)) },
  funders: [
    { txid: 'cc'.repeat(32), vout: 2, value: 5_000_000, privateKey: V.hexToBytes('33'.repeat(32)) },
    { txid: 'dd'.repeat(32), vout: 0, value: 9_000_000, privateKey: V.hexToBytes('55'.repeat(32)), inscription: { id: 'other' } },
  ],
  toAddress: recipient,
  changeAddress: carrierAddr,
  feePerKb: 200000,
  time: 1700000001,
});
ok('transfer produced hex + txid', typeof transfer.hex === 'string' && transfer.txid.length === 64);

// Decode it back with bitcoinjs to sanity-check structure (bitcoinjs won't parse nTime, so parse manually)
const parsed = parseVergeTx(V.hexToBytes(transfer.hex));
ok('carrier is input 0', parsed.vin[0].txid === 'bb'.repeat(32) && parsed.vin[0].vout === 0);
ok('did NOT use the inscription funder', parsed.vin.every((i) => i.txid !== 'dd'.repeat(32)));
ok('carrier value preserved on output 0', parsed.vout[0].value === 3_000_000);
ok('output 0 pays the recipient', eqHex(parsed.vout[0].scriptHex, V.bytesToHex(await V.p2pkhScript(recipient))));

// verify every input signature against its own key + sighash
const keysByTxid = {
  ['bb'.repeat(32)]: { kp: carrierKey, priv: '22'.repeat(32) },
  ['cc'.repeat(32)]: { kp: funderKey, priv: '33'.repeat(32) },
};
let allSigsOk = true;
for (let i = 0; i < parsed.vin.length; i++) {
  const info = keysByTxid[parsed.vin[i].txid];
  const scriptCodeI = bitcoin.payments.p2pkh({ pubkey: Buffer.from(info.kp.publicKey), network: net }).output;
  // rebuild the unsigned view for sighash
  const txForHash = {
    version: parsed.version, time: parsed.time, locktime: parsed.locktime,
    vin: parsed.vin.map((v) => ({ txid: v.txid, vout: v.vout, sequence: v.sequence, script: Buffer.alloc(0) })),
    vout: parsed.vout.map((o) => ({ value: o.value, script: Buffer.from(o.scriptHex, 'hex') })),
  };
  const sh = vergetx.legacySighash(txForHash, i, scriptCodeI, vergetx.SIGHASH_ALL);
  const sig = parsed.vin[i].sigDer;
  if (!ecc.verify(sh, Buffer.from(info.kp.publicKey), derToCompact(sig))) allSigsOk = false;
}
ok('every input signature verifies under its key', allSigsOk);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// ---------------- helpers ----------------
function isLowS(der) {
  const { s } = decodeDer(der);
  const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  return BigInt('0x' + Buffer.from(s).toString('hex')) <= N / 2n;
}
function decodeDer(der) {
  // 0x30 len 0x02 rlen r 0x02 slen s
  let i = 2;
  if (der[i] !== 0x02) throw new Error('bad der');
  const rlen = der[i + 1]; i += 2;
  const r = der.slice(i, i + rlen); i += rlen;
  if (der[i] !== 0x02) throw new Error('bad der');
  const slen = der[i + 1]; i += 2;
  const s = der.slice(i, i + slen);
  return { r, s };
}
function derToCompact(der) {
  let { r, s } = decodeDer(der);
  const strip = (x) => { let a = Buffer.from(x); while (a.length > 32 && a[0] === 0) a = a.slice(1); return a; };
  const pad = (x) => { const b = Buffer.alloc(32); Buffer.from(x).copy(b, 32 - x.length); return b; };
  return Buffer.concat([pad(strip(r)), pad(strip(s))]);
}
function parseVergeTx(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let o = 0;
  const version = dv.getInt32(o, true); o += 4;
  const time = dv.getUint32(o, true); o += 4;
  const readVarint = () => {
    const first = bytes[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) { const v = dv.getUint16(o, true); o += 2; return v; }
    if (first === 0xfe) { const v = dv.getUint32(o, true); o += 4; return v; }
    const v = Number(dv.getBigUint64(o, true)); o += 8; return v;
  };
  const vinLen = readVarint();
  const vin = [];
  for (let i = 0; i < vinLen; i++) {
    const txidLE = bytes.slice(o, o + 32); o += 32;
    const txid = Buffer.from(txidLE).reverse().toString('hex');
    const vout = dv.getUint32(o, true); o += 4;
    const scriptLen = readVarint();
    const script = bytes.slice(o, o + scriptLen); o += scriptLen;
    const sequence = dv.getUint32(o, true); o += 4;
    // scriptSig = pushData(sig+hashtype) pushData(pubkey); extract first push as sig
    const sigPushLen = script[0];
    const sigWithHash = script.slice(1, 1 + sigPushLen);
    const sigDer = Buffer.from(sigWithHash.slice(0, sigWithHash.length - 1));
    vin.push({ txid, vout, sequence, sigDer });
  }
  const voutLen = readVarint();
  const vout = [];
  for (let i = 0; i < voutLen; i++) {
    const value = Number(dv.getBigInt64(o, true)); o += 8;
    const scriptLen = readVarint();
    const script = bytes.slice(o, o + scriptLen); o += scriptLen;
    vout.push({ value, scriptHex: Buffer.from(script).toString('hex') });
  }
  const locktime = dv.getUint32(o, true); o += 4;
  return { version, time, locktime, vin, vout };
}
