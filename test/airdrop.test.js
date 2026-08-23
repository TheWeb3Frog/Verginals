// The community drop: who qualifies, what they get, and what it costs to send it.
//
// Two things here would be expensive to get wrong and cheap to get wrong quietly.
//
// The first is the REMAINDER OUTPUT. Anything an edict does not name falls to the first eligible
// output, and in an airdrop batch that is every coin not yet handed out. If a recipient ever sits
// at output 0 they collect the whole remaining supply along with their share, and nothing anywhere
// reports an error. So the plan is run through the real indexer below and the balances are checked,
// rather than the output order being eyeballed.
//
// The second is ROUNDING. A billion coins over five thousand wallets does not divide evenly, and a
// split that loses units shorts somebody while a split that gains them cannot be broadcast.
//
// Run: node test/airdrop.test.js
const assert = require('assert');
const codec = require('../src/runes/codec');
const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer');
const { ACTIONS, ActionLedger, sharesOf, allocate } = require('../src/airdrop');
const { plan, batch, CHANGE_OUTPUT, FIRST_RECIPIENT, DUST_UNITS } = require('../src/runes/airdropplan');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const H = codec.ACTIVATION_HEIGHT + 100;
const REF = runeRefOf(H, 1);
const addr = (i) => `VaDdR${String(i).padStart(28, '0')}`;

// --- the ledger ---------------------------------------------------------------------------------

test('an address that did nothing has no shares and is not on the roll', () => {
  const l = new ActionLedger();
  assert.strictEqual(sharesOf(l.at(addr(1))), 0);
  assert.deepStrictEqual(l.roll(), []);
});

test('one action is one share, four actions are four', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'inscribe', 100);
  assert.strictEqual(sharesOf(l.at(addr(1))), 1);
  for (const a of ACTIONS) l.record(addr(2), a.key, 100);
  assert.strictEqual(sharesOf(l.at(addr(2))), 4);
});

test('the same action twice is still one share, and keeps the FIRST height', () => {
  const l = new ActionLedger();
  assert.strictEqual(l.record(addr(1), 'inscribe', 500), true);
  assert.strictEqual(l.record(addr(1), 'inscribe', 900), false);
  assert.strictEqual(l.at(addr(1)).inscribe, 500);
  assert.strictEqual(sharesOf(l.at(addr(1))), 1);
});

test('a snapshot height hides what happened after it', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'inscribe', 100);
  l.record(addr(1), 'etch', 900);
  assert.strictEqual(sharesOf(l.at(addr(1), 500)), 1, 'the etch is after the snapshot');
  assert.strictEqual(sharesOf(l.at(addr(1), 900)), 2, 'and at the snapshot height itself it counts');
  assert.strictEqual(sharesOf(l.at(addr(1), null)), 2, 'no snapshot means everything so far');
});

test('an address whose only action is after the snapshot is off the roll entirely', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'coin', 900);
  assert.deepStrictEqual(l.roll(500), []);
  assert.strictEqual(l.roll(900).length, 1);
});

test('an unknown action is refused rather than silently ignored', () => {
  const l = new ActionLedger();
  assert.throws(() => l.record(addr(1), 'staked', 100), /unknown action/);
});

test('a ledger survives the round trip a reorg snapshot puts it through', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'inscribe', 100);
  l.record(addr(2), 'alpha', 200);
  const back = ActionLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
  assert.deepStrictEqual(back.roll(), l.roll());
});

test('a restored ledger is a copy, so rewinding one does not rewrite the other', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'inscribe', 100);
  const back = ActionLedger.fromJSON(l.toJSON());
  l.record(addr(1), 'etch', 200);
  assert.strictEqual(sharesOf(back.at(addr(1))), 1, 'the copy must not have grown an etch');
});

// --- the split ----------------------------------------------------------------------------------

const SUPPLY = 100000000000; // 1,000,000,000 coins at divisibility 2

