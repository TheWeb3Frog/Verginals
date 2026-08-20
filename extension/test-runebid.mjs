// The wallet fills a bid without a server, and agrees with the node byte for byte.
//
// The differential test is the point of this file. runebid.js carries a PORT of the indexer's
// assignment rules, and a port is a second copy of something that has to agree with the first
// forever. Both are run over the same cases and compared, including the cases that are easy to get
// wrong: a missing runestone, an edict for more than is there, an edict naming a dust output.
//
// Run: node extension/test-runebid.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli.js');
const { RuneState, applyTx, outpoint, runeRefOf } = require('../src/runes/indexer.js');
const codec = require('../src/runes/codec.js');
const nodeBid = require('../src/runes/bid.js');
const nodeOrder = require('../src/runes/order.js');

import * as ext from './lib/runebid.js';
import { DUST_UNITS } from './lib/runes.js';

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const scriptOf = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).output.toString('hex');
const H = (c) => c.repeat(64);
const REF = runeRefOf(9444444, 3);
const REF2 = runeRefOf(9444444, 8);
const NOW = 1_787_000_000;

// --- the differential ----------------------------------------------------------------------------
console.log('the assignment rules, ported and compared');

/** Run the node's real indexer over a synthetic transaction and report where the runes landed. */
function nodeAllocate(payload, outputs, pooled, dust) {
  const s = new RuneState();
  const src = { txid: H('e'), vout: 0 };
  for (const [ref, amt] of Object.entries(pooled)) s.credit(outpoint(src.txid, src.vout), ref, amt);
  const id = H('d');
  applyTx(s, {
    txid: id, height: 9_500_001, txIndex: 0,
    inputs: [src],
    outputs: outputs.map((o) => ({
      value: o.value,
      scriptPubKey: Buffer.from(o.script),
      isOpReturn: o.script[0] === 0x6a,
      opReturnData: o.script[0] === 0x6a && payload ? Buffer.from(payload) : undefined,
    })),
  }, { dustUnits: dust });
  const out = {};
  for (const e of s.entries()) {
    const [, i] = [e.outpoint.slice(0, 64), Number(e.outpoint.split(':')[1])];
    (out[i] || (out[i] = {}))[e.runeRef] = e.amount;
  }
  return out;
}

const opret = (payload) => new Uint8Array([0x6a, payload.length, ...payload]);
const pay = (edicts) => new Uint8Array(codec.encodeEdicts(edicts));
const p2pkh = (k) => new Uint8Array(Buffer.from(scriptOf(k), 'hex'));

ok('the wallet and the indexer place runes identically, across the awkward cases', (() => {
  const cases = [
    // a plain split, the ordinary case
    { p: pay([{ runeRef: REF, amount: 37_000, output: 2 }]), pool: { [REF]: 1_000_000 } },
    // no runestone at all: everything falls to the first eligible output
    { p: null, pool: { [REF]: 500 } },
    // an edict for more than is pooled: capped, never invented
    { p: pay([{ runeRef: REF, amount: 9_000_000, output: 2 }]), pool: { [REF]: 40 } },
    // amount 0 means all the rest
    { p: pay([{ runeRef: REF, amount: 0, output: 2 }]), pool: { [REF]: 1_234 } },
    // an edict naming an output below dust: skipped, and the fallback picks it up
    { p: pay([{ runeRef: REF, amount: 100, output: 4 }]), pool: { [REF]: 900 } },
    // an edict naming the OP_RETURN itself
    { p: pay([{ runeRef: REF, amount: 100, output: 0 }]), pool: { [REF]: 900 } },
    // an edict naming an output past the end
    { p: pay([{ runeRef: REF, amount: 100, output: 9 }]), pool: { [REF]: 900 } },
    // two runes, one named
    { p: pay([{ runeRef: REF, amount: 10, output: 2 }]), pool: { [REF]: 50, [REF2]: 77 } },
    // a rune the edict names but nobody holds
    { p: pay([{ runeRef: REF2, amount: 10, output: 2 }]), pool: { [REF]: 50 } },
    // garbage where the message should be
    { p: new Uint8Array([0xff, 0xff, 0xff]), pool: { [REF]: 600 } },
  ];
  for (const c of cases) {
    const outputs = [
      { value: 0, script: c.p ? opret(c.p) : new Uint8Array([0x6a, 0x01, 0x00]) },
      { value: DUST_UNITS, script: p2pkh(seller) },
      { value: DUST_UNITS, script: p2pkh(buyer) },
      { value: 5_000_000, script: p2pkh(seller) },
      { value: DUST_UNITS - 1, script: p2pkh(buyer) }, // below dust, never eligible
    ];
    const mine = ext.allocate(c.p, outputs, c.pool, DUST_UNITS);
    const theirs = nodeAllocate(c.p, outputs, c.pool, DUST_UNITS);
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      console.log('    disagreed on', JSON.stringify(c.pool), '\n      wallet ', JSON.stringify(mine), '\n      indexer', JSON.stringify(theirs));
      return false;
    }
  }
  return true;
})());

