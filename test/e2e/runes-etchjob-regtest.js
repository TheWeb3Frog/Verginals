// The hosted etch, end to end on a live regtest chain.
//
// Everything before this either composed an etching without paying for it, or paid for it by hand.
// This is the flow a stranger with a browser would actually go through: they are quoted a price,
// they send ONE payment to one address, and a rune exists.
//
// The part worth proving is the part that costs money: the ticker price has to land in the P2SH
// CLTV lock, in the SAME transaction as the inscription, or the etcher pays and claims nothing.
//
// Run (needs the regtest node): node test/e2e/runes-etchjob-regtest.js
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const bitcoin = require('bitcoinjs-lib');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { buildFundingTx, ECPair } = require(path.join(ROOT, 'src/builder'));
const etchjob = require(path.join(ROOT, 'src/runes/etchjob'));
const tickers = require(path.join(ROOT, 'src/runes/tickers'));
const { RuneState, applyTx } = require(path.join(ROOT, 'src/runes/indexer'));
const { scanRange } = require(path.join(ROOT, 'src/runes/scanner'));
const { stateRoot, proveBalance, proveRune, verifyBalance } = require(path.join(ROOT, 'src/runes/checkpoint'));

const COIN = 1e6;
let checks = 0, failed = 0;
const check = (name, cond, detail = '') => {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
};
const toUnits = (xvg) => Math.round(Number(xvg) * COIN);
const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (h, v) => rpc('getblock', [h, v]),
};

(async () => {
  console.log('The hosted etch, on regtest\n');
  const { network } = pickNetwork('regtest');
  const start = (await rpc('getblockchaininfo')).blocks;
  const TICKER = 'HOSTED' + (start % 100);   // a fresh name on every run
  const recipient = await rpc('getnewaddress');

  // ---- 1. the quote: one price, one address ----------------------------------------------------
  const lockKey = ECPair.makeRandom({ network });
  const locktime = Math.floor(Date.now() / 1000) + tickers.LOCK_SECONDS + 86400;
  const quote = etchjob.quoteEtch({
    rune: { ticker: TICKER, name: 'Hosted Etch', divisibility: 2, supply: 1000000, premine: 250000,
      terms: { amount: 5000, cap: 50, price: 20 * COIN } },
    recipient, lockPubkey: Buffer.from(lockKey.publicKey), locktime,
    buildPlan, networkName: 'regtest',
  });
  const lockAddress = bitcoin.address.fromOutputScript(quote.etch.lockScriptPubKey, network);

  check('the quote prices the ticker by its length',
    quote.price === tickers.priceOf(TICKER), (quote.price / COIN) + ' XVG for ' + TICKER.length + ' chars');
  check('and the total covers the price, the inscription and both fees',
    quote.total > quote.price && quote.total === quote.numInputs * quote.perInput
      + quote.priceHolder + quote.splitFee + quote.revealFee,
    (quote.total / COIN) + ' XVG total');

  // ---- 2. the etcher pays once -----------------------------------------------------------------
  const depositKey = ECPair.makeRandom({ network });
  const depositAddress = bitcoin.payments.p2pkh({ pubkey: Buffer.from(depositKey.publicKey), network }).address;
  const depositTxid = await rpc('sendtoaddress', [depositAddress, Number((quote.total / COIN).toFixed(6))]);
  await rpc('generate', [1]);
  // Read the deposit straight from the transaction rather than through listunspent: the node's
  // wallet does not own this address, so it would report nothing. A server doing this for real
  // watches the address it generated, which it does own.
  const depositTx = await rpc('getrawtransaction', [depositTxid, true]);
  const funded = depositTx.vout
    .filter((o) => (o.scriptPubKey.addresses || []).includes(depositAddress))
    .map((o) => ({ txid: depositTxid, vout: o.n, amount: o.value }));
  const received = funded.reduce((s, u) => s + toUnits(u.amount), 0);
  check('the single deposit covers the whole quote', received >= quote.total,
    (received / COIN) + ' of ' + (quote.total / COIN));

  // ---- 3. the server splits it -----------------------------------------------------------------
  const split = buildFundingTx({
    network,
    inputs: funded.map((u) => ({ txid: u.txid, vout: u.vout, value: toUnits(u.amount) })),
    outputs: etchjob.splitOutputs(quote, depositAddress),
    signer: depositKey,
  });
  const splitTxid = await rpc('sendrawtransaction', [split.hex]);
  await rpc('generate', [1]);
  check('the split funds every commit output plus the ticker price', !!splitTxid);

  // ---- 4. and reveals, paying the price into the lock -------------------------------------------
  const reveal = revealFromPlan({
    plan: quote.plan,
    utxos: quote.plan.inputs.map((_, i) => `${splitTxid}:${i}`),
    values: quote.plan.inputs.map(() => quote.perInput),
    to: recipient,
    fee: quote.revealFee,
    pay: etchjob.payFor(quote, splitTxid, depositKey.toWIF(), depositAddress, lockAddress),
  });
  const etchTxid = await rpc('sendrawtransaction', [reveal.hex]);
  await rpc('generate', [1]);
  check('the node accepted the etching reveal', !!etchTxid);

  // The decisive one: the price must be an output OF THIS TRANSACTION, paid to the lock.
  const revealTx = await rpc('getrawtransaction', [etchTxid, true]);
  const toLock = revealTx.vout
    .filter((o) => (o.scriptPubKey.addresses || []).includes(lockAddress))
    .reduce((s, o) => s + toUnits(o.value), 0);
  check('the ticker price is locked in the etching itself', toLock === quote.price,
    (toLock / COIN) + ' XVG into ' + lockAddress);

  // ---- 5. an indexer that was told nothing finds the rune ---------------------------------------
  const end = (await rpc('getblockchaininfo')).blocks;
  const state = new RuneState();
  await scanRange(chain, state, start + 1, end, applyTx);

  check('replaying blocks alone registers the rune', state.tickers.has(TICKER),
    'saw: ' + [...state.tickers.keys()].join(','));
  const ref = state.tickers.get(TICKER);
  const held = [...state.entries()].filter((e) => e.runeRef === ref).reduce((s, e) => s + e.amount, 0);
  check('the premine landed with the etcher', held === 250000, 'held ' + held);
  check('the reference is the position the reveal confirmed at',
    ref === `${revealTx.height || (await rpc('getblock', [revealTx.blockhash])).height}:${
      (await rpc('getblock', [revealTx.blockhash, 2])).tx.findIndex((t) => t.txid === etchTxid)}`,
    ref);

  // ---- 6. and a wallet can prove it without trusting the indexer --------------------------------
  const root = stateRoot(state);
  const bal = [...state.entries()].find((e) => e.runeRef === ref);
  const bp = proveBalance(state, bal.outpoint, ref);
  const rp = proveRune(state, ref);
  check('the balance proves against the state root', verifyBalance(bp.entry, bp.path, root));
  check('and so does what the reference MEANS', verifyBalance(rp.entry, rp.path, root)
    && rp.entry.ticker === TICKER);
  check('a lie about the amount does not survive',
    !verifyBalance(Object.assign({}, bp.entry, { amount: bp.entry.amount + 1 }), bp.path, root));

  console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' FAILED') + '  (' + checks + ' checks)');
  console.log(`  ${TICKER} etched at ${ref} for ${(quote.total / COIN)} XVG all in`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nERROR: ' + e.message); process.exit(1); });
