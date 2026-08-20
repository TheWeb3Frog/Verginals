// Every endpoint the wallet calls must exist on the server.
//
// This exists because mintRune posted to /api/broadcast, which has never been a route: the server
// serves /api/wallet/broadcast, and it wants rawtx rather than hex. A user with the right wallet, the
// right coin and the right balance got a 404 at the last step, after four rounds of fixing other
// things. The whole class is invisible to unit tests, because nothing in a test suite ever asks the
// server whether a path is real.
//
// Run: node extension/test-endpoints.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

const server = readFileSync(join(ROOT, 'src/server.js'), 'utf8');

/** Paths the server answers, read off its own routing table. */
const served = new Set([...server.matchAll(/p === '(\/[^']+)'/g)].map((m) => m[1]));
// Some are matched by pattern rather than by equality.
const patterns = [...server.matchAll(/\/\^\\\/[^/]+\\\.\([^)]+\)\$\//g)].length;

/** Paths the wallet asks for. */
const called = new Map();
for (const f of ['extension/lib/wallet.js', 'extension/lib/swap.js', 'extension/lib/runebid.js', 'extension/background.js']) {
  let src;
  try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/_(?:post|get)\('(\/[^'?]+)/g)) called.set(m[1], f);
  for (const m of src.matchAll(/fetch\(\s*(?:this\.apiBase \+ )?'(\/api\/[^'?]+)/g)) called.set(m[1], f);
}

console.log(`the wallet asks for ${called.size} paths, the server answers ${served.size} by name`);
ok('the routing table was actually found, so an empty comparison cannot pass', served.size > 20);
ok('the wallet was actually read', called.size > 5);

const missing = [...called].filter(([p]) => !served.has(p));
ok('every path the wallet calls is a route'
  + (missing.length ? ' (missing: ' + missing.map(([p, f]) => `${p} from ${f}`).join(', ') + ')' : ''),
  missing.length === 0);

console.log('\nthe one that got away');
ok('/api/broadcast is NOT a route, and nothing asks for it', !served.has('/api/broadcast') && !called.has('/api/broadcast'));
ok('/api/wallet/broadcast is the route, and the wallet uses it', served.has('/api/wallet/broadcast') && called.has('/api/wallet/broadcast'));

// It takes rawtx, not hex. A correct path with the wrong field name fails just as completely.
const wallet = readFileSync(join(ROOT, 'extension/lib/wallet.js'), 'utf8');
ok('and it is called with rawtx, which is the field the route reads',
  /wallet\/broadcast',\s*\{\s*rawtx:/.test(wallet) && !/wallet\/broadcast',\s*\{\s*hex:/.test(wallet));

ok('CONTROL: a planted call to a route that does not exist is caught', (() => {
  const fake = new Map([['/api/definitely-not-a-route', 'test']]);
  return [...fake].filter(([p]) => !served.has(p)).length === 1;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
