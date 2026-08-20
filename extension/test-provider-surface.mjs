// Every provider method the site calls must actually be on window.verge.
//
// This file exists because runesLockPubkey was handled by the background and used by the etch page
// for weeks while never being named in inject.js. A method the background answers and inject.js does
// not name DOES NOT EXIST to a page: the call throws, the page's catch swallows it, and the user is
// told to reconnect a wallet that is working perfectly well.
//
// Run: node extension/test-provider-surface.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const inject = readFileSync(join(ROOT, 'extension/inject.js'), 'utf8');
const background = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');

/** The names inject.js puts on window.verge, read off the `x: () => call('y')` shape. */
const exposed = new Set([...inject.matchAll(/call\('([A-Za-z]+)'/g)].map((m) => m[1]));

/**
 * Every method the pages ask THE PROVIDER for.
 *
 * Narrowed to the provider on purpose. A first version matched any `verge.something()` and swept up
 * `verge.concatBytes` and `verge.legacySighash` from the pages where `verge` is the local crypto
 * library, then reported eight missing methods that were never missing. A test that cries wolf gets
 * switched off, so it reads window.verge and whatever local name was assigned from it, and nothing
 * else.
 */
const pageCalls = new Set();
for (const f of ['web/etch.js', 'web/runes-buy.js', 'web/app.js', 'web/wallet.js', 'web/unlock.js']) {
  let src;
  try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  const names = new Set(['window.verge']);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*window\.verge\b/g)) names.add(m[1]);
  for (const n of names) {
    const esc = n.replace('.', '\\.');
    for (const m of src.matchAll(new RegExp('\\b' + esc + '\\.([a-zA-Z]+)\\s*\\(', 'g'))) pageCalls.add(m[1]);
    for (const m of src.matchAll(new RegExp('\\b' + esc + "\\.request\\(\\{\\s*method:\\s*'([A-Za-z]+)'", 'g'))) pageCalls.add('request:' + m[1]);
  }
}

const IGNORE = new Set(['then', 'catch', 'request', 'isVerginals', 'on', 'off', 'version']);

console.log('what the site asks for, and whether the wallet offers it');
const missing = [...pageCalls].filter((m) => !IGNORE.has(m) && !exposed.has(m) && !m.startsWith('request:'));
ok('every method the site calls is named in inject.js' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), missing.length === 0);

const viaRequest = [...pageCalls].filter((m) => m.startsWith('request:'));
ok('no page uses p.request, which inject.js has never had' + (viaRequest.length ? ' (found: ' + viaRequest.join(', ') + ')' : ''), viaRequest.length === 0);

console.log('\nthe two that were missing');
for (const m of ['runesLockPubkey', 'runesMyLocks']) {
  ok(m + ' is on window.verge', exposed.has(m));
  ok(m + ' is answered by the background', background.includes(`case '${m}'`));
}

console.log('\nselling stays out of reach of a page');
for (const m of ['publishOrder', 'withdrawOrder', 'fillBid', 'pendingBids']) {
  ok(m + ' is NOT on the provider', !exposed.has(m));
}
ok('CONTROL: placeRuneBid IS on the provider, so the check above is not vacuous', exposed.has('placeRuneBid'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
