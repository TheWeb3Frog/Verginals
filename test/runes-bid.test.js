// A resting rune limit order: exact amount, exact price, and a partial fill of a carrier far bigger
// than the order.
//
// Two of these tests are load-bearing rather than descriptive, and if either stops holding the design
// is wrong rather than merely broken:
//   - "the default assignment favours the seller" proves the output ORDER is a safety property.
//   - "an underfilled carrier is refused" proves naming the outpoint is what makes a bid safe.
//
// Run: node test/runes-bid.test.js
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecpair = require('ecpair');
const ecc = require('tiny-secp256k1');
const { pickNetwork } = require('../src/cli');
const { legacySighash, SIGHASH_ALL, SIGHASH_SINGLE, SIGHASH_ANYONECANPAY, txid } = require('../src/vergetx');
const { parseTx } = require('../src/runes/release');
const codec = require('../src/runes/codec');
const { RuneState, applyTx, outpoint, runeRefOf } = require('../src/runes/indexer');
const {
  buildRuneBid, verifyRuneBid, acceptRuneBid, bidTx,
  CARRIER_INPUT, RUNESTONE, CHANGE_OUTPUT, TAKE_OUTPUT, PAY_OUTPUT, DUST_UNITS,
} = require('../src/runes/bid');

const ECPair = (ecpair.ECPairFactory || ecpair.default)(ecc);
const { network } = pickNetwork('mainnet');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const seller = ECPair.makeRandom({ network });
const buyer = ECPair.makeRandom({ network });
const addr = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).address;
const scriptOf = (k) => bitcoin.payments.p2pkh({ pubkey: Buffer.from(k.publicKey), network }).output.toString('hex');
const H = (c) => c.repeat(64);

const REF = runeRefOf(9444444, 3);
const REF2 = runeRefOf(9444444, 7);
const HELD = 1_000_000;
const WANT = 37_000;
const PRICE = 30_000_000; // 30 XVG

const carrier = { txid: H('a'), vout: 1, value: DUST_UNITS, script: scriptOf(seller) };
const funds = [{ txid: H('b'), vout: 0, value: PRICE + DUST_UNITS + 1_000_000 }];
const onChain = { ...carrier, runes: { [REF]: HELD }, height: 9_500_000 };

const mkBid = (over = {}) => buildRuneBid(Object.assign({
  network, carrier, runeRef: REF, amount: WANT, priceUnits: PRICE,
  buyerAddress: addr(buyer), buyerKey: buyer, funds, feeUnits: 200_000, time: 1_787_000_000,
}, over));

// ---------------------------------------------------------------------------------------------
test('a small bid partially fills a carrier 27 times its size', () => {
  const bid = mkBid();
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.gives, WANT);
  assert.strictEqual(r.keeps, HELD - WANT);
  assert.strictEqual(r.receives, PRICE);
});

test('the indexer agrees: buyer gets exactly the amount, seller keeps the rest', () => {
  const bid = mkBid();
  const tx = bidTx(bid);
  const id = txid(tx);
  const s = new RuneState();
  s.credit(outpoint(carrier.txid, carrier.vout), REF, HELD);
  applyTx(s, {
    txid: id, height: 9_500_001, txIndex: 0,
    inputs: bid.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    outputs: bid.vout.map((o, i) => ({
      value: o.value, scriptPubKey: Buffer.from(o.script, 'hex'),
      isOpReturn: i === RUNESTONE,
      opReturnData: i === RUNESTONE ? bitcoin.script.decompile(Buffer.from(o.script, 'hex'))[1] : undefined,
    })),
  });
  assert.strictEqual(s.balanceOf(outpoint(id, TAKE_OUTPUT), REF), WANT);
  assert.strictEqual(s.balanceOf(outpoint(id, CHANGE_OUTPUT), REF), HELD - WANT);
});

test('the seller is paid at the address their carrier already sits on', () => {
  const bid = mkBid();
  const paid = bitcoin.address.fromOutputScript(Buffer.from(bid.vout[PAY_OUTPUT].script, 'hex'), network);
  assert.strictEqual(paid, addr(seller));
  assert.strictEqual(bid.vout[PAY_OUTPUT].value, PRICE);
  assert.strictEqual(bid.vout[CHANGE_OUTPUT].script, scriptOf(seller));
});

test('the carrier input is left blank and every other input is signed SIGHASH_ALL', () => {
  const bid = mkBid();
  assert.ok(!bid.scriptSigs[CARRIER_INPUT]);
  for (let i = 1; i < bid.vin.length; i++) {
    const parts = bitcoin.script.decompile(Buffer.from(bid.scriptSigs[i], 'hex'));
    assert.strictEqual(bitcoin.script.signature.decode(parts[0]).hashType, SIGHASH_ALL);
  }
});

