'use strict';
// Reopening a ticker price, four years later.
//
// This file exists because of a question worth asking out loud: in four years, will the person who
// etched a rune actually be able to get their money back, and will they need this project's wallet
// to do it?
//
// No, they will not need this wallet. What the lock requires is a SIGNATURE from one key, and
// nothing else. Any software that can build a legacy P2SH spend can produce it. But there is a trap
// in between, and it is the reason this module is shipped rather than described:
//
//   THE MONEY IS NOT AT THE ADDRESS OF YOUR KEY. It sits at a P2SH address derived from the key AND
//   the release date together. Import the private key into an ordinary wallet in 2030 and it will
//   show a balance of zero, because it has no idea to look there. Nothing is lost; it is simply
//   invisible to software that was not told how the address was built.
//
// So everything needed to find and open the lock is here, and everything it needs beyond the private
// key is published on chain in the etching's `l` field: the release timestamp and the public key.
// Lose the etching, keep the key, and you can still rebuild the address by trying the timestamp; lose
// the key and nothing can help you, which is the whole point of a lock nobody else can open.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPair } = require('../builder');
const { serializeTx, txid: txidOf, legacySighash, SIGHASH_ALL } = require('../vergetx');
const { pushData } = require('../envelope');
const tickers = require('./tickers');

// CLTV compares the spending transaction's nLockTime against the script's number, and the check only
// applies at all if the input is NOT final. A final input (0xffffffff) makes the node ignore
// nLockTime entirely, which is exactly the "lying" spend the regtest trial proved is refused.
const NON_FINAL = 0xfffffffe;

/**
 * Where an etching's price actually sits.
 *
 * @param {Object} p  { locktime, pubkey } from the etching's `l` field, or { locktime, wif }
 * @returns {{ address, redeemScript, pubkey }}
 */
function lockAddress({ locktime, pubkey, wif, network }) {
  let key = pubkey;
  if (!key && wif) key = Buffer.from(ECPair.fromWIF(wif, network).publicKey);
  if (!key) throw new Error('need the lock public key, or the WIF it came from');
  const redeem = tickers.lockRedeemScript(Number(locktime), Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex'));
  const address = bitcoin.address.fromOutputScript(tickers.p2shScriptPubKey(redeem), network);
  return { address, redeemScript: redeem, pubkey: key };
}

/**
 * Build the transaction that reopens the lock.
 *
 * @param {Object} p
 * @param {string} p.wif       the key generated when the rune was etched
 * @param {number} p.locktime  the release timestamp the etching published
 * @param {Array}  p.utxos     [{ txid, vout, value }] sitting at the lock address
 * @param {string} p.to        where the money should go now
 * @param {number} p.fee       miner fee in atomic units
 * @returns {{ hex, txid, value, address }}
 */
function buildUnlock({ wif, locktime, utxos, to, fee, network, nLockTime = null }) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('no locked outputs to spend');
  const signer = ECPair.fromWIF(wif, network);
  const { address, redeemScript } = lockAddress({ locktime, wif, network });

  const total = utxos.reduce((s, u) => s + u.value, 0);
  const value = total - fee;
  if (value <= 0) throw new Error(`fee ${fee} leaves nothing of the ${total} locked`);

  // nLockTime must be at or past the script's number. The node compares it against MEDIAN TIME PAST,
  // which trails the wall clock by around an hour, so a spend built the instant the lock expires is
  // refused for a while longer. That is the chain being careful, not the lock being wrong.
  const lock = nLockTime == null ? Number(locktime) : Number(nLockTime);
  if (lock < Number(locktime)) throw new Error('nLockTime is below the lock: the spend would be refused');

  const tx = {
    version: 1,
    time: Math.floor(Date.now() / 1000),
    vin: utxos.map((u) => ({ txid: u.txid, vout: u.vout, sequence: NON_FINAL, script: Buffer.alloc(0) })),
    vout: [{ value, script: bitcoin.address.toOutputScript(to, network) }],
    locktime: lock >>> 0,
  };

  const priv = Buffer.from(signer.privateKey);
  const pub = Buffer.from(signer.publicKey);
  utxos.forEach((_, i) => {
    const sighash = legacySighash(tx, i, redeemScript, SIGHASH_ALL);
    // Signed and encoded exactly as builder.js does it. A raw 64-byte signature is refused by the
    // node as non-canonical DER, so the encoding is not a detail: the self-check is here because a
    // bad signature on this transaction means the money stays locked with no second chance.
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, pub, sig)) throw new Error(`signature self-check failed for input ${i}`);
    const sigWithHashType = bitcoin.script.signature.encode(sig, SIGHASH_ALL);
    // A P2SH spend presents the arguments, then the script they satisfy.
    tx.vin[i].script = Buffer.concat([pushData(sigWithHashType), pushData(redeemScript)]);
  });

  const hex = serializeTx(tx).toString('hex');
  return { hex, txid: txidOf(tx), value, address };
}

/** Is the lock open yet, judged the way a node judges it? */
function isOpen(locktime, medianTimePast) {
  return Number(medianTimePast) >= Number(locktime);
}

module.exports = { lockAddress, buildUnlock, isOpen, NON_FINAL };
