// A valid ticker price lock, for tests that need to etch something (spec §7.2).
//
// Since the lock became the payment rule, an etching with no lock is ignored by the indexer and the
// ticker stays free. That is the point of the rule, and it means every test that etches has to pay,
// so the arithmetic lives here once instead of in five files.

const tickers = require('../../src/assets/tickers');

// Any well-formed compressed key. The protocol only ever hashes it, and never decompresses the
// point: a key that is not on the curve means the etcher can never reopen their own money, which is
// their loss and nobody else's, so it is not worth a curve operation per etching to catch.
const PUBKEY = Buffer.from('02' + '11'.repeat(32), 'hex');
const BLOCK_TIME = 1700000000;

/**
 * @returns {{ time, lock, output }} the block time to stamp the transaction with, the `l` field for
 *   the etching, and the output that pays the price.
 */
function lockFor(ticker, blockTime = BLOCK_TIME, pubkey = PUBKEY) {
  const locktime = blockTime + tickers.LOCK_SECONDS;
  const redeem = tickers.lockRedeemScript(locktime, pubkey);
  return {
    time: blockTime,
    lock: { t: locktime, k: pubkey },
    output: {
      value: tickers.priceOf(ticker),
      scriptPubKey: tickers.p2shScriptPubKey(redeem),
      isOpReturn: false,
      address: null,
    },
  };
}

module.exports = { PUBKEY, BLOCK_TIME, lockFor };
