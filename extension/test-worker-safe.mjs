// Nothing the MV3 service worker loads may use a dynamic import.
//
// This file exists because three `await import('./runelock.js')` calls sat in wallet.js and failed at
// the only moment they were ever reached: the etch page asking for a lock key. Chrome refuses them
// outright in a service worker, so the error surfaced as "import() is disallowed on
// ServiceWorkerGlobalScope" to a user who had done nothing wrong.
//
// The whole class is invisible to unit tests, because Node happily runs a dynamic import. It can only
// be caught by reading the source, which is what this does.
//
// Run: node extension/test-worker-safe.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name); } };

/** Source with comments and strings removed, so a mention of the pattern is not a use of it. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // line comments, leaving http:// alone
    .replace(/`(?:\\.|[^`\\])*`/g, '``')   // template literals
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Everything background.js can reach, followed through static imports. */
function reachable(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(join(HERE, f), 'utf8'); } catch { continue; }
    for (const m of code(src).matchAll(/from\s+''/g)) { /* strings blanked, use the raw source */ }
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
      const rel = m[1];
      if (!rel.startsWith('.')) continue;
      stack.push(join(dirname(f), rel));
    }
  }
  return [...seen];
}

const files = reachable('background.js');
console.log(`following static imports from background.js: ${files.length} files`);
ok('wallet.js is in there, so the walk is finding things', files.some((f) => f.endsWith('wallet.js')));
ok('runelock.js is in there, statically', files.some((f) => f.endsWith('runelock.js')));

const offenders = [];
for (const f of files) {
  let src;
  try { src = readFileSync(join(HERE, f), 'utf8'); } catch { continue; }
  const bare = code(src);
  if (/\bimport\s*\(/.test(bare)) offenders.push(f);
}
ok('no dynamic import anywhere the service worker can reach'
  + (offenders.length ? ' (found in: ' + offenders.join(', ') + ')' : ''), offenders.length === 0);

// CONTROL: the detector must actually be able to see one, or the check above proves nothing.
const planted = code("async function f() { const m = await import('./x.js'); return m; }");
ok('CONTROL: the detector finds a planted dynamic import', /\bimport\s*\(/.test(planted));
// and it must NOT be fooled by the pattern inside a comment or a string, which wallet.js now has.
const commented = code("// forbids `await import(...)` outright\nconst s = \"await import('x')\";\n");
ok('CONTROL: a mention in a comment or a string is not a use', !/\bimport\s*\(/.test(commented));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
