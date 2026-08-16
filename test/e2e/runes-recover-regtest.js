// Getting the ticker price back, with nothing but the key.
//
// A lock nobody can demonstrate opening is a promise, not a mechanism. test/e2e/timelock-regtest.js
// proved the CHAIN honours a CLTV lock; this proves the SHIPPED TOOL opens one, which is the part an
// etcher will need in 2030 and the part that has to still exist by then.
//
// The trap this exists to defuse: the money is not at the address of the key. It sits at a P2SH
// address built from the key AND the release date, so importing the key into an ordinary wallet
// shows nothing at all.
//
// Run (needs the regtest node): node test/e2e/runes-recover-regtest.js
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const bitcoin = require('bitcoinjs-lib');
const { pickNetwork } = require(path.join(ROOT, 'src/cli'));
const { ECPair } = require(path.join(ROOT, 'src/builder'));
const recover = require(path.join(ROOT, 'src/runes/recover'));

const COIN = 1e6;
let checks = 0, failed = 0;
const check = (name, cond, detail = '') => {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
};
const toUnits = (x) => Math.round(Number(x) * COIN);

(async () => {
  console.log('Reopening a locked ticker price, with only the key\n');
  const { network } = pickNetwork('regtest');

  // The key an etcher would have saved when they made their coin.
  const key = ECPair.makeRandom({ network });
  const wif = key.toWIF();

  // A lock that has already expired, so the trial does not take four years. The script shape and the
  // spend are identical; only the number differs.
  const locktime = Math.floor(Date.now() / 1000) - 7200;

  const { address: lockAddr } = recover.lockAddress({ locktime, wif, network });
  const ordinary = bitcoin.payments.p2pkh({ pubkey: Buffer.from(key.publicKey), network }).address;
  check('the locked money is NOT at the ordinary address of the key', lockAddr !== ordinary,
    lockAddr + ' vs ' + ordinary);
  check('and the same address comes back from the public key the chain published',
    recover.lockAddress({ locktime, pubkey: Buffer.from(key.publicKey), network }).address === lockAddr);

  // Pay the lock, exactly as an etching would.
  const PRICE = 2500 * COIN;
  const payTxid = await rpc('sendtoaddress', [lockAddr, Number((PRICE / COIN).toFixed(6))]);
  await rpc('generate', [2]);
  const payTx = await rpc('getrawtransaction', [payTxid, true]);
  const vout = payTx.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(lockAddr));
  check('the price sits at the lock address', vout >= 0 && toUnits(payTx.vout[vout].value) === PRICE,
    (PRICE / COIN) + ' XVG');

  // An ordinary wallet, told only the private key, sees nothing. This is the moment people panic.
  const seenByOrdinaryWallet = payTx.vout.filter((o) => (o.scriptPubKey.addresses || []).includes(ordinary));
  check('a wallet that only knows the key sees a balance of zero', seenByOrdinaryWallet.length === 0,
    'which is why this tool ships');

  // Now open it with the key alone.
  const mtp = (await rpc('getblockchaininfo')).mediantime;
  check('the chain agrees the lock has expired', recover.isOpen(locktime, mtp),
    'median time past ' + mtp + ' vs lock ' + locktime);

  const to = await rpc('getnewaddress');
  const FEE = 200000;
  const unlock = recover.buildUnlock({
    wif, locktime, to, fee: FEE, network,
    utxos: [{ txid: payTxid, vout, value: PRICE }],
  });

  const accepted = await rpc('testmempoolaccept', [[unlock.hex]]);
  check('the node accepts the unlock transaction', accepted[0].allowed === true,
    accepted[0]['reject-reason'] || '');

  const sweptTxid = await rpc('sendrawtransaction', [unlock.hex]);
  await rpc('generate', [1]);
  check('the unlock confirmed', !!sweptTxid);

  const sweptTx = await rpc('getrawtransaction', [sweptTxid, true]);
  const landed = sweptTx.vout
    .filter((o) => (o.scriptPubKey.addresses || []).includes(to))
    .reduce((s, o) => s + toUnits(o.value), 0);
  check('the whole price came back, less the fee', landed === PRICE - FEE,
    (landed / COIN) + ' of ' + (PRICE / COIN) + ' XVG');

  // And the refusal that makes the lock a lock: a spend that pretends there is no deadline.
  const lying = recover.buildUnlock({
    wif, locktime, to, fee: FEE, network,
    utxos: [{ txid: payTxid, vout, value: PRICE }],
  });
  const tampered = Buffer.from(lying.hex, 'hex');
  tampered.writeUInt32LE(0, tampered.length - 4); // nLockTime = 0
  const refused = await rpc('testmempoolaccept', [[tampered.toString('hex')]]);
  check('a spend that drops the deadline is refused', refused[0].allowed === false,
    refused[0]['reject-reason'] || '');

  console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' FAILED') + '  (' + checks + ' checks)');
  console.log('  the key alone reopened ' + (PRICE / COIN) + ' XVG from ' + lockAddr);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nERROR: ' + e.message); process.exit(1); });
