// The wallet's rune surface: what it shows, and what it refuses to show.
// Run: node extension/test-runeui.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const codec = require('../src/runes/codec.js');
import { encodeEdicts, edictScript, parseRef, selectForRuneTransfer, DUST_UNITS } from './lib/runes.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
