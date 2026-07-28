'use strict';
// Verge Assets: turning real chain data into the shape the state machine expects (ASSETS-PLAN §2.1).
//
// This is the only place that knows what a Verge RPC transaction looks like. Everything downstream
// (indexer.js, checkpoint.js) stays pure, so the protocol rules can be reasoned about and tested
// without a node. Keeping the boundary here is what lets two independent implementations agree.

const codec = require('./codec');

/** Is this output an OP_RETURN, and what does it carry? scriptPubKey.hex starts with 6a (OP_RETURN). */
function readOpReturn(vout) {
  const spk = vout.scriptPubKey || {};
  const hex = spk.hex || '';
  if (!hex.startsWith('6a')) return null;
  // 6a <pushopcode> <data>. Handle the direct push (<=75 bytes) and OP_PUSHDATA1, which is all an
  // 83-byte payload can ever need.
  const buf = Buffer.from(hex, 'hex');
  let off = 1;
  if (off >= buf.length) return Buffer.alloc(0);
  const op = buf[off];
  if (op <= 75) { off += 1; }
  else if (op === 0x4c) { off += 2; }      // OP_PUSHDATA1
  else return Buffer.alloc(0);             // anything larger cannot be one of our messages
  return buf.slice(off);
}

/**
 * Convert one RPC transaction into the applyTx() shape.
 *
 * @param {Object} tx      verbose getrawtransaction / block tx
 * @param {number} height
 * @param {number} txIndex position in the block
 * @param {Object} [opts]  { etching } when this tx also carries an asset inscription
 */
function toIndexerTx(tx, height, txIndex, opts = {}) {
  const inputs = (tx.vin || [])
    .filter((i) => i.txid) // a coinbase has no previous output
    .map((i) => ({ txid: i.txid, vout: i.vout, scriptPubKey: i.scriptPubKey ? Buffer.from(i.scriptPubKey.hex || '', 'hex') : null }));

  const outputs = (tx.vout || []).map((o) => {
    const data = readOpReturn(o);
    const addresses = (o.scriptPubKey && o.scriptPubKey.addresses) || [];
    return {
      value: Math.round(Number(o.value) * 1e6),
      scriptPubKey: Buffer.from((o.scriptPubKey && o.scriptPubKey.hex) || '', 'hex'),
      address: addresses.length === 1 ? addresses[0] : null,
      isOpReturn: data !== null,
      opReturnData: data || undefined,
    };
  });

  return Object.assign({ txid: tx.txid, height, txIndex, inputs, outputs }, opts);
}

/** True when a transaction carries something this protocol should look at (cheap pre-filter). */
function isRelevant(tx) {
  return (tx.vout || []).some((o) => {
    const d = readOpReturn(o);
    return d !== null && codec.decode(d) !== null;
  });
}

/**
 * Scan a range of blocks and apply every transaction, in order, to the given state.
 *
 * @param {Object} chain  { getBlockHash(h), getBlock(hash, verbosity) }
 * @param {AssetState} state
 * @param {number} from   first height (inclusive)
 * @param {number} to     last height (inclusive)
 * @param {Function} applyTx
 * @param {Object} [opts] { etchingsByTxid } to inject etchings resolved from inscriptions
 */
async function scanRange(chain, state, from, to, applyTx, opts = {}) {
  const etchings = opts.etchingsByTxid || {};
  let applied = 0;
  for (let h = from; h <= to; h++) {
    const hash = await chain.getBlockHash(h);
    const block = await chain.getBlock(hash, 2); // verbosity 2 = full transactions
    (block.tx || []).forEach((tx, i) => {
      const etching = etchings[tx.txid];
      // Everything is applied, not just "relevant" transactions: an ordinary send still MOVES a
      // balance through the default assignment, and skipping it would silently lose funds.
      applyTx(state, toIndexerTx(tx, h, i, etching ? { etching } : {}), opts);
      applied += 1;
    });
  }
  return { applied, height: to };
}

module.exports = { readOpReturn, toIndexerTx, isRelevant, scanRange };
