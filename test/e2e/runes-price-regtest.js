// The two prices of Verge Runes, on a real chain.
//
//   the ticker price   locked in the etching transaction for 1460 days, reachable by nobody but the
//                      etcher, and only then (spec §7.2)
//   the mint price     a plain transaction FEE, set by whoever etched the rune, paid to the miner
//                      of the block that carries the mint (spec §2.2)
//
// The mint price is the part that needed proving rather than reasoning about, and there were three
// ways it could have failed quietly:
//
//   1. a node might refuse to relay a transaction whose fee is thousands of times the minimum.
//      Bitcoin Core does exactly this: sendrawtransaction has a maxfeerate that rejects anything
//      above 0.10 BTC/kvB unless the caller overrides it. If Verge inherited that, every mint would
//      be unbroadcastable and the design would be dead on arrival;
//   2. the fee might not actually reach the miner, in which case the money goes nowhere;
//   3. an indexer might not be able to see the fee at all. Verge Core has no getblock verbosity 3
//      and puts no fee on a block transaction, so it has to be computed from prevouts by hand.
//
// Run: RT_WALLET=<wallet> node test/e2e/runes-price-regtest.js
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const bitcoin = require(path.join(ROOT, 'node_modules/bitcoinjs-lib'));
const ecc = require(path.join(ROOT, 'node_modules/tiny-secp256k1'));
const { rpc } = require('./rpc.js');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { ECPair } = require(path.join(ROOT, 'src/builder'));
const { buildEtch, buildMint, DUST_UNITS } = require(path.join(ROOT, 'src/runes/builder'));
const scanner = require(path.join(ROOT, 'src/runes/scanner'));
const { RuneState, applyTx, runeRefOf } = require(path.join(ROOT, 'src/runes/indexer'));
const tickers = require(path.join(ROOT, 'src/runes/tickers'));
const codec = require(path.join(ROOT, 'src/runes/codec'));

const COIN = 1e6;
const TICKER = 'PRICEDONREGTEST';    // 15 characters, so 10 XVG by the schedule
const MINT_PRICE = 20 * COIN;        // what each mint owes in fee, the figure under discussion
const MINT_AMOUNT = 1000;

let checks = 0, failed = 0;
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log('  ok   - ' + name + (detail ? '  [' + detail + ']' : ''));
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const xvg = (units) => Number((units / COIN).toFixed(6));

function freshKey() {
  let priv;
  do { priv = crypto.randomBytes(32); } while (!ecc.isPrivate(priv));
  return { priv, pub: Buffer.from(ecc.pointFromScalar(priv, true)) };
}

/** The chain adapter the scanner expects, backed by this node. */
const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (hash, v) => rpc('getblock', [hash, v]),
  getRawTransaction: (txid, verbose) => rpc('getrawtransaction', [txid, verbose]),
};

/** Fund one P2PKH output the reveal can spend, and hand back the key that owns it. */
async function fundedInput(units, network) {
  const key = freshKey();
  const { address } = bitcoin.payments.p2pkh({ pubkey: key.pub, network });
  const txid = await rpc('sendtoaddress', [address, xvg(units)]);
  await rpc('generate', [1]);
  const tx = await rpc('getrawtransaction', [txid, true]);
  const vout = tx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(address));
  const wif = ECPair.fromPrivateKey(key.priv, { network, compressed: true }).toWIF();
  return { txid, vout, value: Math.round(Number(tx.vout[vout].value) * COIN), wif, address };
}

/**
 * A mint transaction paying exactly `fee` to the miner and nothing to anybody else. Built through
 * the node's own funding so it is an ordinary transaction in every respect except the size of the
 * fee, which is the whole question.
 */
