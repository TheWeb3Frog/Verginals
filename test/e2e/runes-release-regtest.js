// The pre-signed release, end to end on a chain, with the key destroyed before the money moves.
//
// This exists for one link that no other test touches: signing a spend against an output that DOES
// NOT EXIST YET, and having a node accept it years later. Everything else about the scheme is
// already proven (timelock-regtest.js showed the chain refuses a CLTV spend before its timestamp
// and releases it after; runes-recover-regtest.js showed the shipped tool opens a real lock), and
// a signature carries no record of when it was made, so a pre-signed release is the same object
// those tests broadcast. What was never demonstrated is that it can be made BEFORE the lock is
// funded, and spent AFTER the key is gone.
//
// The order below is the whole point and must not be rearranged:
//   fund tx signed but NOT broadcast -> release pre-signed against it -> key destroyed
//   -> fund broadcast -> release refused (too early) -> time passes -> release accepted
//
// Verge's generatetoaddress refuses the block it just made on regtest, a multi-algo quirk; the
// older generate works and mines to the wallet, which is all this needs.
//
// Run (needs the isolated regtest node): node test/e2e/runes-release-regtest.js
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const bitcoin = require('bitcoinjs-lib');
const { pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { ECPair } = require(path.join(ROOT, 'src/builder'));
const recover = require(path.join(ROOT, 'src/runes/recover'));
const R = require(path.join(ROOT, 'src/runes/release'));

const COIN = 1e6;
let checks = 0, failed = 0;
const check = (name, cond, detail = '') => {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
};

(async () => {
  console.log('The pre-signed release: signed early, spent with no key\n');
  const { network } = pickNetwork('regtest');

  // --- a chain with money on it ---------------------------------------------------------------
  const wallets = await rpc('listwallets').catch(() => []);
  if (!wallets.length) await rpc('createwallet', ['rt']).catch(() => {});
  const info = await rpc('getblockchaininfo');
  if (info.blocks < 120) await rpc('generate', [130 - info.blocks]);
  const bal = await rpc('getbalance');
  check('the regtest wallet has coins to lock', bal > 3000, 'balance ' + bal);

  // --- what an etcher holds at etch time -------------------------------------------------------
  const lockKey = ECPair.makeRandom({ network });
  let wif = lockKey.toWIF();                       // destroyed further down, on purpose
  const homeKey = ECPair.makeRandom({ network });
  const home = bitcoin.payments.p2pkh({ pubkey: homeKey.publicKey, network }).address;

  const tip = await rpc('getblockchaininfo');
  const LOCK_FOR = 300;                            // five minutes stands in for 1460 days
  const locktime = tip.mediantime + LOCK_FOR;
  const lock = recover.lockAddress({ locktime, wif, network });
  console.log('  lock address', lock.address, 'opens at', new Date(locktime * 1000).toISOString());

  // --- the funding transaction, SIGNED BUT NOT BROADCAST ---------------------------------------
  const PRICE = 2500;
  const draft = await rpc('createrawtransaction', [[], { [lock.address]: PRICE }]);
  const funded = await rpc('fundrawtransaction', [draft]);
  const signedFund = await rpc('signrawtransactionwithwallet', [funded.hex]);
  check('the funding transaction is signed', signedFund.complete === true);

  const decoded = await rpc('decoderawtransaction', [signedFund.hex]);
  const fundTxid = decoded.txid;
  const lockVout = decoded.vout.findIndex((o) => (o.scriptPubKey.addresses || [o.scriptPubKey.address]).includes(lock.address));
  check('the lock output is identified before broadcast', lockVout >= 0, 'vout ' + lockVout);

  const inMempool = await rpc('getrawtransaction', [fundTxid]).then(() => true).catch(() => false);
  check('and that output does not exist on the chain yet', inMempool === false);

  // --- pre-sign the release against an output that is not there ---------------------------------
  const rel = recover.buildUnlock({
    wif, locktime, network, to: home, fee: R.DEFAULT_FEE,
    utxos: [{ txid: fundTxid, vout: lockVout, value: PRICE * COIN }],
  });
  const payload = R.encodeRelease(rel.hex);
  console.log('  release', rel.txid.slice(0, 16) + '…', payload.length, 'bytes of payload');

  // --- verify it the way a stranger would, then throw the key away -------------------------------
  const spk = Buffer.from(decoded.vout[lockVout].scriptPubKey.hex, 'hex');
  const back = R.decodeRelease(payload);
  const v = R.verifyRelease({ hex: back.txHex, lockScriptPubKey: spk, lockValue: PRICE * COIN, network });
  check('a stranger can verify it from the bytes alone', v.ok === true, v.reason);
  check('and it pays the etcher, not the lock', v.to === home);

  const wifWas = wif;
  wif = null;
  check('the key is destroyed before the money moves', wif === null && wifWas !== null);

  // --- now let the lock exist -------------------------------------------------------------------
  await rpc('sendrawtransaction', [signedFund.hex]);
  await rpc('generate', [1]);
  const utxo = await rpc('gettxout', [fundTxid, lockVout]);
  check('the ticker price is locked on chain', utxo && Math.round(utxo.value * COIN) === PRICE * COIN,
    utxo ? String(utxo.value) : 'missing');

  // --- too early ---------------------------------------------------------------------------------
  const early = await rpc('testmempoolaccept', [[rel.hex]]);
  const why = String(early[0]['reject-reason'] || early[0].reason || '');
  check('the chain refuses the release before the lock opens', early[0].allowed === false, why);
  // A refusal with the wrong reason would prove nothing: an unfunded or malformed transaction is
  // also refused, and that is not what is being demonstrated here.
  check('and it refuses it for the timelock, not for anything else', /non-?final/i.test(why), why);

  // --- let the clock run --------------------------------------------------------------------------
  // Median time past is the median of the last 11 blocks, so the clock has to be pushed and then
  // eleven blocks mined before the node agrees the deadline has passed.
  await rpc('setmocktime', [locktime + 600]);
  await rpc('generate', [12]);
  const after = await rpc('getblockchaininfo');
  check('median time past is now beyond the lock', after.mediantime >= locktime,
    after.mediantime + ' vs ' + locktime);

  // --- broadcast with no key anywhere ------------------------------------------------------------
  let sent = null, sendErr = null;
  try { sent = await rpc('sendrawtransaction', [rel.hex]); } catch (e) { sendErr = e.message; }
  check('the node accepts the release, signed years earlier', sent === rel.txid, sendErr || String(sent));

  await rpc('generate', [1]);
  const conf = await rpc('getrawtransaction', [rel.txid, 1]);
  check('the release confirmed', conf.confirmations >= 1, String(conf.confirmations));

  const out = conf.vout[0];
  const landedAt = (out.scriptPubKey.addresses || [out.scriptPubKey.address])[0];
  check('the coins landed at the etcher ordinary address', landedAt === home, landedAt + ' vs ' + home);
  check('the whole price came back, less the fee',
    Math.round(out.value * COIN) === PRICE * COIN - R.DEFAULT_FEE,
    out.value + ' XVG');

  const still = await rpc('gettxout', [fundTxid, lockVout]);
  check('and the lock is emptied', still === null);

  await rpc('setmocktime', [0]).catch(() => {});
  console.log(`\n${checks - failed}/${checks} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nthe run stopped: ' + e.message); process.exit(1); });
