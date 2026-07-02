// Verginals transaction builder: P2SH commit/reveal per spec/VERGINALS-SPEC-v0.md §4.
//
// Verge never serializes segwit witnesses (see src/vergetx.js), so an inscription cannot be
// revealed in a witness. Instead we use a P2SH redeemScript revealed in the scriptSig
// (Doginals-style): the commit pays to P2SH(hash160(redeemScript)); the reveal spends it by
// pushing <sig> <redeemScript>. The redeemScript carries the ord envelope as dead code and ends
// with <pubkey> OP_CHECKSIG. Inputs are signed with Verge's LEGACY sighash (which includes nTime).
//
// bitcoinjs-lib is used only for key handling and address/script derivation; serialization and
// signing go through src/vergetx.js, which is verified byte-identical against on-chain txs.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const ecpair = require('ecpair');
const { buildInscriptionScript, planInputs, parseInscriptionScript, pushData } = require('./envelope');
const { serializeTx, txid, legacySighash, SIGHASH_ALL } = require('./vergetx');

const ECPairFactory = ecpair.ECPairFactory || ecpair.default;
const ECPair = ECPairFactory(ecc);

/** Map a src/networks.js entry to a bitcoinjs Network object. */
function toBitcoinjsNetwork(net) {
  return {
    messagePrefix: net.messagePrefix,
    bech32: net.bech32,
    bip32: net.bip32,
    pubKeyHash: net.pubKeyHash,
    scriptHash: net.scriptHash,
    wif: net.wif,
  };
}

/** Derive the P2SH commit target (address + output script) for a redeemScript. */
function p2shFor(redeemScript, network) {
  const payment = bitcoin.payments.p2sh({ redeem: { output: redeemScript }, network });
  return { address: payment.address, outputScript: payment.output };
}

/**
 * Build the redeemScript(s) for an inscription, splitting across inputs when the payload exceeds
 * one standard (≤520B) P2SH redeemScript (see envelope.planInputs).
 * @returns {Buffer[]} one redeemScript per reveal input, body concatenated in order
 */
function buildInscriptionScripts({ pubkey, contentType, body = Buffer.alloc(0), parent, metadata }) {
  const plan = planInputs(body, { contentType, parent, metadata });
  const scripts = [];
  let off = 0;
  plan.perInputBody.forEach((n, idx) => {
    const slice = body.subarray(off, off + n);
    off += n;
    scripts.push(
      buildInscriptionScript({
        pubkey,
        contentType: idx === 0 ? contentType : undefined,
        parent: idx === 0 ? parent : undefined,
        metadata: idx === 0 ? metadata : undefined,
        body: slice,
        bodyOnly: idx !== 0,
      })
    );
  });
  return scripts;
}

/**
 * Build and sign the reveal transaction: spend each commit output, revealing its redeemScript in
 * the scriptSig, and pay the carrier output(s).
 *
 * Inputs are heterogeneous so a parented mint can spend the collection-parent's P2PKH carrier
 * (spec §10.3) alongside the P2SH commit inputs:
 *   - P2SH reveal input:  { txid, vout, value, redeemScript }        scriptSig = <sig> <redeemScript>
 *   - P2PKH carry input:  { txid, vout, value, p2pkh: true, signer } scriptSig = <sig> <pubkey>
 * Each input may carry its own `signer` (ECPair); inputs without one fall back to the top-level
 * `signer`. The parent input MUST bring its own signer (the operator's parent key), which is
 * different from the reveal wif that authorizes the commit inputs.
 * @param {Object} p
 * @param {Object} p.network   bitcoinjs Network (use toBitcoinjsNetwork)
 * @param {Array}  p.inputs    see shapes above
 * @param {Array}  p.outputs   [{ address, value }]
 * @param {Object} [p.signer]  default ECPair whose pubkey matches the redeemScripts
 * @param {number} [p.time]    tx nTime (defaults to now); fixed value makes builds reproducible
 * @returns {{ tx, hex, txid }} the signed Verge transaction (plain object), wire hex, and txid
 */