test('acceptance produces a broadcastable transaction, checked from the wire bytes', () => {
  const bid = mkBid();
  const { hex, txid: id } = acceptRuneBid({ network, bid, sellerKey: seller });
  assert.ok(/^[0-9a-f]{64}$/.test(id));

  // Parse what would actually go on the network rather than trusting the object we just built.
  const wire = parseTx(hex);
  assert.strictEqual(wire.vin.length, bid.vin.length);
  assert.strictEqual(wire.vout.length, bid.vout.length);
  assert.strictEqual(wire.time, bid.time);

  const parts = bitcoin.script.decompile(wire.vin[CARRIER_INPUT].script);
  const decoded = bitcoin.script.signature.decode(parts[0]);
  assert.strictEqual(decoded.hashType, SIGHASH_ALL);
  assert.strictEqual(parts[1].toString('hex'), Buffer.from(seller.publicKey).toString('hex'));

  const carrierScript = bitcoin.payments.p2pkh({ pubkey: Buffer.from(seller.publicKey), network }).output;
  const sighash = legacySighash(bidTx(bid), CARRIER_INPUT, carrierScript, SIGHASH_ALL);
  assert.ok(ecc.verify(sighash, parts[1], decoded.signature), 'the seller signature on the wire verifies');
});

test('a key that does not own the carrier cannot accept', () => {
  const bid = mkBid();
  assert.throws(() => acceptRuneBid({ network, bid, sellerKey: buyer }), /does not own the carrier/);
});

// --- the two load-bearing ones -----------------------------------------------------------------
test('THE ORDER MATTERS: an unreadable runestone returns everything to the SELLER', () => {
  // Same layout, but the message cannot be decoded. The default assignment sends the pooled balance
  // to the first eligible output. That output is the seller's change, by construction, so a surprise
  // costs the seller nothing. Put the buyer's output first and this same test hands them 1,000,000
  // runes for the price of 37,000.
  const bid = mkBid();
  const id = H('c');
  const s = new RuneState();
  s.credit(outpoint(carrier.txid, carrier.vout), REF, HELD);
  applyTx(s, {
    txid: id, height: 9_500_001, txIndex: 0,
    inputs: bid.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    outputs: bid.vout.map((o, i) => ({
      value: o.value, scriptPubKey: Buffer.from(o.script, 'hex'),
      isOpReturn: i === RUNESTONE,
      opReturnData: i === RUNESTONE ? Buffer.from('ffffff', 'hex') : undefined, // garbage
    })),
  });
  assert.strictEqual(s.balanceOf(outpoint(id, CHANGE_OUTPUT), REF), HELD, 'the seller keeps it all');
  assert.strictEqual(s.balanceOf(outpoint(id, TAKE_OUTPUT), REF), 0, 'the buyer gets nothing');
});

test('THE ATTACK: a carrier holding one rune is refused, not filled at the full price', () => {
  // This is what an "any seller may fill it" bid would allow. indexer.js caps an edict at what is
  // actually there (Math.min), so an underfilled carrier would hand the buyer 1 rune and take the
  // whole price. Naming the outpoint is what makes that impossible, and this is the guard.
  const bid = mkBid();
  const thin = { ...onChain, runes: { [REF]: 1 } };
  const r = verifyRuneBid({ network, bid, onChain: thin });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /holds 1 .*asks for 37000/);
});

// --- guards -------------------------------------------------------------------------------------
test('a bid aimed at another carrier is refused', () => {
  const bid = mkBid();
  const other = { ...onChain, txid: H('d') };
  assert.strictEqual(verifyRuneBid({ network, bid, onChain: other }).ok, false);
});

test('a rune change routed anywhere but the carrier\'s own address is refused', () => {
  const bid = mkBid();
  bid.vout[CHANGE_OUTPUT].script = scriptOf(buyer);
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not return to the carrier/);
});

test('a carrier below the dust floor is refused at build time', () => {
  assert.throws(() => mkBid({ carrier: { ...carrier, value: DUST_UNITS - 1 } }), /dust floor/);
});

test('a payment sent to somebody else is refused', () => {
  const bid = mkBid();
  bid.vout[PAY_OUTPUT].script = scriptOf(buyer);
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not go to the carrier/);
});

test('a payment short of the stated price is refused', () => {
  const bid = mkBid();
  bid.vout[PAY_OUTPUT].value = PRICE - 1;
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /the payment output is/);
});

