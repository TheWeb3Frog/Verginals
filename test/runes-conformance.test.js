// Conformance: two independent implementations must agree, on every history.
//
// This is what gives checkpoints their meaning. A published root only proves something if
// implementations that were built differently arrive at the same one, so this drives
// src/runes/indexer.js (mutable maps) and src/runes/verify.js (an append-only delta journal) over
// randomised transaction histories and compares their checkpoint roots.
//
// It is also the artifact a third-party implementer needs: point a new implementation at this file,
// and conformance stops being a claim and becomes a test result.
//
// Run: node test/runes-conformance.test.js
const assert = require('assert');
const crypto = require('crypto');
const indexerImpl = require('../src/runes/indexer');
const verifyImpl = require('../src/runes/verify');
const { buildTree, allEntries } = require('../src/runes/checkpoint');
const codec = require('../src/runes/codec');
const { lockFor } = require('./fixtures/etchlock');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const DUST = 100000;
const rootOf = (entries) => buildTree([...entries]).root.toString('hex');

/**
 * Both implementations, over the same history, must commit to the same root.
 *
 * The root is taken over allEntries, so it covers the rune REGISTRY as well as the balances. Taking
 * it over balances alone was a real blind spot: two implementations could disagree about a ticker, a
 * divisibility, a supply or a separator mask and still publish identical roots, and the disagreement
 * would only surface later as different balances, long after the checkpoint said they agreed.
 */
const fullRoot = (state) => rootOf(allEntries(state));

function agree(txs) {
  const a = fullRoot(indexerImpl.index(txs));
  const b = fullRoot(verifyImpl.index(txs));
  return { same: a === b, a, b };
}

// --- a small deterministic generator ------------------------------------------------------------
// Seeded so a failure is reproducible: the seed is printed with any mismatch.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const out = (value = DUST, address = null) => ({ value, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false, address });

// One allowlisted key, entitled to a small number of units, so the histories below exercise the
// entitlement ledger: the same proof presented over and over must stop paying out in BOTH
// implementations at the same point. Built here from the format the spec pins rather than imported
// from either implementation, so it is a third opinion about what the leaf looks like.
const GATE_KEY = Buffer.from('76a914' + '5c'.repeat(20) + '88ac', 'hex');
const GATE_MAX = 3000;
const GATE_ROOT = (() => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(GATE_KEY.length, 0);
  return crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), len, GATE_KEY, Buffer.from(String(GATE_MAX))])).digest();
})();
const GATE_PROOF = { scriptPubKey: GATE_KEY, maxAmount: GATE_MAX, path: [] };
const opret = (data) => ({ value: 0, isOpReturn: true, opReturnData: data });

/**
 * An etching that pays for its ticker (§7.2), so both implementations register it. The lock output
 * goes last, leaving the indices the edicts in these histories point at exactly where they were.
 */
function paidEtch(tx) {
  const paid = lockFor(String(tx.etching.ticker || '').toUpperCase());
  return Object.assign({}, tx, {
    time: paid.time,
    outputs: [...tx.outputs, paid.output],
    etching: Object.assign({ lock: paid.lock }, tx.etching),
  });
}

/**
 * An etching whose price lock is wrong in one specific way. None of these should take the ticker,
 * and much more importantly, both implementations have to refuse them for the same reason.
 *
 *   value  a lock output whose value is not a readable number. This is the one that mattered: the
 *          sum went NaN, `NaN < owed` is false, and one implementation read that as PAID.
 *   part   a lock output whose value is fractional, and just over the price. Summing without
 *          checking accepts it; checking each value first does not. The `value` case alone does not
 *          catch that, because NaN compares false whether or not the check is there.
 *   short  a lock that expires long before the protocol allows.
 *   none   no lock field at all.
 */
function brokenLock(txid, height, txIndex, etching, how) {
  const paid = lockFor(String(etching.ticker || '').toUpperCase());
  const base = { txid, height, txIndex, inputs: [], time: paid.time, outputs: [out(), out()] };
  if (how === 'none') return Object.assign(base, { etching });
  if (how === 'short') {
    return Object.assign(base, {
      outputs: [out(), out(), paid.output],
      etching: Object.assign({ lock: { t: paid.time + 60, k: paid.lock.k } }, etching),
    });
  }
  const value = how === 'part' ? paid.output.value + 0.5 : undefined;
  return Object.assign(base, {
    outputs: [out(), out(), Object.assign({}, paid.output, { value })],
    etching: Object.assign({ lock: paid.lock }, etching),
  });
}

