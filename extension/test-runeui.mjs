// The wallet's rune surface: what it shows, and what it refuses to show.
// Run: node extension/test-runeui.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const codec = require('../src/runes/codec.js');
import { encodeEdicts, edictScript, parseRef, selectForRuneTransfer, DUST_UNITS,
  verifiedBalances, verifiedDefinitions, runeRows, displayTicker } from './lib/runes.js';
const { RuneState, applyTx, runeRefOf } = require('../src/runes/indexer.js');
const checkpoint = require('../src/runes/checkpoint.js');
const { lockFor } = require('../test/fixtures/etchlock.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const hex = (b) => Buffer.from(b).toString('hex');

console.log('writing an edict');

ok('the wallet and the server write the same bytes', (() => {
  for (const edicts of [
    [{ runeRef: '9388102:14', amount: 400000, output: 1 }],
    [{ runeRef: '9388102:14', amount: 1, output: 0 }, { runeRef: '9500000:2', amount: 999, output: 2 }],
    [{ runeRef: '10:0', amount: 0, output: 3 }],
    [{ runeRef: '3:0', amount: 21000000, output: 1 }],
  ]) {
    if (hex(encodeEdicts(edicts)) !== codec.encodeEdicts(edicts).toString('hex')) return false;
  }
  return true;
})());

ok('a reference below the reserved floor is refused', (() => {
  try { encodeEdicts([{ runeRef: '2:0', amount: 1, output: 1 }]); return false; } catch { return true; }
})());

ok('a malformed reference is refused rather than guessed at', (() => {
  for (const bad of ['9388102', '9388102:', ':14', 'abc:1', '09:1', '']) {
    try { encodeEdicts([{ runeRef: bad, amount: 1, output: 1 }]); return false; } catch { /* good */ }
  }
  return true;
})());

ok('a batch too big for the OP_RETURN throws instead of truncating', (() => {
  const many = Array.from({ length: 40 }, (_, i) => ({ runeRef: `${9000000 + i}:${i}`, amount: 1e6, output: 1 }));
  try { encodeEdicts(many); return false; } catch (e) { return /83/.test(e.message); }
})());

ok('the script is a real OP_RETURN push', (() => {
  const s = edictScript(encodeEdicts([{ runeRef: '9388102:14', amount: 1, output: 1 }]));
  return s[0] === 0x6a && s[1] === s.length - 2;
})());

ok('parseRef keeps the pair a pair', (() => {
  const r = parseRef('9388102:14');
  return r && r.height === 9388102 && r.txIndex === 14 && parseRef('9388102') === null;
})());

console.log('\nchoosing coins');

const carrier = (txid, runes, value = DUST_UNITS * 3) => ({ txid, vout: 0, value, runes });

ok('it never spends a coin carrying a different rune', (() => {
  // An unnamed rune on an input goes to the first non-OP_RETURN output by protocol default, so a
  // careless selection hands somebody else's coin away with the one being sent.
  const utxos = [
    carrier('a'.repeat(64), { '9388102:14': 1000 }),
    carrier('b'.repeat(64), { '9500000:2': 5000 }),
    carrier('c'.repeat(64), {}),
  ];
  const sel = selectForRuneTransfer(utxos, '9388102:14', 500, { targetValue: DUST_UNITS, fee: DUST_UNITS });
  if (!sel || !sel.inputs) return false;
  return !sel.inputs.some((u) => u.txid === 'b'.repeat(64));
})());

ok('asking for more than is held throws, and says by how much', (() => {
  // It throws rather than returning an empty selection, which is the right shape: a caller that
  // forgot to check a return value would otherwise build a transaction moving nothing.
  const utxos = [carrier('a'.repeat(64), { '9388102:14': 100 })];
  try {
    selectForRuneTransfer(utxos, '9388102:14', 1000, { targetValue: DUST_UNITS, fee: DUST_UNITS });
    return false;
  } catch (e) {
    return /need 1000/.test(e.message) && /hold 100/.test(e.message);
  }
})());

console.log('\nwhat the balance screen is told, against a real indexer answer');

// The whole point of these: the answer is not hand-written to match what the wallet expects, it is
// BUILT BY THE SERVER'S OWN MODULES, exactly as src/server.js handleRuneBalances builds it. A wallet
// that read a field the server never sends passed every hand-written fixture ever written for it,
// and then showed somebody 11,000 of a coin they held 110.00 of.
const A = codec.ACTIVATION_HEIGHT;
const DUST = 100000;
const anOut = (v = DUST) => ({ value: v, scriptPubKey: Buffer.from('aa', 'hex'), isOpReturn: false });

function chainWith(runes) {
  const s = new RuneState();
  runes.forEach((r, i) => {
    const paid = lockFor(r.ticker);
    applyTx(s, {
      txid: 'e' + i, height: A, txIndex: i + 1, inputs: [], time: paid.time,
      outputs: [anOut(), paid.output],
      etching: {
        ticker: r.ticker, supply: r.supply, premine: 0, divisibility: r.div,
        spacers: r.spacers || 0, lock: paid.lock, terms: { amount: r.perMint },
      },
    });
  });
  s.height = A;
  return s;
}

/** The answer src/server.js sends, built by the same code that builds it in production. */
function answerFor(state, outpoints) {
  const entries = [];
  const refs = new Set();
  for (const op of outpoints) {
    const held = state.balances.get(op);
    if (!held) continue;
    for (const ref of held.keys()) {
      const pr = checkpoint.proveBalance(state, op, ref);
      if (!pr) continue;
      entries.push({ entry: pr.entry, path: pr.path.map((b) => Array.from(b)) });
      refs.add(ref);
    }
  }
  const runes = [];
  for (const ref of refs) {
    const pr = checkpoint.proveRune(state, ref);
    if (pr) runes.push({ entry: pr.entry, path: pr.path.map((b) => Array.from(b)) });
  }
  return { root: Array.from(checkpoint.stateRoot(state)), entries, runes, launched: true };
}

async function rowsFor(state, holdings) {
  for (const [op, held] of Object.entries(holdings)) {
    state.balances.set(op, new Map(Object.entries(held)));
  }
  const outpoints = Object.keys(holdings);
  const answer = answerFor(state, outpoints);
  const root = Uint8Array.from(answer.root);
  const { balances, rejected } = await verifiedBalances(answer, root);
  if (rejected) throw new Error(`${rejected} balance(s) failed to verify`);
  const totals = {};
  for (const held of balances.values()) {
    for (const [ref, amt] of Object.entries(held)) totals[ref] = (totals[ref] || 0) + amt;
  }
  const { defs } = await verifiedDefinitions(answer, root);
  return { rows: runeRows(totals, defs), answer, root, defs };
}

// ALPHA as it actually sits on chain: two decimals, 1000 base units a mint, eleven mints taken.
const alphaChain = chainWith([{ ticker: 'ALPHA', supply: 942042000, div: 2, perMint: 1000 }]);
const ALPHA = runeRefOf(A, 1);

ok('ELEVEN MINTS OF A TWO-DECIMAL COIN READ AS 110, NOT 11,000', await (async () => {
  // The bug this file exists for. 11 x 1000 base units of a divisibility-2 coin is 110.00 tokens,
  // and the wallet reported 11,000 because the definitions never arrived and it fell back to zero
  // decimals. The balance was never wrong; the sentence about it was wrong by a factor of a hundred.
  const holdings = {};
  for (let i = 0; i < 11; i++) holdings[`${'a'.repeat(63)}${i}:0`] = { [ALPHA]: 1000 };
  const { rows } = await rowsFor(alphaChain, holdings);
  if (rows.length !== 1) return false;
  return rows[0].units === 11000 && rows[0].amount === 110 && rows[0].divisibility === 2;
})());

ok('the ticker comes back, so a row is not named after its own reference', await (async () => {
  const { rows } = await rowsFor(alphaChain, { [`${'b'.repeat(64)}:0`]: { [ALPHA]: 1000 } });
  return rows[0].ticker === 'ALPHA' && rows[0].display === 'ALPHA' && rows[0].named === true;
})());

ok('a zero-decimal coin is untouched, which is why the bug hid', await (async () => {
  // SUNEROKTHEDEVGOAT has no decimals, so guessing zero happened to be right and the row looked
  // perfect. A test that only ever checked a divisibility-0 rune would have proved nothing.
  const s = chainWith([{ ticker: 'NODECIMALS', supply: 21000, div: 0, perMint: 5 }]);
  const ref = runeRefOf(A, 1);
  const { rows } = await rowsFor(s, { [`${'c'.repeat(64)}:0`]: { [ref]: 5 } });
  return rows[0].units === 5 && rows[0].amount === 5 && rows[0].divisibility === 0;
})());

ok('several coins at once each keep their own decimals', await (async () => {
  const s = chainWith([
    { ticker: 'TWODEC', supply: 942042000, div: 2, perMint: 1000 },
    { ticker: 'NONE', supply: 21000, div: 0, perMint: 5 },
    { ticker: 'SIXDEC', supply: 21000000000000, div: 6, perMint: 1000000 },
  ]);
  const { rows } = await rowsFor(s, {
    [`${'d'.repeat(64)}:0`]: { [runeRefOf(A, 1)]: 11000, [runeRefOf(A, 2)]: 5 },
    [`${'d'.repeat(64)}:1`]: { [runeRefOf(A, 3)]: 1000000 },
  });
  const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  // Read defensively: a regression that empties the definitions must be REPORTED by this harness,
  // not crash it on the way to the report.
  return by.TWODEC?.amount === 110 && by.NONE?.amount === 5 && by.SIXDEC?.amount === 1;
})());

ok('a definition whose proof does not check out is DROPPED, not shown', await (async () => {
  // The failure that matters most: an indexer answering with a divisibility nobody can prove is an
  // indexer restating a balance by a factor of a hundred, and it must not get to.
  const holdings = { [`${'e'.repeat(64)}:0`]: { [ALPHA]: 11000 } };
  for (const [op, held] of Object.entries(holdings)) alphaChain.balances.set(op, new Map(Object.entries(held)));
  const answer = answerFor(alphaChain, Object.keys(holdings));
  answer.runes[0].entry = { ...answer.runes[0].entry, divisibility: 8 };
  const root = Uint8Array.from(answer.root);
  const { defs, rejected } = await verifiedDefinitions(answer, root);
  if (rejected !== 1 || defs.size !== 0) return false;
  const rows = runeRows({ [ALPHA]: 11000 }, defs);
  // No proven decimals, so no decimal point: base units, said out loud, never scaled by a guess.
  return rows[0].named === false && rows[0].amount === null && rows[0].units === 11000;
})());

ok('a definition for a rune nobody asked about cannot rename one that was', await (async () => {
  const s = chainWith([
    { ticker: 'MINE', supply: 942042000, div: 2, perMint: 1000 },
    { ticker: 'THEIRS', supply: 21000, div: 6, perMint: 5 },
  ]);
  const mine = runeRefOf(A, 1);
  s.balances.set(`${'f'.repeat(64)}:0`, new Map([[mine, 11000]]));
  const answer = answerFor(s, [`${'f'.repeat(64)}:0`]);
  const other = checkpoint.proveRune(s, runeRefOf(A, 2));
  answer.runes.push({ entry: other.entry, path: other.path.map((b) => Array.from(b)) });
  const { defs } = await verifiedDefinitions(answer, Uint8Array.from(answer.root));
  const rows = runeRows({ [mine]: 11000 }, defs);
  return rows[0].ticker === 'MINE' && rows[0].amount === 110;
})());

ok('an unproven balance never becomes a row at all', await (async () => {
  const holdings = { [`${'1'.repeat(64)}:0`]: { [ALPHA]: 11000 } };
  for (const [op, held] of Object.entries(holdings)) alphaChain.balances.set(op, new Map(Object.entries(held)));
  const answer = answerFor(alphaChain, Object.keys(holdings));
  answer.entries[0].entry = { ...answer.entries[0].entry, amount: 999999999 };
  const { balances, rejected } = await verifiedBalances(answer, Uint8Array.from(answer.root));
  return rejected === 1 && balances.size === 0;
})());

ok('spacers are drawn from the proven mask, and the bare ticker stays the identity', await (async () => {
  const s = chainWith([{ ticker: 'DOGGOTOTHEMOON', supply: 1000, div: 0, perMint: 1, spacers: 0b10100 }]);
  const ref = runeRefOf(A, 1);
  const { rows } = await rowsFor(s, { [`${'2'.repeat(64)}:0`]: { [ref]: 1 } });
  return rows[0].ticker === 'DOGGOTOTHEMOON' && rows[0].display.includes('•') && rows[0].ref === ref;
})());

ok('the wallet spaces a name exactly the way the server does', (() => {
  const tickers = require('../src/runes/tickers.js');
  for (const [t, m] of [['ALPHA', 0], ['DOGGOTOTHEMOON', 0b10100], ['AB', 1], ['XVG', 3],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 0x2aaaaaa], ['A', 7]]) {
    if (displayTicker(t, m) !== tickers.displayTicker(t, m)) return false;
  }
  return true;
})());

ok('a mask too big for the name is masked off rather than folded', (() => {
  // JavaScript's bitwise operators are 32-bit, so `1 << 32` is 1 and a big mask would be folded into
  // separators nobody asked for. The arithmetic form is here so a mask read off the chain cannot.
  const tickers = require('../src/runes/tickers.js');
  return displayTicker('ALPHA', 2 ** 40) === tickers.displayTicker('ALPHA', 2 ** 40);
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