ok('CONTROL: a deliberately wrong port is caught by that comparison', (() => {
  // Without this the comparison could be passing for the wrong reason. Break the fallback rule the
  // way a careless port would, by sending leftovers to the last eligible output instead of the first.
  const outputs = [
    { value: 0, script: opret(pay([{ runeRef: REF, amount: 10, output: 2 }])) },
    { value: DUST_UNITS, script: p2pkh(seller) },
    { value: DUST_UNITS, script: p2pkh(buyer) },
  ];
  const pool = { [REF]: 100 };
  const theirs = nodeAllocate(null, outputs, pool, DUST_UNITS);
  const wrong = { 2: { [REF]: 100 } }; // last eligible instead of first
  return JSON.stringify(theirs) !== JSON.stringify(wrong);
})());

// --- the whole flow ------------------------------------------------------------------------------
console.log('\nfilling a bid with no server');

const carrier = { txid: H('a'), vout: 1, value: DUST_UNITS, script: scriptOf(seller) };
const chain = [{ ...carrier, runes: { [REF]: 50_000 }, height: 9_500_000 }];
const order = nodeOrder.signOrder({
  network, runeRef: REF, sell: 50_000, minPrice: { units: 720, per: 1 },
  key: seller, nonce: 'n1', expiresAt: NOW + 3600,
});
const price = nodeOrder.priceFor(order, 10_000);
const bid = nodeBid.buildRuneBid({
  network, carriers: [carrier], runeRef: REF, amount: 10_000, priceUnits: price,
  buyerAddress: addr(buyer), buyerKey: buyer,
  funds: [{ txid: H('b'), vout: 0, value: price + DUST_UNITS + 1_000_000 }],
  feeUnits: 200_000, time: NOW,
});

ok('the wallet accepts a bid the node built', (await ext.verifyRuneBid({ bid, onChain: chain })).ok);
ok('the node agrees with it', nodeBid.verifyRuneBid({ network, bid, onChain: chain }).ok);

ok('the wallet reads a node-signed standing order', (await ext.verifyOrder(order, NOW)).ok);
ok('the wallet sees an expired order as expired', !(await ext.verifyOrder(order, NOW + 4000)).ok);
ok('the wallet refuses an order whose key does not match its address',
  !(await ext.verifyOrder({ ...order, address: addr(buyer) }, NOW)).ok);

ok('the gate agrees on a good fill', (await ext.fillsOrder({ order, bid, onChain: chain, now: NOW })).ok);

const evil = nodeBid.buildRuneBid({
  network, carriers: [carrier], runeRef: REF, amount: 10_000, priceUnits: price,
  marketFeeUnits: Math.floor(price * 0.9), feeAddress: addr(buyer),
  buyerAddress: addr(buyer), buyerKey: buyer,
  funds: [{ txid: H('b'), vout: 0, value: price + DUST_UNITS + 1_000_000 }],
  feeUnits: 200_000, time: NOW,
});
const evilInWallet = await ext.fillsOrder({ order, bid: evil, onChain: chain, now: NOW });
const evilInNode = nodeOrder.fillsOrder({ network, order, bid: evil, onChain: chain, now: NOW, alreadySold: 0 });
ok('THE FEE ATTACK is refused in the wallet too', !evilInWallet.ok && /under this order's floor/.test(evilInWallet.reason));
ok('and the wallet and the node refuse it for the same reason', !evilInNode.ok && evilInNode.reason.includes('under this order'));

console.log('\nsigning, compared byte for byte');

const wallet = await ext.acceptRuneBid({ bid, priv: Buffer.from(seller.privateKey) });
const node = nodeBid.acceptRuneBid({ network, bid, sellerKey: seller });

ok('the wallet and the node produce the same transaction id', wallet.txid === node.txid);
ok('and the same change outpoint', wallet.changeOutpoint === node.changeOutpoint);
ok('and the same bytes, signature included', wallet.hex === node.hex);

ok('the wallet refuses to sign with an account that does not own the carriers', await (async () => {
  try { await ext.acceptRuneBid({ bid, priv: Buffer.from(buyer.privateKey) }); return false; }
  catch (e) { return /does not own the carriers/.test(e.message); }
})());

console.log('\nwhat the wallet refuses');
for (const [what, tamper] of [
  ['a redirected payment', (x) => { x.vout[3].script = scriptOf(buyer); }],
  ['a skimmed payment', (x) => { x.vout[3].value -= 1; }],
  ['a stolen change output', (x) => { x.vout[1].script = scriptOf(buyer); }],
  ['an inflated amount', (x) => { x.amount += 1; }],
  ['a mislabelled carrier', (x) => { x.carriers[0] = { ...x.carriers[0], txid: H('7') }; }],
  ['a pre-signed carrier input', (x) => { x.scriptSigs[0] = x.scriptSigs[1]; }],
]) {
  const evil = JSON.parse(JSON.stringify(bid));
  tamper(evil);
  const r = await ext.verifyRuneBid({ bid: evil, onChain: chain });
  ok(what + ' is refused', !r.ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
