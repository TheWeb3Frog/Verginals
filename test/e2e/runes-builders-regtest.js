// Builders against a live regtest chain (RUNES-PLAN §2.2 / §2.3).
//
// The unit tests prove the builders order outputs correctly in memory. This proves the ordering
// survives contact with a real node: two recipients, two different runes, broadcast for real, read
// back through the scanner, and each balance must land on the address the plan intended. An
// off-by-one here would pay the wrong person, and nothing downstream would notice.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { rpc } = require('./rpc.js');
const codec = require(path.join(ROOT, 'src/runes/codec'));
const { RuneState, applyTx, runeRefOf } = require(path.join(ROOT, 'src/runes/indexer'));
const { lockFor } = require(path.join(ROOT, 'test/fixtures/etchlock'));
const { scanRange } = require(path.join(ROOT, 'src/runes/scanner'));
const { buildTransfer, buildMint, DUST_UNITS } = require(path.join(ROOT, 'src/runes/builder'));
const { selectCoins, assertNoRunesSpent } = require(path.join(ROOT, 'src/runes/coinselect'));

const COIN = 1e6;
let checks = 0, failed = 0;
function check(name, cond, detail = '') {
  checks += 1;
  if (cond) console.log('  ok   - ' + name);
  else { failed += 1; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}

/**
 * Turn a builder plan into a funded, signed, broadcast transaction.
 *
 * Two things here are not incidental, they are protocol requirements a real wallet must honour:
 *
 *  1. `mustSpend` pins the rune-carrying outpoints as inputs. A transaction that does not spend the
 *     utxo holding the balance has nothing to move, and its edicts do nothing. This is what
 *     coinselect.js exists to get right.
 *  2. `changePosition` is pinned to the END. fundrawtransaction inserts change at a RANDOM index by
 *     default, which would silently renumber the outputs an edict points at and pay the wrong party.
 */
async function broadcast(plan, mustSpend = []) {
  const outs = {};
  let count = 0;
  for (const o of plan.outputs) {
    if (o.isOpReturn) { outs.data = o.data.toString('hex'); count += 1; continue; }
    if (o.isChange) continue;
    outs[o.address] = Number((o.value / COIN).toFixed(6));
    count += 1;
  }
  const raw = await rpc('createrawtransaction', [mustSpend, outs]);
  const funded = await rpc('fundrawtransaction', [raw, { changePosition: count }]);
  const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
  if (!signed.complete) throw new Error('signing incomplete');
  return rpc('sendrawtransaction', [signed.hex]);
}

const chain = {
  getBlockHash: (h) => rpc('getblockhash', [h]),
  getBlock: (hash, v) => rpc('getblock', [hash, v]),
};

(async () => {
  console.log('Verge Runes builders on regtest\n');

  const start = (await rpc('getblockchaininfo')).blocks;
  const REF = runeRefOf(start + 1, 1);
  const addr1 = await rpc('getnewaddress');
  const addr2 = await rpc('getnewaddress');

  // The rune, etched synthetically at the height we reference (etch-via-inscription is phase 2).
  const etching = { ticker: 'BLDR', name: 'Builder', divisibility: 2, supply: 1000000, premine: 500000,
    terms: { amount: 2500 } };
  const state = new RuneState();
  // It has to pay for the ticker (§7.2) or it registers nothing, and every check below that expects
  // a balance would read zero.
  const paid = lockFor('BLDR');
  applyTx(state, {
    txid: 'synthetic-etch', height: start + 1, txIndex: 1, inputs: [], time: paid.time,
    outputs: [{ value: DUST_UNITS, scriptPubKey: Buffer.alloc(1), isOpReturn: false }, paid.output],
    etching: Object.assign({ lock: paid.lock }, etching),
  });

  // ---- 1. a real mint built by buildMint ------------------------------------------------------
  const mintPlan = buildMint(REF, { address: addr1, value: DUST_UNITS });
  check('buildMint puts the recipient before the message', !mintPlan.outputs[0].isOpReturn);
  const mintTxid = await broadcast(mintPlan);
  await rpc('generate', [1]);
  check('the node accepted a builder-produced mint', !!mintTxid);

  // Scan up to here FIRST: the mint output is about to be spent by the transfer below, so its
  // balance has to be observed while it still exists.
  const afterMint = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, start + 1, afterMint, applyTx);
  const mintTxLook = await rpc('getrawtransaction', [mintTxid, true]);
  const mintedVout = mintTxLook.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(addr1));
  check('the real mint credited exactly the terms amount to the intended output',
    state.balanceOf(`${mintTxid}:${mintedVout}`, REF) === 2500,
    'got ' + state.balanceOf(`${mintTxid}:${mintedVout}`, REF));

  // ---- 2. a real two-recipient transfer built by buildTransfer ---------------------------------
  // Both edicts name the SAME rune but different outputs, which is where an index mistake shows.
  //
  // First find the outpoint that actually holds the minted balance: the transfer MUST spend it, or
  // the edicts have nothing to move. Coin selection is what does this in a real wallet.
  const mintTxEarly = await rpc('getrawtransaction', [mintTxid, true]);
  const carrierVout = mintTxEarly.vout.findIndex((o) => (o.scriptPubKey.addresses || []).includes(addr1));
  const carrierUtxo = { txid: mintTxid, vout: carrierVout, value: DUST_UNITS, runes: { [REF]: 2500 } };
  const selection = selectCoins({
    utxos: [carrierUtxo, { txid: 'external', vout: 0, value: 100 * DUST_UNITS }],
    targetValue: 2 * DUST_UNITS, fee: DUST_UNITS,
    requiredRunes: [{ runeRef: REF, amount: 2500 }],
  });
  check('coin selection picked the real carrier outpoint',
    selection.inputs.some((u) => u.txid === mintTxid && u.vout === carrierVout));

  const transferPlan = buildTransfer([
    { address: addr1, value: DUST_UNITS, runes: [{ runeRef: REF, amount: 1000 }] },
    { address: addr2, value: DUST_UNITS, runes: [{ runeRef: REF, amount: 1500 }] },
  ]);
  const decoded = codec.decode(transferPlan.opReturn);
  check('the plan encodes one edict per recipient', decoded.edicts.length === 2);
  const transferTxid = await broadcast(transferPlan, [{ txid: mintTxid, vout: carrierVout }]);
  await rpc('generate', [1]);
  check('the node accepted a builder-produced transfer', !!transferTxid);

  // ---- 3. replay the remaining blocks and check where the balances landed ----------------------
  const end = (await rpc('getblockchaininfo')).blocks;
  await scanRange(chain, state, afterMint + 1, end, applyTx);

  check('spending the carrier consumed its balance',
    state.balanceOf(`${mintTxid}:${mintedVout}`, REF) === 0);

  // The decisive check: resolve each output's real address from the chain, and confirm the amount
  // the plan promised that address is the amount it actually holds.
  const tTx = await rpc('getrawtransaction', [transferTxid, true]);
  const addrOfVout = (i) => ((tTx.vout[i].scriptPubKey.addresses || [])[0]) || null;
  const planned = new Map(); // address -> amount the plan intended
  for (const e of decoded.edicts) planned.set(transferPlan.outputs[e.output].address, e.amount);

  let mismatches = [];
  for (const [addr, amount] of planned) {
    const voutIndex = tTx.vout.findIndex((_, i) => addrOfVout(i) === addr);
    const actual = voutIndex >= 0 ? state.balanceOf(`${transferTxid}:${voutIndex}`, REF) : -1;
    if (actual !== amount) mismatches.push(`${addr.slice(0, 8)} planned ${amount} got ${actual}`);
  }
  check('every recipient holds exactly what the plan promised it (edict indices are correct)',
    mismatches.length === 0, mismatches.join('; '));

  // ---- 4. coin selection refuses to spend a rune utxo for a plain payment --------------------
  const utxos = [
    { txid: transferTxid, vout: 0, value: DUST_UNITS, runes: { [REF]: 1000 } }, // real carrier
    { txid: 'clean', vout: 0, value: 50 * DUST_UNITS },
  ];
  const plain = selectCoins({ utxos, targetValue: DUST_UNITS, fee: DUST_UNITS });
  check('a plain payment leaves the real rune-carrying utxo alone',
    !plain.inputs.some((u) => u.txid === transferTxid));
  let guarded = true;
  try { assertNoRunesSpent(plain); } catch { guarded = false; }
  check('the plain-payment guard passes on a clean selection', guarded);

  let refused = false;
  try {
    selectCoins({ utxos: [utxos[0]], targetValue: 40 * DUST_UNITS, fee: DUST_UNITS });
  } catch (e) { refused = e.name === 'InsufficientFunds'; }
  check('it fails rather than spending the carrier when clean funds are short', refused);

  console.log('\n' + (failed === 0 ? 'ALL PASSED' : failed + ' FAILED') + '  (' + checks + ' checks)');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nERROR: ' + e.message); process.exit(1); });
