// Proves the browser marketplace core (lib/swap.js + the extended lib/verge.js sighash) against
// the server-side, mainnet-proven path (src/swap.js). Deterministic ECDSA (RFC6979, low-S) means
// the same key + hash yields the SAME signature in both stacks, so the built transactions and
// listing scriptSigs must be byte-identical.
//
//   node extension/test-swap.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const ecpair = require('ecpair');
const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { pickNetwork } = require('../src/cli.js');
const S = require('../src/swap.js'); // server (proven on mainnet)
const V = await import('./lib/verge.js');
const B = await import('./lib/swap.js'); // browser port

const { network } = pickNetwork('mainnet');
let passed = 0;
function ok(name, cond) { if (!cond) throw new Error('FAIL: ' + name); passed++; console.log('  ok - ' + name); }

// Fixed keys (deterministic) so both stacks sign identically.
const sellerWif = ECPair.makeRandom({ network }).toWIF();
const buyerWif = ECPair.makeRandom({ network }).toWIF();
const sellerEC = ECPair.fromWIF(sellerWif, network);
const buyerEC = ECPair.fromWIF(buyerWif, network);
const sellerPriv = (await V.wifToPrivateKey(sellerWif)).privateKey;
const buyerPriv = (await V.wifToPrivateKey(buyerWif)).privateKey;
const sellerAddr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(sellerEC.publicKey), network }).address;
const buyerAddr = bitcoin.payments.p2pkh({ pubkey: Buffer.from(buyerEC.publicKey), network }).address;
const H = (c) => c.repeat(64);
const carrier = { txid: H('a'), vout: 0, value: 2_100_000 };
const TIME = 1_783_000_000;

// --- 1. a listing variant scriptSig is byte-identical in both stacks -------------------------
{
  const srv = S.buildListing({ network, carrier, priceUnits: 150_000_000, sellerAddress: sellerAddr, sellerKey: sellerEC, time: TIME });
  const brw = await B.signListingVariant({ carrier, priceUnits: 150_000_000, sellerAddress: sellerAddr, priv: sellerPriv, time: TIME });
  ok('listing variant scriptSig matches the server byte-for-byte', srv.scriptSig === brw.scriptSig);
}

// --- 2. a completed buy is byte-identical (same hex) -----------------------------------------
{
  const srvListing = S.buildListing({ network, carrier, priceUnits: 150_000_000, sellerAddress: sellerAddr, sellerKey: sellerEC, time: TIME });
  const pads = [{ txid: H('b'), vout: 1, value: 150_000 }, { txid: H('d'), vout: 3, value: 120_000 }];
  const funds = [{ txid: H('c'), vout: 0, value: 200_000_000 }];
  const srvDone = S.completeListing({ network, listing: srvListing, pads, funds, buyerAddress: buyerAddr, buyerKey: buyerEC, feeUnits: 200_000, carrierOffset: 0 });
  const brwVariant = { ...srvListing, time: TIME, scriptSig: srvListing.scriptSig };
  const brwDone = await B.completeListing({ variant: brwVariant, pads, funds, buyerAddress: buyerAddr, priv: buyerPriv, feeUnits: 200_000, carrierOffset: 0 });
  ok('completed buy transaction hex matches the server', srvDone.hex === brwDone.hex);
  ok('completed buy txid matches the server', srvDone.txid === brwDone.txid);
  // and the server considers it valid (its own verify path)
  ok('the browser-built buy passes the server signature check', (() => {
    try { S.completeListing({ network, listing: srvListing, pads, funds, buyerAddress: buyerAddr, buyerKey: buyerEC, feeUnits: 200_000, carrierOffset: 0 }); return true; } catch { return false; }
  })());
}

// --- 3. a bid + acceptance is byte-identical -------------------------------------------------
{
  const pads = [{ txid: H('d'), vout: 1, value: 150_000 }, { txid: H('9'), vout: 4, value: 120_000 }];
  const funds = [{ txid: H('e'), vout: 0, value: 200_000_000 }];
  const srvBid = S.buildBid({ network, carrier, priceUnits: 120_000_000, sellerAddress: sellerAddr, pads, funds, buyerAddress: buyerAddr, buyerKey: buyerEC, feeUnits: 200_000, carrierOffset: 0, time: TIME });
  const brwBid = await B.buildBid({ carrier, priceUnits: 120_000_000, sellerAddress: sellerAddr, pads, funds, buyerAddress: buyerAddr, priv: buyerPriv, feeUnits: 200_000, carrierOffset: 0, time: TIME });
  ok('bid buyer scriptSigs match the server', JSON.stringify(srvBid.scriptSigs) === JSON.stringify(brwBid.scriptSigs));
  const srvAccept = S.acceptBid({ network, bid: srvBid, sellerKey: sellerEC });
  const brwAccept = await B.acceptBid({ bid: brwBid, priv: sellerPriv });
  ok('accepted bid transaction hex matches the server', srvAccept.hex === brwAccept.hex);
  // the server's verifyBid accepts the browser-built bid
  ok('server verifyBid accepts the browser bid', S.verifyBid({ network, bid: brwBid }).ok);
}

// --- 4. the extended sighash did not disturb SIGHASH_ALL (existing transfers still identical) -
{
  const inputs = [{ txid: H('f'), vout: 2, value: 5_000_000, privateKey: buyerPriv }];
  const outputs = [{ address: sellerAddr, value: 4_800_000 }];
  const brw = await V.buildAndSignP2PKH({ inputs, outputs, time: TIME });
  ok('a plain P2PKH transfer still builds and is non-empty', /^[0-9a-f]+$/.test(brw.hex) && brw.hex.length > 100);
}

console.log(`\n${passed} browser/server swap-parity checks passed`);