async function mintPaying(runeRef, fee, recipient) {
  const plan = buildMint(runeRef, { address: recipient, value: DUST_UNITS, mintPrice: fee });
  const dataHex = plan.opReturn.toString('hex');

  // One chosen input and an explicit change amount, rather than fundrawtransaction, because the fee
  // is the subject of the test and it has to be an exact number rather than whatever a fee
  // estimator felt like. The arithmetic below IS the fee: inputs minus outputs.
  const spendable = (await rpc('listunspent', [1]))
    .filter((u) => Math.round(Number(u.amount) * COIN) > fee + 2 * DUST_UNITS)
    .sort((a, b) => Number(a.amount) - Number(b.amount));
  if (!spendable.length) throw new Error('no utxo large enough to pay a ' + xvg(fee) + ' XVG fee');
  const coin = spendable[0];
  const value = Math.round(Number(coin.amount) * COIN);
  const change = value - DUST_UNITS - fee;

  const raw = await rpc('createrawtransaction', [
    [{ txid: coin.txid, vout: coin.vout }],
    [{ [recipient]: xvg(DUST_UNITS) }, { data: dataHex }, { [await rpc('getrawchangeaddress')]: xvg(change) }],
  ]);
  const signed = await rpc('signrawtransactionwithwallet', [raw]);
  if (!signed.complete) throw new Error('could not sign the mint: ' + JSON.stringify(signed.errors || []));
  return { hex: signed.hex, fee };
}

async function tryBroadcast(hex, extra = []) {
  try { return { accepted: true, txid: await rpc('sendrawtransaction', [hex, ...extra]) }; }
  catch (e) { return { accepted: false, reason: e.message }; }
}

// --- the trial ----------------------------------------------------------------------------------