test('a pre-signed carrier input is refused', () => {
  const bid = mkBid();
  bid.scriptSigs[CARRIER_INPUT] = bid.scriptSigs[1];
  assert.strictEqual(verifyRuneBid({ network, bid, onChain }).ok, false);
});

test('a buyer input signed anything but SIGHASH_ALL is refused', () => {
  // The premise of the whole construction is that the buyer committed to EVERY output. A signature
  // with any other hash type has not, so it must not get through even though it is a real signature
  // from the real buyer over this same transaction.
  const bid = mkBid();
  const HT = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY;
  const tx = bidTx(bid);
  const pub = Buffer.from(buyer.publicKey);
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: pub, network }).output;
  const sh = legacySighash(tx, 1, p2pkh, HT);
  const sig = Buffer.from(ecc.sign(sh, Buffer.from(buyer.privateKey)));
  bid.scriptSigs[1] = bitcoin.script.compile([bitcoin.script.signature.encode(sig, HT), pub]).toString('hex');
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not signed SIGHASH_ALL/);
});

test('tampering with any output breaks the buyer signatures', () => {
  const bid = mkBid();
  bid.vout[bid.vout.length - 1].value += 1; // the buyer's own change
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not verify/);
});

test('CONTROL: the simulation is not vacuous, a validly signed wrong runestone is caught by it', () => {
  // Editing the runestone after the fact only proves the SIGNATURE check works, which is the cheap
  // one. To reach step 5 the bid has to be well formed and correctly signed and still wrong, so this
  // builds one by hand: the edict sends the buyer's amount to the seller's change output instead.
  const evil = mkBid();
  evil.vout[RUNESTONE].script = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    codec.encodeEdicts([{ runeRef: REF, amount: WANT, output: CHANGE_OUTPUT }]),
  ]).toString('hex');
  // re-sign every buyer input over the edited transaction, so the cheap checks all pass
  const tx = bidTx(evil);
  const pub = Buffer.from(buyer.publicKey);
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: pub, network }).output;
  for (let i = 1; i < evil.vin.length; i++) {
    const sh = legacySighash(tx, i, p2pkh, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sh, Buffer.from(buyer.privateKey)));
    evil.scriptSigs[i] = bitcoin.script.compile([bitcoin.script.signature.encode(sig, SIGHASH_ALL), pub]).toString('hex');
  }
  const r = verifyRuneBid({ network, bid: evil, onChain });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /^simulated: the buyer would receive 0/, 'the refusal has to come from the simulation');
});

test('a second rune on the carrier has to come home too', () => {
  const two = { ...onChain, runes: { [REF]: HELD, [REF2]: 5_000 } };
  const bid = mkBid();
  const r = verifyRuneBid({ network, bid, onChain: two });
  assert.strictEqual(r.ok, true, r.reason);
  // and the simulation is what said so: it credits REF2 back to the change output
  const tx = bidTx(bid);
  const id = txid(tx);
  const s = new RuneState();
  s.credit(outpoint(carrier.txid, carrier.vout), REF, HELD);
  s.credit(outpoint(carrier.txid, carrier.vout), REF2, 5_000);
  applyTx(s, {
    txid: id, height: 9_500_001, txIndex: 0,
    inputs: bid.vin.map((v) => ({ txid: v.txid, vout: v.vout })),
    outputs: bid.vout.map((o, i) => ({
      value: o.value, scriptPubKey: Buffer.from(o.script, 'hex'),
      isOpReturn: i === RUNESTONE,
      opReturnData: i === RUNESTONE ? bitcoin.script.decompile(Buffer.from(o.script, 'hex'))[1] : undefined,
    })),
  });
  assert.strictEqual(s.balanceOf(outpoint(id, CHANGE_OUTPUT), REF2), 5_000);
});

test('bids against different carriers share the buyer\'s coins, so only one can ever confirm', () => {
  const a = mkBid();
  const b = mkBid({ carrier: { ...carrier, txid: H('e') } });
  const spent = (x) => x.vin.slice(1).map((v) => `${v.txid}:${v.vout}`).sort().join(',');
  assert.strictEqual(spent(a), spent(b));
  assert.notStrictEqual(a.vin[CARRIER_INPUT].txid, b.vin[CARRIER_INPUT].txid);
});

test('a market fee comes out of the seller\'s proceeds and is stated', () => {
  const feeAddr = addr(ECPair.makeRandom({ network }));
  const bid = mkBid({ marketFeeUnits: 600_000, feeAddress: feeAddr });
  const r = verifyRuneBid({ network, bid, onChain });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.receives, PRICE - 600_000);
  assert.strictEqual(bid.vout[PAY_OUTPUT].value, PRICE - 600_000);
});

console.log(`\n${passed} passed`);
