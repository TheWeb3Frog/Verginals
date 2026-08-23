'use strict';
// Turning a list of winners into transactions, and saying what that costs before any of it is signed.
//
// THE 83-BYTE WALL. Every recipient needs its own edict, an edict is five varints, and the whole
// message has to fit the node's datacarriersize. There is no batching trick that gets around it:
// the spec has no "split evenly across the outputs" convention, on purpose, because a convention
// like that changes what an edict means depending on how many outputs a transaction happens to
// have. So a drop to five thousand wallets is not one transaction, it is hundreds, and the only
// question is how many recipients fit in each. That question is answered by ENCODING, not by
// arithmetic on estimated byte counts, because the encoder is the thing that will refuse.
//
// WHY OUTPUT 0 IS THE CHANGE. Anything an edict does not name falls to the first eligible output
// (spec 3). In a batch that is the entire undistributed remainder of the supply -- hundreds of
// millions of coins. Put a recipient at output 0 and they receive their allocation plus everything
// left in the drop, once, silently, with no error anywhere. So the change output goes first and the
// recipients start at index 1. This is the single most expensive thing in this file to get wrong,
// which is why it is a constant with a name rather than an offset written inline.
const CHANGE_OUTPUT = 0;
const FIRST_RECIPIENT = 1;

const codec = require('./codec');
const { feeForBytes } = require('../pricing');

// The floor an output must clear to be allowed to hold runes (indexer step 4). Every recipient is
// therefore also sent 0.1 XVG, which is not a fee: it lands in their wallet with the coins.
const DUST_UNITS = 100000;

// A transaction's size, by the same convention the wallet uses to fund one: 14 bytes of overhead,
// ~148 per P2PKH input, ~34 per ordinary output. The OP_RETURN output is counted separately at its
// real width, 8 bytes of value plus the script.
const TX_OVERHEAD = 14;
const INPUT_BYTES = 148;
const OUTPUT_BYTES = 34;
const opReturnBytes = (payload) => 8 + 1 + 2 + payload.length;

/**
 * Pack recipients into batches, each holding as many as one OP_RETURN can name.
 *
 * Greedy and exact: a recipient joins the current batch if the batch still encodes, and starts a new
 * one if it does not. Amounts differ in varint width, so the batch size is not a constant and is
 * never assumed to be.
 *
 * @param {Array} recipients [{ address, amount }] amount in atomic units, > 0
 * @param {string} runeRef   canonical "<height>:<txIndex>"
 * @returns {Array} batches of recipients
 */
function batch(recipients, runeRef) {
  for (const r of recipients) {
    if (!Number.isInteger(r.amount) || r.amount <= 0) {
      throw new Error(`${r.address} is down for ${r.amount} units, which is not a whole positive amount`);
    }
  }
  const batches = [];
  let current = [];
  const fits = (rows) => {
    try {
      codec.encodeEdicts(rows.map((r, i) => ({ runeRef, amount: r.amount, output: FIRST_RECIPIENT + i })));
      return true;
    } catch { return false; }
  };
  for (const r of recipients) {
    if (current.length && !fits(current.concat([r]))) { batches.push(current); current = []; }
    if (!fits([r])) throw new Error(`${r.address} cannot be paid in one edict: ${r.amount} units is too large to encode`);
    current.push(r);
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The full plan: what to build, and what it costs.
 *
 * @param {Object} p
 * @param {Array} p.recipients   [{ address, amount }]
 * @param {string} p.runeRef
 * @param {string} p.changeAddress  where the undistributed remainder and the XVG change go back to
 * @param {number} [p.inputs]    inputs each transaction is funded with
 * @returns {{ txs, batches, feeUnits, dustUnits, totalUnits, distributed }}
 */
function plan({ recipients, runeRef, changeAddress, inputs = 2 }) {
  if (!changeAddress) throw new Error('a change address is required: without one the remainder is burned');
  const batches = batch(recipients, runeRef);

  const txs = batches.map((rows, n) => {
    const edicts = rows.map((r, i) => ({ runeRef, amount: r.amount, output: FIRST_RECIPIENT + i }));
    const opReturn = codec.encodeEdicts(edicts);
    const outputs = [{ address: changeAddress, value: DUST_UNITS, isChange: true }]
      .concat(rows.map((r) => ({ address: r.address, value: DUST_UNITS, carriesRune: true })));
    const bytes = TX_OVERHEAD + inputs * INPUT_BYTES + outputs.length * OUTPUT_BYTES + opReturnBytes(opReturn);
    return {
      n,
      outputs,
      opReturn,
      edicts,
      bytes,
      feeUnits: Math.round(feeForBytes(bytes) * 1e6),
      dustUnits: rows.length * DUST_UNITS,
      // Stated rather than implied. A reader checking this plan should not have to count outputs to
      // convince themselves the remainder is safe.
      remainderOutput: CHANGE_OUTPUT,
    };
  });

  const feeUnits = txs.reduce((s, t) => s + t.feeUnits, 0);
  const dustUnits = txs.reduce((s, t) => s + t.dustUnits, 0);
  return {
    txs,
    batches,
    feeUnits,
    dustUnits,
    totalUnits: feeUnits + dustUnits,
    distributed: recipients.reduce((s, r) => s + r.amount, 0),
  };
}

module.exports = { plan, batch, CHANGE_OUTPUT, FIRST_RECIPIENT, DUST_UNITS };
