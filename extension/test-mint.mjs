// The wallet and the node must frame a mint identically.
//
// A mint the wallet wrote one byte differently is ignored by every indexer while the fee, which IS
// the price, has already gone to a miner. The coins leave and nothing arrives, with no error
// anywhere. That is the only failure mode this file exists to prevent.
//
// Run: node extension/test-mint.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const codec = require('../src/runes/codec.js');
import { encodeMint, mintScript } from './lib/runes.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };
const hex = (b) => Buffer.from(b).toString('hex');

console.log('framing a mint');
ok('the wallet and the node write the same bytes', (() => {
  for (const [ref, proof] of [
    ['9420420:1', null],
    ['9420420:1', 0],        // input 0 is a legal proof index and must not be dropped as falsy
    ['9500000:14', 3],
    ['9420421:0', null],
    ['3:0', null],
  ]) {
    if (hex(encodeMint(ref, proof)) !== codec.encodeMint(ref, proof).toString('hex')) {
      console.log('    disagreed on', ref, proof);
      return false;
    }
  }
  return true;
})());

ok('an open mint carries no proof index at all, rather than a zero', (() => {
  const open = encodeMint('9420420:1', null);
  const zero = encodeMint('9420420:1', 0);
  return open.length === zero.length - 1;
})());

ok('CONTROL: a wrong reference produces different bytes, so the comparison can fail',
  hex(encodeMint('9420420:1', null)) !== hex(encodeMint('9420420:2', null)));

ok('the script is OP_RETURN then one push of exactly the payload', (() => {
  const p = encodeMint('9420420:1', null);
  const s = mintScript('9420420:1', null);
  return s[0] === 0x6a && s[1] === p.length && s.length === p.length + 2;
})());

ok('a malformed reference is refused', (() => {
  try { encodeMint('not-a-ref'); return false; } catch { return true; }
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