test('the parts sum to exactly the supply, with an awkward number of wallets', () => {
  const l = new ActionLedger();
  for (let i = 0; i < 4999; i++) l.record(addr(i), ACTIONS[i % 4].key, 100);
  const parts = allocate(l.roll(), SUPPLY);
  assert.strictEqual(parts.reduce((s, p) => s + p.amount, 0), SUPPLY);
});

test('the parts sum to exactly the supply when shares are lopsided', () => {
  const l = new ActionLedger();
  for (let i = 0; i < 777; i++) for (let k = 0; k <= i % 4; k++) l.record(addr(i), ACTIONS[k].key, 100);
  const parts = allocate(l.roll(), SUPPLY);
  assert.strictEqual(parts.reduce((s, p) => s + p.amount, 0), SUPPLY);
  assert.ok(parts.every((p) => Number.isInteger(p.amount)), 'no fractional units');
});

test('four actions is worth four times one action, to the unit', () => {
  const l = new ActionLedger();
  l.record(addr(1), 'inscribe', 100);
  for (const a of ACTIONS) l.record(addr(2), a.key, 100);
  const parts = allocate(l.roll(), SUPPLY);
  const one = parts.find((p) => p.address === addr(1)).amount;
  const four = parts.find((p) => p.address === addr(2)).amount;
  assert.strictEqual(four, one * 4);
});

test('the same roll always splits the same way', () => {
  const l = new ActionLedger();
  for (let i = 0; i < 500; i++) for (let k = 0; k <= i % 4; k++) l.record(addr(i), ACTIONS[k].key, 100);
  assert.deepStrictEqual(allocate(l.roll(), SUPPLY), allocate(l.roll(), SUPPLY));
});

test('nobody on the roll means nothing is handed out, rather than a division by zero', () => {
  assert.deepStrictEqual(allocate([], SUPPLY), []);
});

// --- batching -----------------------------------------------------------------------------------

const evenRoll = (n) => {
  const l = new ActionLedger();
  for (let i = 0; i < n; i++) l.record(addr(i), 'inscribe', 100);
  return allocate(l.roll(), SUPPLY);
};

test('every batch encodes, and one more recipient in it would not', () => {
  const rows = evenRoll(5000);
  const batches = batch(rows, REF);
  assert.ok(batches.length > 1);
  batches.forEach((b, i) => {
    codec.encodeEdicts(b.map((r, k) => ({ runeRef: REF, amount: r.amount, output: FIRST_RECIPIENT + k })));
    const next = batches[i + 1];
    if (!next) return;
    const overfull = b.concat([next[0]]);
    assert.throws(
      () => codec.encodeEdicts(overfull.map((r, k) => ({ runeRef: REF, amount: r.amount, output: FIRST_RECIPIENT + k }))),
      /over the 83-byte OP_RETURN limit/,
      `batch ${i} had room for another recipient and did not take it`,
    );
  });
});

test('every recipient appears exactly once across the batches, in order', () => {
  const rows = evenRoll(1234);
  const flat = batch(rows, REF).flat();
  assert.strictEqual(flat.length, rows.length);
  assert.deepStrictEqual(flat.map((r) => r.address), rows.map((r) => r.address));
});

test('a plan refuses to be built without somewhere for the remainder to go', () => {
  assert.throws(() => plan({ recipients: evenRoll(10), runeRef: REF }), /change address is required/);
});

test('a zero allocation is refused rather than encoded as "everything left"', () => {
  // amount 0 in an edict means "all of the pooled balance" (spec 4.1). Letting a wallet down for
  // nothing through would hand it the entire undistributed supply.
  assert.throws(
    () => batch([{ address: addr(1), amount: 0 }], REF),
    /not a whole positive amount/,
  );
});

// --- what the chain actually does with the plan ---------------------------------------------------

/** Run one planned transaction through the real rune indexer and read the balances back. */
function settle(state, tx, txid, height) {
  const outputs = tx.outputs.map((o) => ({
    value: o.value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false,
  }));
  outputs.push({ value: 0, scriptPubKey: Buffer.from('6a', 'hex'), isOpReturn: true, opReturnData: tx.opReturn });
  applyTx(state, {
    txid, height, txIndex: 1,
    inputs: state.carrier ? [state.carrier] : [],
    outputs,
  });
  return outputs;
}

