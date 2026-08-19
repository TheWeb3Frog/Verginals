'use strict';
// Turning a composed etching into a transaction pair somebody can pay for.
//
// The shape mirrors the inscription mint that has been running in production: one deposit address,
// then a split into the commit outputs, then a reveal. An etching adds exactly one thing to that,
// and it is the thing that costs the money:
//
//   THE TICKER PRICE HAS TO BE AN OUTPUT OF THE REVEAL ITSELF (spec §7.2). Not of the split, not of
//   a later transaction. An indexer replaying blocks decides whether the ticker was claimed using
//   only the transaction in front of it, so the price and the inscription must ride together or the
//   etcher pays and gets nothing.
//
// So the split carries one extra output holding the price, and the reveal spends it and pays it into
// the P2SH CLTV lock. That is what `pay` on revealFromPlan exists for, and it is proven end to end
// in test/e2e/runes-fullcycle-regtest.js.
//
// Pure: this composes and prices, it does not talk to a node or to disk. The server drives it.

const runeBuilder = require('./builder');
const tickers = require('./tickers');

// What each commit output holds.
//
// The reveal spends these and its carrier output is what is left after the fee, so PER_INPUT has to
// exceed REVEAL_FEE by at least the dust minimum or the premine has nowhere to land: an output below
// dust cannot hold a balance (§3), so the rune would be etched and immediately burnt. The first
// version set both to the same number and the reveal refused to build at all, which is the loud
// version of that mistake and the reason these two constants are written next to each other.
const PER_INPUT = 4 * runeBuilder.DUST_UNITS;

// What the release inscription costs. The etcher pays, at etch time, for the transaction that gives
// them their money back in four years, which is the cheapest thing in this whole quote and the only
// line on it that protects the biggest one. It funds a commit and a reveal for a 209 byte payload.
const RELEASE_HOLDER = 8 * runeBuilder.DUST_UNITS;

// The miner fee for each of the two transactions. Verge's relay floor is 0.1 XVG absolute, so this
// is double it: an etching that stalls for want of a hundredth of a coin would strand the whole
// ticker price in a deposit address.
const SPLIT_FEE = 2 * runeBuilder.DUST_UNITS;
const REVEAL_FEE = 2 * runeBuilder.DUST_UNITS;

// What the carrier holds once the reveal has paid its fee, with one commit input. Asserted rather
// than assumed, because the whole etching turns on it.
const CARRIER_VALUE = PER_INPUT - REVEAL_FEE;
if (CARRIER_VALUE < runeBuilder.DUST_UNITS) {
  throw new Error('PER_INPUT must exceed REVEAL_FEE by at least the dust minimum, or the premine burns');
}

// Slack left on the price-carrying output so the reveal can pay the lock and still return change
// above dust rather than dropping it on the floor.
const PRICE_SLACK = 3 * runeBuilder.DUST_UNITS;

/**
 * Everything an etcher has to pay, and the plan it buys.
 *
 * @param {Object} p
 * @param {Object} p.rune        the etching, as buildEtch takes it (without `lock`)
 * @param {string} p.recipient   address that receives the premine
 * @param {Buffer} p.lockPubkey  33-byte compressed key that reopens the price in four years
 * @param {number} p.locktime    unix timestamp the lock releases at
 * @param {Function} p.buildPlan cli.buildPlan, injected so this module needs no network name logic
 * @param {string} p.networkName
 */
function quoteEtch({ rune, recipient, lockPubkey, locktime, buildPlan, networkName }) {
  const etch = runeBuilder.buildEtch(
    Object.assign({}, rune, { lock: { locktime, pubkey: lockPubkey } }),
    { address: recipient, value: runeBuilder.DUST_UNITS },
  );
  const plan = buildPlan({
    body: etch.body, contentType: etch.contentType, networkName,
    amount: PER_INPUT, file: `${etch.ticker.toLowerCase()}.cbor`,
  });

  const numInputs = plan.inputs.length;
  const priceHolder = etch.price + PRICE_SLACK;
  // The deposit funds: every commit output, the price plus its slack, and both miner fees.
  const total = numInputs * PER_INPUT + priceHolder + RELEASE_HOLDER + SPLIT_FEE + REVEAL_FEE;

  return {
    etch, plan, numInputs,
    perInput: PER_INPUT,
    price: etch.price,
    priceHolder,
    releaseHolder: RELEASE_HOLDER,
    splitFee: SPLIT_FEE,
    revealFee: REVEAL_FEE,
    total,
  };
}

/**
 * The split's outputs, in the order the reveal expects to find them.
 *
 * Commit outputs first, so `splitTxid:i` lines up with `plan.inputs[i]` exactly as the mint flow
 * assumes, then the price holder last. The remainder of the deposit is the miner fee.
 */
function splitOutputs(quote, depositAddress) {
  const outputs = quote.plan.inputs.map((inp) => ({ address: inp.address, value: quote.perInput }));
  outputs.push({ address: depositAddress, value: quote.priceHolder });
  // Last, so the price holder keeps the index payFor() already relies on. Adding it anywhere
  // earlier would silently move the price and the reveal would spend the wrong output.
  outputs.push({ address: depositAddress, value: quote.releaseHolder });
  return outputs;
}

/** Where the release inscription's funding sits, once the split has confirmed. */
function releaseFunding(quote, splitTxid) {
  return { txid: splitTxid, vout: quote.numInputs + 1, value: quote.releaseHolder };
}

/** What to hand revealFromPlan so the reveal pays the ticker price into the lock. */
function payFor(quote, splitTxid, depositWif, depositAddress, lockAddress) {
  return {
    txid: splitTxid,
    vout: quote.numInputs,           // the price holder sits after every commit output
    value: quote.priceHolder,
    wif: depositWif,
    change: depositAddress,
    outputs: [{ address: lockAddress, value: quote.price }],
  };
}

/**
 * Where the etched rune will be, once the reveal confirms.
 *
 * A reference is (height, txIndex) and neither is known until a miner puts the transaction in a
 * block, so this cannot be answered in advance. It is stated here rather than guessed at, because a
 * caller that assumed otherwise would show somebody a name for a rune that does not exist yet.
 */
const REF_IS_KNOWN_ONLY_AFTER_CONFIRMATION = true;

module.exports = {
  RELEASE_HOLDER, releaseFunding,
  PER_INPUT, SPLIT_FEE, REVEAL_FEE, PRICE_SLACK, CARRIER_VALUE,
  quoteEtch, splitOutputs, payFor,
  REF_IS_KNOWN_ONLY_AFTER_CONFIRMATION,
  MAX_MINT_PRICE: tickers.MAX_MINT_PRICE,
};
