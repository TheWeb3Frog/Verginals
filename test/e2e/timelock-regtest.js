// Etch an asset, pay for it into a time-locked output, and prove the payment cannot move until the
// lock expires. Run on an isolated regtest chain: the public Verge testnet has no reliable block
// production, and a lock test is meaningless without blocks.
//
// Two lock flavours are covered, because a real multi-year lock has to choose one and they behave
// very differently:
//
//   nLockTime <  500000000   a block HEIGHT. Exact, but block spacing drifts over years.
//   nLockTime >= 500000000   a unix TIMESTAMP, compared against the block's median time past
//                            (BIP113), which trails the wall clock by the median of the last 11
//                            block times. A "5 minute" lock is therefore never 5 minutes.
//
// It also answers the two standardness questions the locked-payment design depends on: whether a
// P2SH CLTV output relays, and whether a second OP_RETURN in one transaction is standard.
//
// Run: RT_WALLET=<wallet> node test/e2e/timelock-regtest.js
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const bitcoin = require(path.join(ROOT, 'node_modules/bitcoinjs-lib'));
const ecc = require(path.join(ROOT, 'node_modules/tiny-secp256k1'));
const { rpc } = require('./rpc.js');
const { buildPlan, revealFromPlan, pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { buildEtch, DUST_UNITS } = require(path.join(ROOT, 'src/assets/builder'));
const { detectEtching } = require(path.join(ROOT, 'src/assets/scanner'));
const { pushData } = require(path.join(ROOT, 'src/envelope'));
const { serializeTx, legacySighash, SIGHASH_ALL } = require(path.join(ROOT, 'src/vergetx'));

const COIN = 1e6;
const ETCH_PRICE = 100000;        // XVG, the price of the ticker
const LOCK_SECONDS = 300;         // the 5 minutes asked for
const LOCK_BLOCKS = 10;           // ~5 minutes at Verge's 30s target spacing

let checks = 0, failed = 0;
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log('  ok   - ' + name + (detail ? '  [' + detail + ']' : ''));
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}
const xvg = (units) => Number((units / COIN).toFixed(6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- script assembly ---------------------------------------------------------------------------

/** Minimal CScriptNum, the encoding OP_CHECKLOCKTIMEVERIFY expects its argument in. */
function encodeNum(n) {
  if (n === 0) return Buffer.alloc(0);
  const bytes = [];
  let abs = Math.abs(n);
  while (abs > 0) { bytes.push(abs & 0xff); abs = Math.floor(abs / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(n < 0 ? 0x80 : 0x00);
  else if (n < 0) bytes[bytes.length - 1] |= 0x80;
  return Buffer.from(bytes);
}

/** <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG */
function cltvRedeemScript(locktime, pubkeyHex) {
  return Buffer.concat([
    pushData(encodeNum(locktime)),
    Buffer.from([0xb1, 0x75]),                 // OP_CHECKLOCKTIMEVERIFY, OP_DROP
    pushData(Buffer.from(pubkeyHex, 'hex')),
    Buffer.from([0xac]),                       // OP_CHECKSIG
  ]);
}

/**
 * A key generated here rather than in the node's wallet. That is not a convenience: Verge Core
 * cannot sign this script at all. Its signing routines only solve recognised templates (P2PK,
 * P2PKH, multisig, and P2SH wrapping those), and a CLTV script is none of them, so
 * signrawtransactionwithkey answers "invalid stack size (possibly missing key)" no matter which
 * key it is handed. Anyone locking coins this way has to bring their own signer to get them back.
 */
function freshKey() {
  let priv;
  do { priv = crypto.randomBytes(32); } while (!ecc.isPrivate(priv));
  const pub = Buffer.from(ecc.pointFromScalar(priv, true));
  return { priv, pub, pubkey: pub.toString('hex') };
}

/**
 * Build and sign a spend of a CLTV output by hand. Two conditions have to hold at once or the lock
 * is not even consulted: nSequence must be below 0xffffffff, and the transaction's own nLockTime
 * must reach the value the script demands.
 */
function spendLocked(locked, key, destination, nLockTime, network) {
  const fee = 500000;   // 0.5 XVG. Verge's mempool floor is 0.1 XVG, well above Bitcoin's.
  const redeem = Buffer.from(locked.redeemScript, 'hex');
  const tx = {
    version: 1,
    time: Math.floor(Date.now() / 1000),
    vin: [{ txid: locked.txid, vout: locked.vout, sequence: 0xfffffffe, script: Buffer.alloc(0) }],
    vout: [{ value: locked.units - fee, script: bitcoin.address.toOutputScript(destination, network) }],
    locktime: nLockTime >>> 0,
  };
  const sighash = legacySighash(tx, 0, redeem, SIGHASH_ALL);
  const sig = Buffer.from(ecc.sign(sighash, key.priv));
  if (!ecc.verify(sighash, key.pub, sig)) throw new Error('signature self-check failed');
  const encoded = bitcoin.script.signature.encode(sig, SIGHASH_ALL);
  tx.vin[0].script = Buffer.concat([pushData(encoded), pushData(redeem)]);
  return serializeTx(tx).toString('hex');
}

/** Broadcast, and report refusal as an outcome rather than an exception. */
async function tryBroadcast(hex) {
  try { return { accepted: true, txid: await rpc('sendrawtransaction', [hex]) }; }
  catch (e) { return { accepted: false, reason: e.message }; }
}

async function medianTimePast() {
  const tip = await rpc('getblockchaininfo');
  return (await rpc('getblockheader', [tip.bestblockhash])).mediantime;
}

// --- the trial ---------------------------------------------------------------------------------

(async () => {
  const info = await rpc('getblockchaininfo');
  if (info.chain !== 'regtest') {
    console.error('REFUSING TO RUN: chain is "' + info.chain + '", not regtest.');
    process.exit(2);
  }
  console.log('Etch and time-locked payment on regtest\n');
  console.log('  chain ' + info.chain + ', height ' + info.blocks + ', node RPC 18443\n');

  const { network } = pickNetwork('regtest');
  const holder = await rpc('getnewaddress');
  const sweepTo = await rpc('getnewaddress');

  // ---- 1. Etch the asset for real -------------------------------------------------------------
  console.log('1. Etching');
  const etch = buildEtch({
    ticker: 'LOCKED', name: 'Locked Payment Trial', divisibility: 2,
    supply: 2100000000, premine: 100000,
  }, { address: holder, value: DUST_UNITS });

  const plan = buildPlan({
    body: etch.body, contentType: etch.contentType, networkName: 'regtest',
    amount: 2 * DUST_UNITS, file: 'locked.cbor',
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
  const reveal = revealFromPlan({ plan, utxos, to: holder, fee: DUST_UNITS, values, network });
  const etchTxid = await rpc('sendrawtransaction', [reveal.hex]);
  await rpc('generate', [1]);
  check('the etching reveal confirmed', !!etchTxid, etchTxid.slice(0, 16) + '...');

  const revealTx = await rpc('getrawtransaction', [etchTxid, true]);
  const found = detectEtching(revealTx);
  check('the scanner finds the asset on chain unaided', !!found && found.ticker === 'LOCKED',
    found ? found.ticker + ', supply ' + found.supply : 'not found');

  // ---- 2. Pay the ticker price into two locked outputs ----------------------------------------
  console.log('\n2. Paying ' + ETCH_PRICE.toLocaleString('en-US') + ' XVG into locked outputs');
  const height = await rpc('getblockcount');
  const mtp = await medianTimePast();
  const heightLock = height + LOCK_BLOCKS;
  // Deliberately anchored on the wall clock, because that is what a wallet offering "lock for five
  // minutes" would compute. The chain judges it against median time past, which trails the wall
  // clock, so the lock will outlast its nominal duration. Anchoring on mtp instead would make it
  // expire EARLY, by the size of that same lag.
  const timeLock = Math.floor(Date.now() / 1000) + LOCK_SECONDS;

  const keyH = freshKey();
  const keyT = freshKey();
  const redeemH = cltvRedeemScript(heightLock, keyH.pubkey);
  const redeemT = cltvRedeemScript(timeLock, keyT.pubkey);
  const p2shH = (await rpc('decodescript', [redeemH.toString('hex')])).p2sh;
  const p2shT = (await rpc('decodescript', [redeemT.toString('hex')])).p2sh;
  console.log('   height lock -> block ' + heightLock + ' (tip is ' + height + ')');
  console.log('   time lock   -> unix ' + timeLock + ' (wall clock +' + LOCK_SECONDS + 's;'
    + ' the tip\'s median time past already trails the clock by '
    + (Math.floor(Date.now() / 1000) - mtp) + 's)');

  const payRaw = await rpc('createrawtransaction', [[], {
    [p2shH]: xvg(ETCH_PRICE * COIN),
    [p2shT]: xvg(ETCH_PRICE * COIN),
  }]);
  const payFunded = await rpc('fundrawtransaction', [payRaw]);
  const paySigned = await rpc('signrawtransactionwithwallet', [payFunded.hex]);

  const relay = await rpc('testmempoolaccept', [[paySigned.hex]]);
  check('a P2SH CLTV output relays as a standard transaction', relay[0].allowed === true,
    relay[0].allowed ? 'accepted' : relay[0]['reject-reason']);

  const payTxid = await rpc('sendrawtransaction', [paySigned.hex]);
  await rpc('generate', [1]);
  const payTx = await rpc('getrawtransaction', [payTxid, true]);
  const voutOf = (addr) => payTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(addr));

  const lockedH = {
    txid: payTxid, vout: voutOf(p2shH), units: ETCH_PRICE * COIN,
    scriptPubKey: payTx.vout[voutOf(p2shH)].scriptPubKey.hex, redeemScript: redeemH.toString('hex'),
  };
  const lockedT = {
    txid: payTxid, vout: voutOf(p2shT), units: ETCH_PRICE * COIN,
    scriptPubKey: payTx.vout[voutOf(p2shT)].scriptPubKey.hex, redeemScript: redeemT.toString('hex'),
  };
  check('both locked payments confirmed on chain', lockedH.vout >= 0 && lockedT.vout >= 0,
    'vout ' + lockedH.vout + ' and ' + lockedT.vout);

  // ---- 3. Try to spend while locked -----------------------------------------------------------
  console.log('\n3. Spending DURING the lock (both must be refused)');

  const earlyH = await tryBroadcast(spendLocked(lockedH, keyH, sweepTo, heightLock, network));
  check('height lock refuses the spend before its block', !earlyH.accepted,
    earlyH.accepted ? 'ACCEPTED, the lock did nothing' : earlyH.reason.slice(0, 60));

  const earlyT = await tryBroadcast(spendLocked(lockedT, keyT, sweepTo, timeLock, network));
  check('time lock refuses the spend before its timestamp', !earlyT.accepted,
    earlyT.accepted ? 'ACCEPTED, the lock did nothing' : earlyT.reason.slice(0, 60));

  // The interesting failure: claiming an nLockTime the script will not accept.
  const lying = await tryBroadcast(spendLocked(lockedH, keyH, sweepTo, 0, network));
  check('a spend that drops nLockTime entirely is refused too', !lying.accepted,
    lying.accepted ? 'ACCEPTED' : lying.reason.slice(0, 60));

  // ---- 4. Height lock: mine to it and spend ---------------------------------------------------
  console.log('\n4. Height lock: mining to block ' + heightLock);
  while ((await rpc('getblockcount')) < heightLock) await rpc('generate', [1]);
  const atHeight = await rpc('getblockcount');
  const lateH = await tryBroadcast(spendLocked(lockedH, keyH, sweepTo, heightLock, network));
  check('height lock releases the coins at its block', lateH.accepted,
    lateH.accepted ? 'spent at height ' + atHeight : lateH.reason.slice(0, 80));

  // ---- 5. Time lock: wait, then watch median time past catch up -------------------------------
  console.log('\n5. Time lock: waiting out the ' + LOCK_SECONDS + ' seconds');
  const startedAt = Date.now();
  let attempts = 0;
  let lateT = { accepted: false, reason: 'never attempted' };
  while (Date.now() - startedAt < 25 * 60 * 1000) {
    await sleep(15000);
    await rpc('generate', [1]);                       // a block, carrying the current wall clock
    const nowMtp = await medianTimePast();
    attempts += 1;
    const waited = Math.round((Date.now() - startedAt) / 1000);
    if (nowMtp < timeLock) {
      if (attempts % 4 === 0) console.log('   waited ' + waited + 's, mtp still ' + (timeLock - nowMtp) + 's short');
      continue;
    }
    lateT = await tryBroadcast(spendLocked(lockedT, keyT, sweepTo, timeLock, network));
    console.log('   released after ' + waited + 's of wall clock, for a lock asked to last '
      + LOCK_SECONDS + 's: ' + (waited - LOCK_SECONDS) + 's late, which is the median-time-past lag');
    break;
  }
  check('time lock releases the coins once median time past reaches it', lateT.accepted,
    lateT.accepted ? 'spent' : lateT.reason.slice(0, 80));

  await rpc('generate', [1]);
  const swept = await rpc('getreceivedbyaddress', [sweepTo, 1]);
  check('the recovered coins landed in the destination wallet', swept > 0, swept + ' XVG');

  // ---- 6. The other standardness question -----------------------------------------------------
  console.log('\n6. Standardness: how many OP_RETURN outputs one transaction may carry');
  const dataA = Buffer.from('first payload').toString('hex');
  const dataB = Buffer.from('second payload').toString('hex');

  async function fundSignAccept(rawHex) {
    const funded = await rpc('fundrawtransaction', [rawHex]);
    const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
    const [verdict] = await rpc('testmempoolaccept', [[signed.hex]]);
    return verdict;
  }

  const one = await fundSignAccept(await rpc('createrawtransaction', [[], { data: dataA }]));
  check('one OP_RETURN is standard (control)', one.allowed === true,
    one.allowed ? 'accepted' : one['reject-reason']);

  // The object form of `outputs` cannot hold two `data` keys, so the array form is the only way to
  // ask the question. A node too old to accept it cannot answer, which is itself worth reporting.
  let two = null;
  try {
    two = await fundSignAccept(await rpc('createrawtransaction', [[], [{ data: dataA }, { data: dataB }]]));
  } catch (e) {
    console.log('   could not build two OP_RETURNs through this node: ' + e.message.slice(0, 90));
  }
  if (two) {
    console.log('   two OP_RETURNs -> ' + (two.allowed ? 'ACCEPTED' : 'rejected: ' + two['reject-reason']));
    console.log('   ' + (two.allowed
      ? 'a lock reference could travel in its own output, beside the etch payload.'
      : 'anything extra must fit in the etch OP_RETURN, or be derivable rather than published.'));
  }

  console.log('\n' + (failed ? failed + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nABORTED: ' + e.message); process.exit(1); });
