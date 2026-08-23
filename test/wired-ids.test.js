// Every id one script reaches for must exist where another script can find it.
//
// This exists because a header was replaced and took #wallet-connect with it. Nothing threw:
// wallet.js looks the button up with `$('#wallet-connect')` and guards the result, so it simply
// wired nothing. What went with it was the whole connect flow, the "Pay with Verginals Wallet"
// buttons, and the address autofill, and the mint form quietly went back to asking people to paste
// a Verge address by hand. The site looked fine and had lost a feature.
//
// A guarded lookup is right at runtime and useless as a check, which is exactly why this file has
// to do the checking instead.
//
// Run: node test/wired-ids.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const html = read('index.html');
const wallet = read('wallet.js');
const app = read('app.js');
const nav = read('vgnav.js');

// One script now runs on several pages. wallet.js is loaded by the home page and by the airdrop
// checker, and it fills in whichever address field it finds, so an id that exists on one of them
// and not the other is not a fault -- that is the point of a guarded lookup.
//
// What is still a fault, and what this file was written for, is an id that NO page it runs on
// provides. That was the connect button: it lived in a header, the header went, and nothing
// anywhere offered it again. So the question is asked across every page a script is loaded on,
// which is narrower than "somewhere in web/" and wider than "index.html".
const PAGES = fs.readdirSync(WEB).filter((f) => f.endsWith('.html'));

/** The pages whose markup loads `script`, by <script src>. Cache keys are allowed on the end. */
function pagesLoading(script) {
  const re = new RegExp(`src="/${script.replace(/\./g, '\\.')}(\\?[^"]*)?"`);
  return PAGES.filter((f) => re.test(read(f)));
}

/** Ids a script asks the document for, by `$('#x')` or `getElementById('x')`. */
function idsAskedFor(src) {
  const out = new Set();
  for (const m of src.matchAll(/\$\('#([a-zA-Z][\w-]*)'\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/getElementById\('([a-zA-Z][\w-]*)'\)/g)) out.add(m[1]);
  return out;
}

/** Ids that exist somewhere a page can get them: in the markup, or built by the bar. */
function idsProvided(pages = ['index.html']) {
  const out = new Set();
  for (const page of pages) {
    for (const m of read(page).matchAll(/id="([a-zA-Z][\w-]*)"/g)) out.add(m[1]);
  }
  for (const m of nav.matchAll(/\.id = '([a-zA-Z][\w-]*)'/g)) out.add(m[1]);
  // Ids the scripts create themselves as they render.
  for (const src of [app, wallet]) {
    for (const m of src.matchAll(/id="([a-zA-Z][\w-]*)"/g)) out.add(m[1]);
    for (const m of src.matchAll(/\.id = '([a-zA-Z][\w-]*)'/g)) out.add(m[1]);
  }
  return out;
}

const provided = idsProvided();

test('the harness found both sides, so an empty check is not a pass', () => {
  assert.ok(provided.size > 60, `only ${provided.size} ids found in the document`);
  assert.ok(idsAskedFor(wallet).size > 8, 'wallet.js asks for more ids than that');
});

test('THE CONNECT BUTTON EXISTS, wherever the chrome happens to put it', () => {
  // The exact regression: it lived in a header, the header was replaced, and it went with it.
  assert.ok(provided.has('wallet-connect'),
    '#wallet-connect must be provided by the markup or by the site bar');
  assert.match(nav, /id = 'wallet-connect'/, 'and the bar is where it lives now');
});

test('and the bar tells the scripts once it has been mounted', () => {
  // The bar arrives from a deferred module, after the classic scripts have wired themselves, so
  // wiring it once at load finds nothing. Without this event the button exists and does nothing.
  assert.match(nav, /dispatchEvent\(new CustomEvent\('vg:chrome'\)\)/);
  assert.match(wallet, /addEventListener\('vg:chrome'/);
});

/** Every id `script` reaches for, checked against every page that loads it. */
function unprovided(script, src) {
  const pages = pagesLoading(script);
  assert.ok(pages.length > 0, `no page loads ${script}, so this check would prove nothing`);
  const have = idsProvided(pages);
  return [...idsAskedFor(src)].filter((id) => !have.has(id));
}

test('every id wallet.js reaches for exists on a page that loads it', () => {
  const missing = unprovided('wallet.js', wallet);
  assert.deepStrictEqual(missing, [], 'wallet.js asks for ids no page provides:\n  ' + missing.join('\n  '));
});

test('every id app.js reaches for exists on a page that loads it', () => {
  const missing = unprovided('app.js', app);
  assert.deepStrictEqual(missing, [], 'app.js asks for ids no page provides:\n  ' + missing.join('\n  '));
});

test('every id the airdrop checker reaches for is on the airdrop page', () => {
  const missing = unprovided('airdrop.js', read('airdrop.js'));
  assert.deepStrictEqual(missing, [], 'airdrop.js asks for ids the page does not have:\n  ' + missing.join('\n  '));
});

test('CONTROL: an id no page provides is reported', () => {
  const missing = unprovided('wallet.js', wallet + "\n$('#not-a-real-control');");
  assert.deepStrictEqual(missing, ['not-a-real-control'],
    'the check passed a script asking for something that does not exist');
});

test('the mint form can be filled without pasting anything', () => {
  // The feature the regression cost, asserted as a feature rather than as an id.
  assert.ok(provided.has('mint-connect'), 'the mint form needs its own connect button');
  assert.match(wallet, /\$\('#mint-connect'\)/, 'and wallet.js has to wire it');
  assert.match(wallet, /\$\('#mint-address'\); if \(m && !m\.value\.trim\(\)\) m\.value = address;/,
    'connecting must still fill the address in');
});

console.log(`\n${passed} wired-id tests passed`);
