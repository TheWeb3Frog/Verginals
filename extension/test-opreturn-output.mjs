// A transaction the wallet builds must be able to carry an OP_RETURN.
//
// buildAndSignP2PKH only ever read o.address. Two callers pass a ready-made script instead, because
// an OP_RETURN has no address by definition: sendRune and mintRune. Both died inside decodeAddress
// as "Cannot read properties of undefined (reading 'length')", a message naming neither the output
// nor the caller, and sendRune had been broken that way since the day it shipped. Nobody could tell,
// because no rune existed to send.
//
// Run: node extension/test-opreturn-output.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseTx } = require('../src/runes/release.js');
import * as V from './lib/verge.js';
import { mintScript, edictScript, encodeEdicts } from './lib/runes.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const priv = V.generatePrivateKey();
const addr = await V.addressFromPrivate(priv);
const H = (c) => c.repeat(64);
const build = (outputs) => V.buildAndSignP2PKH({
  inputs: [{ txid: H('a'), vout: 0, value: 50_000_000, privateKey: priv }],
  outputs, time: 1_787_000_000,
});

console.log('an output carrying a script instead of an address');

const mint = await build([
  { address: addr, value: 100000 },
  { script: mintScript('9420444:2'), value: 0 },
  { address: addr, value: 40_000_000 },
]);
ok('a mint transaction builds at all', mint.hex.length > 0);

const wire = parseTx(mint.hex);
ok('the OP_RETURN reached the wire at the index it was given',
  wire.vout[1].script[0] === 0x6a && wire.vout[1].value === 0n);
ok('and it carries the mint bytes unchanged',
  Buffer.from(wire.vout[1].script).toString('hex') === Buffer.from(mintScript('9420444:2')).toString('hex'));
ok('the address outputs still work beside it', wire.vout.length === 3 && wire.vout[0].value === 100000n);

const send = await build([
  { script: edictScript(encodeEdicts([{ runeRef: '9420444:2', amount: 500, output: 1 }])), value: 0 },
  { address: addr, value: 100000 },
  { address: addr, value: 40_000_000 },
]);
ok('sendRune\'s shape builds too, with the OP_RETURN first', parseTx(send.hex).vout[0].script[0] === 0x6a);

console.log('\nand it still refuses what it cannot build');
ok('an output with neither an address nor a script is named, not guessed', await (async () => {
  try { await build([{ value: 100000 }]); return false; }
  catch (e) { return /needs either an address or a script/.test(e.message); }
})());

ok('CONTROL: the old behaviour is what the message described', await (async () => {
  // Reading o.address on an OP_RETURN output gives undefined, and decodeAddress dies on .length.
  try { await V.outputScript(undefined); return false; }
  catch (e) { return /length|undefined/.test(e.message); }
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
