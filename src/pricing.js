'use strict';
// What an inscription costs, as pure arithmetic. No chain, no network, no state: given a plan's input
// count this returns every number the payment job needs, so the money path can be unit-tested.
//
// Where the money actually goes. The buyer pays `total` into the deposit address; the commit tx turns
// it into the N P2SH commit outputs, and the reveal spends those back to the buyer as ONE carrier
// output holding the inscription. So only the fees are really spent:
//
//   total   = perInput * numInputs + splitFee + serviceFee
//   carrier = perInput * numInputs - revealFee      (comes back to the buyer, holding the inscription)
//   real cost = total - carrier = splitFee + serviceFee + revealFee
//
// This is why a flat rate per input was wasteful: every unit above what the reveal fee needs does not
// buy anything, it just comes back locked in the carrier. An item needing 20 inputs asked the buyer to
// front ~6.2 XVG only to hand ~3.4 XVG straight back. Sizing the commit outputs from the reveal fee
// instead lands every item on the same carrier, and only ever lowers the asking price.

const { COIN } = require('./networks');

const toUnits = (xvg) => Math.round(Number(xvg) * COIN);

// The node enforces this as its floor (getnetworkinfo relayfee), so it is not a knob we can lower.
const FEE_RATE_XVG_PER_KB = 0.2;
const feeForBytes = (bytes) => Math.max(FEE_RATE_XVG_PER_KB, Math.ceil(bytes / 1000) * FEE_RATE_XVG_PER_KB);

// A P2SH reveal input measures ~600 B (measured on chain: 572-578 B). A parented reveal also carries
// one P2PKH parent input (~150 B) and one carry-forward output (~34 B); those bytes are added to the
// count rather than billed with a second feeForBytes() call, because rounding them up separately
// charges a whole extra kB for ~184 bytes of real data.
const suggestRevealFeeXVG = (numInputs, parented = false) => feeForBytes(numInputs * 600 + (parented ? 184 : 0));
// Funding tx: 1 P2PKH input (~150 B) + N P2SH outputs (~32 B each) + ~12 B overhead.
const suggestSplitFeeXVG = (numInputs) => feeForBytes(150 + numInputs * 32 + 12);

// Minimum an output must hold to be spendable and safe to relay. The carrier must clear it, or the
// reveal can be rejected as dust and the inscription lands on a utxo too small to ever move.
const DUST_UNITS = 100000; // 0.1 XVG
// What the carrier should be left holding once the reveal fee is paid: comfortably above dust, and
// the value light items already carry in practice today.
const CARRIER_TARGET_UNITS = 300000; // 0.3 XVG

/**
 * Every figure a payment job needs, in atomic units.
 *
 * @param {number} numInputs     commit inputs the plan needs (driven by payload size)
 * @param {boolean} parented     whether the reveal also spends the collection parent tip
 * @param {number} maxPerInput   ceiling per commit output (the configured rate). Acts as a ceiling
 *                               only, so this function can never raise a price above the flat model.
 * @param {number} serviceFee    operator fee in units (0 unless configured)
 * @returns {{perInput,commitTotal,splitFee,revealFee,serviceFee,total,carrier}} all in units
 */
function priceInscription({ numInputs, parented = false, maxPerInput, serviceFee = 0 }) {
  if (!Number.isInteger(numInputs) || numInputs < 1) throw new Error('numInputs must be a positive integer');
  const splitFee = toUnits(suggestSplitFeeXVG(numInputs));
  const revealFee = toUnits(suggestRevealFeeXVG(numInputs, parented));

  const perInputFloor = Math.ceil((revealFee + DUST_UNITS) / numInputs);          // never leave dust
  const perInputWanted = Math.ceil((revealFee + CARRIER_TARGET_UNITS) / numInputs);
  const perInput = Math.max(perInputFloor, Math.min(maxPerInput, perInputWanted));

  const commitTotal = perInput * numInputs;
  return {
    perInput, commitTotal, splitFee, revealFee, serviceFee,
    total: commitTotal + splitFee + serviceFee,
    carrier: commitTotal - revealFee,
  };
}

module.exports = {
  FEE_RATE_XVG_PER_KB, feeForBytes, suggestRevealFeeXVG, suggestSplitFeeXVG,
  DUST_UNITS, CARRIER_TARGET_UNITS, priceInscription,
};
