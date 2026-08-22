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
for (const f of ['web/etch.js', 'web/runes-trade.js', 'web/runes-market.js',
  'web/runes-coin.js', 'web/runes-mint.js', 'web/app.js', 'web/wallet.js', 'web/unlock.js']) {
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

// DOM methods too. The scan is file-scoped rather than scope-aware, so a local named like the
// provider gets its method calls attributed to the provider. Renaming the local is the real fix and
// was the right call the one time this fired, but a built-in should never be reported as a missing
// wallet method, because a check that cries wolf gets switched off.
const IGNORE = new Set(['then', 'catch', 'request', 'isVerginals', 'on', 'off', 'version',
  'append', 'appendChild', 'prepend', 'remove', 'replaceWith', 'querySelector', 'querySelectorAll',
  'addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'closest', 'focus',
  'scrollIntoView', 'toggle', 'add', 'contains', 'insertBefore', 'after', 'before']);

console.log('what the site asks for, and whether the wallet offers it');
const missing = [...pageCalls].filter((m) => !IGNORE.has(m) && !exposed.has(m) && !m.startsWith('request:'));
ok('every method the site calls is named in inject.js' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), missing.length === 0);

const viaRequest = [...pageCalls].filter((m) => m.startsWith('request:'));
ok('no page uses p.request, which inject.js has never had' + (viaRequest.length ? ' (found: ' + viaRequest.join(', ') + ')' : ''), viaRequest.length === 0);

console.log('\nthe two that were missing');
for (const m of ['runesLockPubkey', 'runesMyLocks', 'publishRuneOrder', 'withdrawRuneOrder']) {
  ok(m + ' is on window.verge', exposed.has(m));
  ok(m + ' is answered by the background', background.includes(`case '${m}'`));
}

console.log('\nevery approval prompt can say what it is asking for');
// A type the background asks approval for and approve.js cannot describe renders as a bare method
// name: "verginals.com wants to: runesLockPubkey", with no amount, no destination and no explanation.
// sendRune was in that state, which means a rune transfer was being approved blind.
const approve = readFileSync(join(ROOT, 'extension/ui/approve.js'), 'utf8');
const asked = new Set([...background.matchAll(/requestApproval\(\{\s*type:\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
const described = new Set([...approve.matchAll(/req\.type === '([A-Za-z]+)'/g)].map((m) => m[1]));
const bare = [...asked].filter((t) => !described.has(t));
ok('every approval type has a description' + (bare.length ? ' (bare: ' + bare.join(', ') + ')' : ''), bare.length === 0);
ok('CONTROL: the harness found approval types at all, so an empty list is not a pass', asked.size >= 8);

// The line is not "selling is off the provider". It is "HANDING THE COINS OVER is off the provider",
// and the two are different things that used to sit on the same side of it.
//
// A listing names no outpoint, moves nothing and binds nobody, so a page may ask for one: somebody
// fooled into publishing has published a price. Filling is the signature that gives runes away, and
// it stays in the wallet's own screen for good.
//
// This block was previously written as the first sentence, and it kept passing after the policy
// changed only because the new methods happen to be spelled differently. A check that passes for a
// reason nobody chose is worse than one that fails.
console.log('\nhanding the coins over stays out of reach of a page');
for (const m of ['fillBid', 'pendingBids', 'acceptRuneBid']) {
  ok(m + ' is NOT on the provider', !exposed.has(m));
}
// Split at the real boundary rather than counting characters. A first version looked 400 characters
// past `case 'X'` for the thing it wanted, which happily found it inside the NEXT case, so deleting
// an approval left the check green. A window that spans a boundary is not a check.
const dApp = background.slice(background.indexOf('async function handleRpc('),
  background.indexOf('async function handleUi('));
const inDapp = (m) => new RegExp("case '" + m + "'").test(dApp);

ok('the background does not answer fillBid from a page either', !inDapp('fillBid'));
ok('nor pendingBids', !inDapp('pendingBids'));
ok('CONTROL: placeRuneBid IS on the provider, so the check above is not vacuous', exposed.has('placeRuneBid'));

console.log('\npublishing a price is allowed, and is meant to be');
ok('publishRuneOrder is on the provider', exposed.has('publishRuneOrder'));
ok('withdrawRuneOrder is on the provider', exposed.has('withdrawRuneOrder'));
/** Does THIS case, and not the one after it, ask for an approval of its own type? */
function approves(method) {
  const at = dApp.indexOf("case '" + method + "'");
  if (at < 0) return false;
  const next = dApp.indexOf("case '", at + 6);
  const block = dApp.slice(at, next < 0 ? dApp.length : next);
  return block.includes("requestApproval({ type: '" + method + "'");
}
ok('both go through an approval of their own type, inside their own case',
  approves('publishRuneOrder') && approves('withdrawRuneOrder'));
ok('CONTROL: the same check finds the approval placeRuneBid has always had', approves('placeRuneBid'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
