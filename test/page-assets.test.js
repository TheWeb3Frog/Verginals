// Every stylesheet and script a served page asks for must be one the server actually serves.
//
// This exists because a market page shipped with two new scripts and two new stylesheets, and the
// server answered none of them. Assets are routed by explicit regex, one line per file, so a new
// page is one forgotten edit away from being a blank screen behind a working URL: the HTML came
// back 200, every asset came back 404, and nothing in the tree said a word.
//
// Same shape as the wallet posting to a route that never existed, one layer up, and the same cure:
// read what one side asks for, read what the other side answers, compare.
//
// The routing table is not parsed for meaning. The regex literals are pulled out of server.js and
// RUN, because a first version tried to expand them by hand, could not read an optional group, and
// reported the site's most-linked stylesheet as missing. A test that cries wolf gets switched off.
//
// Run: node test/page-assets.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

// What the server answers, in its own three shapes: an exact compare, a regex test, a prefix.
const exact = new Set([...server.matchAll(/p === '(\/[^']+)'/g)].map((m) => m[1]));
const prefixes = [...server.matchAll(/p\.startsWith\('(\/[^']+)'\)/g)].map((m) => m[1]);
const patterns = [];
// The literal comes BEFORE `.test(p)`, not after it. Written the other way round first, this
// matched nothing at all and the control below is the only reason that was noticed.
for (const m of server.matchAll(/(\/\^.+?\/)\.test\(p\)/g)) {
  try { patterns.push(eval(m[1])); } catch { /* not a literal we can rebuild; the others cover it */ }
}
const answers = (p) => exact.has(p) || prefixes.some((s) => p.startsWith(s))
  || patterns.some((re) => re.test(p));

/**
 * The pages the server actually serves, not the .html files lying in web/.
 *
 * Retired pages stay on disk with their old links in them, and checking those would report dead
 * assets for pages nobody can reach. What matters is what a visitor can load.
 */
const served = [...new Set([...server.matchAll(/serveStatic\(res, '([^']+\.html)'\)/g)].map((m) => m[1]))]
  .filter((f) => fs.existsSync(path.join(WEB, f)));

/** Local hrefs and srcs a page asks for. External URLs and anchors are not ours to serve. */
function assetsOf(file) {
  const html = fs.readFileSync(path.join(WEB, file), 'utf8');
  const found = new Set();
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) {
    if (/\.(js|css|svg|png|jpg|webp|ico|woff2?)$/.test(m[1])) found.add(m[1]);
  }
  return found;
}

test('the harness found the routing table and the pages', () => {
  // Controls. Every check below passes trivially against an empty routing table or no pages.
  assert.ok(exact.size > 20, `only ${exact.size} exact routes parsed`);
  assert.ok(patterns.length > 5, `only ${patterns.length} route patterns rebuilt`);
  assert.ok(served.length > 4, `only ${served.length} served pages found`);
  assert.ok(answers('/style.css'), 'the most-linked stylesheet on the site read as unrouted');
  assert.ok(answers('/verge-runes.css'), 'an optional group in a route pattern was misread');
});

test('EVERY ASSET EVERY SERVED PAGE ASKS FOR IS ONE THE SERVER ANSWERS', () => {
  const missing = [];
  for (const page of served) {
    for (const asset of assetsOf(page)) {
      if (!answers(asset)) missing.push(`${page} asks for ${asset}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'unrouted assets:\n  ' + missing.join('\n  '));
});

test('and every one of them exists on disk', () => {
  const absent = [];
  for (const page of served) {
    for (const asset of assetsOf(page)) {
      if (!fs.existsSync(path.join(WEB, asset.slice(1)))) absent.push(`${page} asks for ${asset}`);
    }
  }
  assert.deepStrictEqual(absent, [], 'missing files:\n  ' + absent.join('\n  '));
});

test('CONTROL: an asset with no route is reported as having none', () => {
  assert.strictEqual(answers('/runes-market.js'), true, 'the real one is routed');
  assert.strictEqual(answers('/runes-trade.css'), true);
  assert.strictEqual(answers('/a-page-nobody-routed.js'), false);
});

test('a page the nav links to is a page the server serves', () => {
  const links = new Set();
  for (const page of served) {
    const html = fs.readFileSync(path.join(WEB, page), 'utf8');
    for (const m of html.matchAll(/href="(\/[a-z0-9/-]*)"/g)) {
      if (m[1] !== '/' && !m[1].includes('.')) links.add(m[1]);
    }
  }
  const dead = [...links].filter((p) => !answers(p));
  assert.deepStrictEqual(dead, [], 'links to nowhere:\n  ' + dead.join('\n  '));
});

console.log(`\n${passed} page asset tests passed`);