(async () => {
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'regtest') {
    console.error('REFUSING TO RUN: chain is "' + info.chain + '", not regtest.');
    process.exit(2);
  }
  console.log('The two prices of Verge Runes, on regtest\n');
  console.log('  chain ' + info.chain + ', height ' + info.blocks + '\n');

  const { network } = pickNetwork('regtest');
  const holder = await rpc('getnewaddress');
  const minter = await rpc('getnewaddress');
  const startHeight = await rpc('getblockcount');

  // ---- 1. Etch, paying the ticker price into a lock ------------------------------------------
  console.log('1. Etching ' + TICKER + ', locking its ' + xvg(tickers.priceOf(TICKER)) + ' XVG price');

  const lockKey = freshKey();
  const locktime = Math.floor(Date.now() / 1000) + tickers.LOCK_SECONDS;
  const etch = buildEtch({
    ticker: TICKER, name: 'Priced On Regtest', divisibility: 0,
    supply: 1000000, premine: 0,
    terms: { amount: MINT_AMOUNT, price: MINT_PRICE },
    lock: { locktime, pubkey: lockKey.pub },
  }, { address: holder, value: DUST_UNITS });

  const lockAddress = (await rpc('decodescript', [
    tickers.lockRedeemScript(locktime, lockKey.pub).toString('hex'),
  ])).p2sh;
  check('the lock address the node derives is the one the builder committed to',
    bitcoin.address.toOutputScript(lockAddress, network).equals(etch.lockScriptPubKey),
    lockAddress);

  const plan = buildPlan({
    body: etch.body, contentType: etch.contentType, networkName: 'regtest',
    amount: 2 * DUST_UNITS, file: 'priced.cbor',
  });

  const commitOuts = {};
  for (const inp of plan.inputs) commitOuts[inp.address] = xvg(2 * DUST_UNITS);
  const commitRaw = await rpc('createrawtransaction', [[], commitOuts]);
  const commitFunded = await rpc('fundrawtransaction', [commitRaw]);
  const commitSigned = await rpc('signrawtransactionwithwallet', [commitFunded.hex]);
  const commitTxid = await rpc('sendrawtransaction', [commitSigned.hex]);
  await rpc('generate', [1]);

  const commitTx = await rpc('getrawtransaction', [commitTxid, true]);
  const utxos = [];
  const values = [];
  for (const inp of plan.inputs) {
    const vout = commitTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(inp.address));
    utxos.push(commitTxid + ':' + vout);
    values.push(2 * DUST_UNITS);
  }

  // The ticker price is far more than a commit carries, so it comes from an input of its own.
  const payIn = await fundedInput(tickers.priceOf(TICKER) + 5 * COIN, network);
  const change = await rpc('getnewaddress');
  const reveal = revealFromPlan({
    plan, utxos, to: holder, fee: DUST_UNITS, values, network,
    pay: {
      txid: payIn.txid, vout: payIn.vout, value: payIn.value, wif: payIn.wif, change,
      outputs: [{ address: lockAddress, value: tickers.priceOf(TICKER) }],
    },
  });
  const etchTxid = await rpc('sendrawtransaction', [reveal.hex]);
  await rpc('generate', [1]);
  const etchHeight = await rpc('getblockcount');
  check('the etching confirmed with its price locked beside it', !!etchTxid, etchTxid.slice(0, 16) + '...');

  // ---- 2. Index the real blocks and see whether the ticker was taken --------------------------
  console.log('\n2. Indexing the chain from block ' + (startHeight + 1));
  const state = new RuneState();
  const t0 = Date.now();
  const scan = await scanner.scanRange(chain, state, startHeight + 1, etchHeight, applyTx);
  const REF = runeRefOf(etchHeight, 1);
  const rune = state.runes.get(REF);
  check('the indexer registered the rune from the chain alone', !!rune && rune.ticker === TICKER,
    rune ? rune.ticker + ', ' + scan.applied + ' transactions applied' : 'not registered');
  check('and it carries the mint price the etcher chose', !!rune && rune.terms.price === MINT_PRICE,
    rune && rune.terms ? xvg(rune.terms.price) + ' XVG per mint' : 'no terms');
  check('the locked coins are on chain, in the etching transaction itself',
    (await rpc('getrawtransaction', [etchTxid, true])).vout
      .some((o) => (o.scriptPubKey.addresses || []).includes(lockAddress)
        && Math.round(Number(o.value) * COIN) === tickers.priceOf(TICKER)),
    xvg(tickers.priceOf(TICKER)) + ' XVG at ' + lockAddress);

  // ---- 3. The question this run exists to answer ----------------------------------------------
  console.log('\n3. Can a ' + xvg(MINT_PRICE) + ' XVG fee even be broadcast');

  // An empty block first, so the pure subsidy is a measured number rather than an assumed one.
  // Without it, "the coinbase went up" proves nothing: any arithmetic can be made to balance by
  // calling the leftover "subsidy".
  await rpc('generate', [1]);
  const emptyHash = await rpc('getblockhash', [await rpc('getblockcount')]);
  const emptyBlock = await rpc('getblock', [emptyHash, 2]);
  const subsidy = emptyBlock.tx[0].vout.reduce((s, o) => s + Math.round(Number(o.value) * COIN), 0);
  console.log('   a block with no transactions in it pays its miner ' + xvg(subsidy) + ' XVG');

  // Built and broadcast one at a time: three transactions funded against the same utxo set would
  // pick the same coins and conflict, and the second would be refused as a double spend rather
  // than for anything to do with its fee.
  async function mintAndSend(label, fee) {
    const built = await mintPaying(REF, fee, minter);
    const verdict = await rpc('testmempoolaccept', [[built.hex]]);
    const sent = await tryBroadcast(built.hex);
    return Object.assign({ label, allowed: verdict[0].allowed, reason: verdict[0]['reject-reason'] },
      built, sent);
  }

  const priced = await mintAndSend('pays the price', MINT_PRICE);
  const sizeKb = (await rpc('decoderawtransaction', [priced.hex])).size / 1000;
  console.log('   the paying mint is ' + Math.round(sizeKb * 1000) + ' bytes, so its fee rate is '
    + Math.round(MINT_PRICE / COIN / sizeKb).toLocaleString('en-US') + ' XVG/kB'
    + ', against a relay minimum of 0.2 XVG/kB');

  check('a mint paying thousands of times the relay minimum is standard', priced.allowed === true,
    priced.allowed ? 'accepted' : priced.reason);
  check('and sendrawtransaction takes it with no maxfeerate override', priced.accepted,
    priced.accepted ? priced.txid.slice(0, 16) + '...' : priced.reason);

  const underpaid = await mintAndSend('pays the relay minimum', DUST_UNITS);
  const overpaid = await mintAndSend('pays double', MINT_PRICE * 2);
  check('the underpaying and overpaying mints broadcast too', underpaid.accepted && overpaid.accepted,
    underpaid.accepted && overpaid.accepted
      ? 'so the protocol decides who minted, not the mempool'
      : [underpaid, overpaid].filter((m) => !m.accepted)
        .map((m) => m.label + ': ' + String(m.reason).slice(0, 70)).join(' | '));

  // The wall this design has to stay under, found by walking into it. It is an ABSOLUTE amount, not
  // a rate, so a bigger transaction buys no room, and it is what puts a ceiling on the mint price.
  const tooMuch = await mintPaying(REF, tickers.ABSURD_FEE_UNITS + 1, minter);
  const refused = await tryBroadcast(tooMuch.hex);
  check('a fee one unit over ' + xvg(tickers.ABSURD_FEE_UNITS) + ' XVG is refused by the node',
    !refused.accepted && /absurdly-high-fee/.test(refused.reason || ''),
    refused.accepted ? 'ACCEPTED, the ceiling moved' : String(refused.reason).slice(0, 60));
  const forced = await tryBroadcast(tooMuch.hex, [true]);
  check('and allowhighfees gets past it, so the ceiling is policy rather than consensus',
    forced.accepted,
    forced.accepted ? 'accepted with the override' : String(forced.reason).slice(0, 60));
  console.log('   which is why the builder caps a mint price at ' + xvg(tickers.MAX_MINT_PRICE)
    + ' XVG: above that, an ordinary wallet cannot mint the rune at all');

  // ---- 4. Does the money actually reach the miner ---------------------------------------------
  console.log('\n4. Following the fee into the block');
  const before = await rpc('getblockcount');
  await rpc('generate', [1]);
  const minedHash = await rpc('getblockhash', [before + 1]);
  const mined = await rpc('getblock', [minedHash, 2]);
  const coinbaseOut = mined.tx[0].vout.reduce((s, o) => s + Math.round(Number(o.value) * COIN), 0);

  // Every fee in the block, resolved from prevouts rather than taken from the wallet's word for it.
  let feesInBlock = 0;
  for (const tx of mined.tx.slice(1)) feesInBlock += await scanner.resolveFee(chain, tx);

  check('every mint broadcast landed in this block', mined.tx.length === 5,
    (mined.tx.length - 1) + ' transactions besides the coinbase');
  check('the coinbase is exactly the subsidy plus every fee in the block',
    coinbaseOut === subsidy + feesInBlock,
    xvg(coinbaseOut) + ' = ' + xvg(subsidy) + ' + ' + xvg(feesInBlock));
  check('and the mint price is inside that, so the miner is who receives it',
    feesInBlock >= MINT_PRICE * 3,
    'fees this block ' + xvg(feesInBlock) + ' XVG, of which one mint paid exactly ' + xvg(MINT_PRICE));

  // ---- 5. The fee the indexer computes, from prevouts, with no help --------------------------
  console.log('\n5. What the indexer sees');
  const pricedTx = await rpc('getrawtransaction', [priced.txid, true]);
  const seenFee = await scanner.resolveFee(chain, pricedTx);
  check('the indexer computes the same fee the wallet paid', seenFee === priced.fee,
    xvg(seenFee) + ' XVG against ' + xvg(priced.fee) + ' XVG');

  const underFee = await scanner.resolveFee(chain, await rpc('getrawtransaction', [underpaid.txid, true]));
  check('and the same for the underpaying one', underFee === underpaid.fee,
    xvg(underFee) + ' XVG');

  // getblock verbosity 3 would make all of this free, on a node that has it
  const v3 = await rpc('getblock', [minedHash, 3]).catch(() => null);
  const hasPrevout = !!(v3 && v3.tx && v3.tx[1] && v3.tx[1].vin && v3.tx[1].vin[0] && v3.tx[1].vin[0].prevout);
  console.log('   getblock verbosity 3 returns prevouts: ' + (hasPrevout ? 'yes' : 'NO, so every input costs a lookup'));

  // ---- 6. Who actually minted ------------------------------------------------------------------
  console.log('\n6. Applying the fee rule');
  const scan2 = await scanner.scanRange(chain, state, etchHeight + 1, before + 1, applyTx);
  const after = state.runes.get(REF);

  check('the mint that paid the price is credited',
    state.balanceOf(priced.txid + ':0', REF) === MINT_AMOUNT,
    state.balanceOf(priced.txid + ':0', REF) + ' units');
  check('the mint that overpaid is credited too',
    state.balanceOf(overpaid.txid + ':0', REF) === MINT_AMOUNT,
    state.balanceOf(overpaid.txid + ':0', REF) + ' units');
  check('the mint that paid the relay minimum is credited NOTHING',
    state.balanceOf(underpaid.txid + ':0', REF) === 0,
    'it paid ' + xvg(underpaid.fee) + ' XVG of the ' + xvg(MINT_PRICE) + ' XVG asked');
  // three of the four broadcast mints paid at or above the price: 20, 40, and the 50.000001 one that
  // needed the override to go out. Only the one that paid the relay minimum is refused.
  check('so the rune issued once for every mint that paid, and no others',
    after.mintCount === 3 && after.minted === 3 * MINT_AMOUNT,
    after.mintCount + ' mints, ' + after.minted + ' units');

  console.log('\n   fee lookups over ' + (scan2.applied + scan.applied) + ' transactions: '
    + (scan.feeLookups + scan2.feeLookups) + ', in ' + Math.round((Date.now() - t0)) + 'ms of scanning');

  // ---- 7. The rule cannot be dodged by putting the money somewhere else -----------------------
  console.log('\n7. Paying the price to anywhere other than the miner');
  const decoy = await rpc('getnewaddress');
  const decoyPlan = buildMint(REF, { address: minter, value: DUST_UNITS });
  const decoyRaw = await rpc('createrawtransaction', [[], [
    { [minter]: xvg(DUST_UNITS) },
    { [decoy]: xvg(MINT_PRICE) },                       // the price, paid to an address
    { data: decoyPlan.opReturn.toString('hex') },
  ]]);
  const decoyFunded = await rpc('fundrawtransaction', [decoyRaw]);
  const decoySigned = await rpc('signrawtransactionwithwallet', [decoyFunded.hex]);
  const decoySent = await tryBroadcast(decoySigned.hex);
  await rpc('generate', [1]);
  const scan3 = await scanner.scanRange(chain, state, before + 2, await rpc('getblockcount'), applyTx);
  check('a mint that pays the price to an address instead of the miner mints nothing',
    decoySent.accepted && state.balanceOf(decoySent.txid + ':0', REF) === 0,
    'the fee is the price, and an output is not a fee');

  // ---- 8. And the ticker cannot be taken without locking anything ------------------------------
  console.log('\n8. Etching the same ticker again, without paying for it');
  const tip = await rpc('getblockcount');
  const freeState = new RuneState();
  const etchTx = await rpc('getrawtransaction', [etchTxid, true]);
  const block = await rpc('getblock', [await rpc('getblockhash', [etchHeight]), 2]);
  const stripped = scanner.toIndexerTx(etchTx, etchHeight, 1, { time: block.time });
  // the same etching, in the same transaction, with the lock output removed
  stripped.outputs = stripped.outputs.filter((o) => !(o.scriptPubKey
    && o.scriptPubKey.equals(etch.lockScriptPubKey)));
  applyTx(freeState, stripped);
  check('with the lock output taken away, the identical etching takes no ticker',
    freeState.runes.size === 0 && freeState.tickers.size === 0,
    freeState.runes.size + ' runes registered');

  console.log('\n' + (failed ? failed + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nABORTED: ' + e.message); process.exit(1); });