function buildReveal({ network, inputs, outputs, signer, time }) {
  const tx = {
    version: 1,
    time: time == null ? Math.floor(Date.now() / 1000) : time >>> 0,
    vin: inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xffffffff, script: Buffer.alloc(0) })),
    vout: outputs.map((o) => ({ value: o.value, script: bitcoin.address.toOutputScript(o.address, network) })),
    locktime: 0,
  };

  inputs.forEach((inp, i) => {
    const key = inp.signer || signer;
    if (!key) throw new Error(`no signer for input ${i}`);
    const priv = Buffer.from(key.privateKey);
    const pub = Buffer.from(key.publicKey);
    // The sighash scriptCode is the P2PKH output for a carry input, else the revealed redeemScript.
    const scriptCode = inp.p2pkh
      ? bitcoin.payments.p2pkh({ pubkey: pub, network }).output
      : inp.redeemScript;
    const sighash = legacySighash(tx, i, scriptCode, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, pub, sig)) throw new Error(`signature self-check failed for input ${i}`);
    const sigWithHashType = bitcoin.script.signature.encode(sig, SIGHASH_ALL);
    const secondPush = inp.p2pkh ? pub : inp.redeemScript;
    tx.vin[i].script = Buffer.concat([pushData(sigWithHashType), pushData(secondPush)]);
  });

  return { tx, hex: serializeTx(tx).toString('hex'), txid: txid(tx) };
}

/**
 * Build and sign a funding transaction that spends one or more P2PKH deposit UTXOs (all
 * controlled by `signer`) into the commit outputs. Used by the payment-request flow: the user
 * makes a single payment to the deposit address, then this consolidates it into the N commit
 * P2SH outputs the reveal will spend. Fee is the implicit remainder (sum(inputs) − sum(outputs)).
 * @param {Object} p
 * @param {Object} p.network   bitcoinjs Network
 * @param {Array}  p.inputs    [{ txid, vout, value }] deposit UTXOs (P2PKH, owned by signer)
 * @param {Array}  p.outputs   [{ address, value }] commit outputs
 * @param {Object} p.signer    ECPair holding the deposit key
 * @param {number} [p.time]    tx nTime (defaults to now)
 * @returns {{ tx, hex, txid }}
 */
function buildFundingTx({ network, inputs, outputs, signer, time }) {
  const pub = Buffer.from(signer.publicKey);
  const scriptCode = bitcoin.payments.p2pkh({ pubkey: pub, network }).output; // OP_DUP HASH160 <h> EQUALVERIFY CHECKSIG
  const tx = {
    version: 1,
    time: time == null ? Math.floor(Date.now() / 1000) : time >>> 0,
    vin: inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xffffffff, script: Buffer.alloc(0) })),
    vout: outputs.map((o) => ({ value: o.value, script: bitcoin.address.toOutputScript(o.address, network) })),
    locktime: 0,
  };
  const priv = Buffer.from(signer.privateKey);
  inputs.forEach((_, i) => {
    const sighash = legacySighash(tx, i, scriptCode, SIGHASH_ALL);
    const sig = Buffer.from(ecc.sign(sighash, priv));
    if (!ecc.verify(sighash, pub, sig)) throw new Error(`funding signature self-check failed for input ${i}`);
    const sigWithHashType = bitcoin.script.signature.encode(sig, SIGHASH_ALL);
    tx.vin[i].script = Buffer.concat([pushData(sigWithHashType), pushData(pub)]);
  });
  return { tx, hex: serializeTx(tx).toString('hex'), txid: txid(tx) };
}

module.exports = {
  ECPair,
  toBitcoinjsNetwork,
  p2shFor,
  buildInscriptionScripts,
  buildReveal,
  buildFundingTx,
  parseInscriptionScript,
};