/** A random but structurally valid history: etchings, mints, transfers, plain sends and junk. */
function randomHistory(seed, length = 40) {
  const rnd = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const txs = [];
  const refs = [];
  const spendable = []; // outpoints that may carry a balance

  for (let n = 0; n < length; n++) {
    const height = 100 + n;
    const txid = 'tx' + n;
    const kind = rnd();

    if (kind < 0.15 || refs.length === 0) {
      // etch. The position in the block VARIES, and sometimes runs past 1000: a reference is the
      // pair (height, txIndex), and a history that only ever etched at index 1 could never have
      // caught the packing that made block N transaction 1000 collide with block N+1 transaction 0.
      const txIndex = pick([0, 1, 2, 7, 999, 1000, 1001, 40000]);
      const ticker = 'T' + n;
      const supply = 1000 + Math.floor(rnd() * 100000);
      const premine = Math.floor(rnd() * supply);
      const etching = { ticker, name: ticker, divisibility: Math.floor(rnd() * 7), supply, premine };
      // Separators are display only, so both implementations must carry them without either one
      // letting them touch the identity or the balances.
      if (rnd() < 0.4) etching.spacers = Math.floor(rnd() * 256);
      if (rnd() < 0.5 && premine < supply) {
        etching.terms = { amount: Math.max(1, Math.floor((supply - premine) / 10)) };
        if (rnd() < 0.5) etching.terms.cap = 1 + Math.floor(rnd() * 4);
        if (rnd() < 0.3) etching.terms.openHeight = height + Math.floor(rnd() * 5);
        if (rnd() < 0.3) etching.terms.closeHeight = height + Math.floor(rnd() * 10);
        // Half the open mints charge for a mint, so the histories exercise both branches of the
        // fee rule and the mints below have to be funded or refused.
        if (rnd() < 0.5) etching.terms.price = 20 * 1e6;
        // Terms that are not whole numbers must invalidate the etching in BOTH implementations. A
        // fractional amount used to mint and leave a balance no edict could encode.
        if (rnd() < 0.15) etching.terms.amount = pick([0.1, '1000', 0, -5, NaN]);
      }
      // Sometimes the price is not properly locked, so the ticker is not taken. Both must agree on
      // that too, and the malformed value is the case where they used to differ: one summed to NaN
      // and read it as paid, the other refused.
      const flaw = rnd();
      // Some etchings gate their mint on an allowlist, so the entitlement ledger is exercised too.
      if (etching.terms && rnd() < 0.3) etching.allowlistRoot = GATE_ROOT;
      const etch = flaw < 0.1 ? brokenLock(txid, height, txIndex, etching, pick(['value', 'part', 'short', 'none']))
        : paidEtch({ txid, height, txIndex, inputs: [], outputs: [out(), out()], etching });
      txs.push(etch);
      refs.push(indexerImpl.runeRefOf(height, txIndex));
      spendable.push(txid + ':0', txid + ':1');
      continue;
    }

    const ref = pick(refs);
    const spend = spendable.length ? [pick(spendable)] : [];
    const inputs = spend.map((s) => ({ txid: s.split(':')[0], vout: Number(s.split(':')[1]) }));

    if (kind < 0.4) {
      // mint, paying a fee drawn from either side of the 20 XVG price: underpaid, exactly paid,
      // overpaid, and sometimes unknown, which must be refused rather than waved through
      const fees = [0, 19999999, 20 * 1e6, 45 * 1e6, null];
      const mint = { txid, height, txIndex: 0, inputs, fee: pick(fees),
        outputs: [out(), opret(codec.encodeMint(ref))] };
      // Most mints carry the allowlist proof whether or not the rune wants one, so a gated rune is
      // hammered with the same entitlement repeatedly and an ungated one has to ignore it.
      if (rnd() < 0.8) {
        mint.allowlistProof = rnd() < 0.15
          ? { ...GATE_PROOF, path: pick([['junk'], [Buffer.alloc(31)], 'nope']) } // hostile: must not throw
          : GATE_PROOF;
        mint.inputs = [...inputs, { txid: 'gate' + n, vout: 0, scriptPubKey: GATE_KEY }];
      }
      txs.push(mint);
    } else if (kind < 0.7) {
      // transfer, sometimes to an output that does not exist or is dust
      const amount = rnd() < 0.3 ? 0 : Math.floor(rnd() * 5000);
      const target = Math.floor(rnd() * 3);
      let edicts;
      try { edicts = codec.encodeEdicts([{ runeRef: ref, amount, output: target }]); } catch { continue; }
      txs.push({ txid, height, txIndex: 0, inputs, outputs: [out(), out(rnd() < 0.2 ? 1 : DUST), opret(edicts)] });
    } else if (kind < 0.85) {
      // plain send: the default assignment has to move the balance
      txs.push({ txid, height, txIndex: 0, inputs, outputs: [out()] });
    } else {
      // junk in the OP_RETURN, or nowhere to put the balance
      const junk = rnd() < 0.5 ? Buffer.from('not a message') : Buffer.from([0x56, 0x41, 0x00, 0x80]);
      txs.push({ txid, height, txIndex: 0, inputs, outputs: rnd() < 0.5 ? [opret(junk)] : [out(), opret(junk)] });
    }
    spendable.push(txid + ':0', txid + ':1');
  }
  return txs;
}

// --- the tests ----------------------------------------------------------------------------------

test('both implementations agree on an empty history', () => {
  assert.ok(agree([]).same);
});