test('the remainder lands on the change output, never on a recipient', () => {
  const rows = evenRoll(40);
  const p = plan({ recipients: rows, runeRef: REF, changeAddress: 'VcHaNgE' });
  assert.ok(p.txs.length >= 3, 'needs several batches for a remainder to exist at all');

  // Etch the coin for real, whole supply premined, exactly as ALPHA GO BRRRR was.
  const state = new RuneState();
  state.runes.set(REF, {
    runeRef: REF, ticker: 'T', divisibility: 2, supply: SUPPLY, premine: SUPPLY,
    minted: 0, mintCount: 0, terms: null,
  });
  state.credit('etch:0', REF, SUPPLY);

  let carrier = { txid: 'etch', vout: 0 };
  state.carrier = carrier;
  const paid = new Map();
  p.txs.forEach((tx, i) => {
    const txid = `drop${i}`;
    state.carrier = carrier;
    settle(state, tx, txid, H + 10 + i);
    // Read every output this transaction created.
    tx.outputs.forEach((o, vout) => {
      const held = state.balances.get(`${txid}:${vout}`);
      const amt = held ? (held.get(REF) || 0) : 0;
      if (vout === CHANGE_OUTPUT) return;
      paid.set(o.address, (paid.get(o.address) || 0) + amt);
    });
    carrier = { txid, vout: CHANGE_OUTPUT };
  });

  for (const r of rows) {
    assert.strictEqual(paid.get(r.address), r.amount, `${r.address} was paid the wrong amount`);
  }
  // And the change output of the last transaction holds nothing: it all went out.
  const last = `drop${p.txs.length - 1}:${CHANGE_OUTPUT}`;
  const leftover = state.balances.get(last);
  assert.strictEqual(leftover ? (leftover.get(REF) || 0) : 0, 0, 'coins were left stranded on the change');
});

test('MUTATION: put a recipient at output 0 and the test above must fail', () => {
  // The guard is only worth having if it fires, so the mistake is made here on purpose: recipients
  // start at output 0, the change is pushed to the end, and the first recipient should collect the
  // entire undistributed remainder.
  const rows = evenRoll(40);
  const state = new RuneState();
  state.runes.set(REF, {
    runeRef: REF, ticker: 'T', divisibility: 2, supply: SUPPLY, premine: SUPPLY,
    minted: 0, mintCount: 0, terms: null,
  });
  state.credit('etch:0', REF, SUPPLY);

  const first = batch(rows, REF)[0];
  const edicts = first.map((r, i) => ({ runeRef: REF, amount: r.amount, output: i })); // WRONG on purpose
  const outputs = first.map(() => ({ value: DUST_UNITS, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false }));
  outputs.push({ value: DUST_UNITS, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false }); // change last
  outputs.push({ value: 0, scriptPubKey: Buffer.from('6a', 'hex'), isOpReturn: true, opReturnData: codec.encodeEdicts(edicts) });
  applyTx(state, { txid: 'bad', height: H + 10, txIndex: 1, inputs: [{ txid: 'etch', vout: 0 }], outputs });

  const got = state.balances.get('bad:0').get(REF);
  assert.ok(got > first[0].amount, 'the mutation did not overpay, so this control proves nothing');
  assert.strictEqual(got, first[0].amount + (SUPPLY - first.reduce((s, r) => s + r.amount, 0)),
    'output 0 should have collected its share plus the whole remainder');
});

// --- the cost -------------------------------------------------------------------------------------

test('the quoted cost is the fees plus one dust output per recipient, and nothing else', () => {
  const rows = evenRoll(5000);
  const p = plan({ recipients: rows, runeRef: REF, changeAddress: 'VcHaNgE' });
  assert.strictEqual(p.dustUnits, rows.length * DUST_UNITS);
  assert.strictEqual(p.totalUnits, p.feeUnits + p.dustUnits);
  assert.strictEqual(p.distributed, SUPPLY, 'the whole supply goes out');
});

console.log(`\n${passed} checks passed`);