test('both agree on a simple etch, mint and transfer', () => {
  const REF = indexerImpl.runeRefOf(100, 1);
  const txs = [
    paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
      etching: { ticker: 'CONF', supply: 100000, premine: 40000, divisibility: 2, terms: { amount: 1000 } } }),
    { txid: 'm', height: 101, txIndex: 0, inputs: [], outputs: [out(), opret(codec.encodeMint(REF))] },
    { txid: 't', height: 102, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 15000, output: 1 }]))] },
  ];
  const r = agree(txs);
  assert.ok(r.same, `${r.a} vs ${r.b}`);
});

test('both agree across 200 randomised histories', () => {
  const failures = [];
  for (let seed = 1; seed <= 200; seed++) {
    const r = agree(randomHistory(seed));
    if (!r.same) failures.push(`seed ${seed}: ${r.a.slice(0, 12)} vs ${r.b.slice(0, 12)}`);
  }
  assert.strictEqual(failures.length, 0, 'divergence:\n  ' + failures.slice(0, 5).join('\n  '));
});

test('both agree on long histories where balances are repeatedly split and merged', () => {
  const failures = [];
  for (let seed = 500; seed <= 520; seed++) {
    const r = agree(randomHistory(seed, 150));
    if (!r.same) failures.push('seed ' + seed);
  }
  assert.strictEqual(failures.length, 0, failures.join(', '));
});

test('both agree on the awkward cases: burns, dust outputs and malformed messages', () => {
  const REF = indexerImpl.runeRefOf(100, 1);
  const etch = paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'EDGE', supply: 50000, premine: 50000 } });
  const cases = [
    // burned: no eligible output at all
    [etch, { txid: 'b', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }], outputs: [opret(Buffer.from('x'))] }],
    // every output below dust
    [etch, { txid: 'd', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }], outputs: [out(1), out(2)] }],
    // malformed protocol message
    [etch, { txid: 'j', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), opret(Buffer.from([0x56, 0x41, 0x00, 0x80]))] }],
    // edict naming an output that does not exist
    [etch, { txid: 'o', height: 101, txIndex: 0, inputs: [{ txid: 'e', vout: 0 }],
      outputs: [out(), opret(codec.encodeEdicts([{ runeRef: REF, amount: 10, output: 9 }]))] }],
  ];
  for (const [i, txs] of cases.entries()) {
    const r = agree(txs);
    assert.ok(r.same, `case ${i}: ${r.a} vs ${r.b}`);
  }
});

test('both agree that a mint past its cap or window changes nothing', () => {
  const REF = indexerImpl.runeRefOf(100, 1);
  const txs = [
    paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
      etching: { ticker: 'CAPD', supply: 100000, premine: 0, terms: { amount: 1000, cap: 2, openHeight: 105, closeHeight: 110 } } }),
  ];
  for (const h of [101, 106, 107, 108, 115]) {
    txs.push({ txid: 'm' + h, height: h, txIndex: 0, inputs: [], outputs: [out(), opret(codec.encodeMint(REF))] });
  }
  const r = agree(txs);
  assert.ok(r.same, `${r.a} vs ${r.b}`);
  // and the shared answer is the correct one: only the two inside the window and under the cap
  assert.strictEqual(indexerImpl.index(txs).runes.get(REF).minted, 2000);
});

test('both ignore an undefined etching field, and ignore it the same way', () => {
  // §6. A field neither implementation knows must not change the state either of them arrives at,
  // otherwise a future addition would split the index the day someone starts using it.
  const REF = indexerImpl.runeRefOf(100, 1);
  const edicts = codec.encodeEdicts([{ runeRef: REF, amount: 10000, output: 1 }]);
  const move = { txid: 'm', height: 101, txIndex: 0,
    inputs: [{ txid: 'e', vout: 0 }], outputs: [out(), out(), opret(edicts)] };
  const plain = [paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'PLAIN', supply: 50000, premine: 50000 } }), move];
  const decorated = [paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'PLAIN', supply: 50000, premine: 50000, owner: 'DSOMEONE', royalty: { bps: 500 } } }), move];
  assert.ok(agree(plain).same);
  assert.ok(agree(decorated).same);
  // and the extra field changed nothing at all, in either implementation
  assert.strictEqual(rootOf(indexerImpl.index(plain).entries()), rootOf(indexerImpl.index(decorated).entries()));
});

test('a deliberately broken implementation is caught (the harness can fail)', () => {
  // guards against a harness that would pass no matter what
  const REF = indexerImpl.runeRefOf(100, 1);
  const txs = [paidEtch({ txid: 'e', height: 100, txIndex: 1, inputs: [], outputs: [out()],
    etching: { ticker: 'SANITY', supply: 1000, premine: 1000 } })];
  const good = rootOf(indexerImpl.index(txs).entries());
  const tampered = verifyImpl.index(txs);
  tampered.record('tx:0', REF, 1); // one extra unit out of nowhere
  assert.notStrictEqual(good, rootOf(tampered.entries()));
});

console.log('\nrunes conformance: ' + passed + ' passed');
