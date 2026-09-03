// The front door, and the links out of it.
//
// The tab strip IS the router on this page: activateTab and tabFromHash both work by clicking a
// .tab, and the strip is hidden with CSS rather than removed. So a link that says data-goto="foo"
// with no matching tab does nothing at all, silently, and a panel with no tab can never be reached.
//
// The home panel made both failure modes newly likely: it is one screen of links into every other
// part of the site, and it took the default away from a panel that had held it since the beginning.
//
// Run: node test/home-routing.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

const tabs = [...html.matchAll(/class="tab[^"]*"\s+data-tab="([a-z]+)"/g)].map((m) => m[1]);
const panels = [...html.matchAll(/id="panel-([a-z]+)"/g)].map((m) => m[1]);
const gotos = [...html.matchAll(/data-goto="([a-z]+)"/g)].map((m) => m[1]);

test('the harness found the strip, the panels and the links', () => {
  assert.ok(tabs.length >= 10, `only ${tabs.length} tabs found`);
  assert.ok(panels.length >= 10, `only ${panels.length} panels found`);
  assert.ok(gotos.length >= 5, `only ${gotos.length} in-page links found`);
});

test('THE SITE OPENS ON THE FRONT DOOR', () => {
  assert.match(html, /<button class="tab active" data-tab="home">/,
    'home should be the tab that starts active');
  assert.match(html, /<section class="panel active" id="panel-home">/,
    'the home panel should be the one that starts active');
});

test('exactly one tab and one panel start active, or the page opens on two things', () => {
  assert.strictEqual((html.match(/class="tab active"/g) || []).length, 1);
  assert.strictEqual((html.match(/class="panel active"/g) || []).length, 1);
});

test('every tab has a panel, and every panel has a tab', () => {
  const orphanTabs = tabs.filter((t) => !panels.includes(t));
  const orphanPanels = panels.filter((p) => !tabs.includes(p));
  assert.deepStrictEqual(orphanTabs, [], 'tabs pointing at no panel: ' + orphanTabs.join(', '));
  assert.deepStrictEqual(orphanPanels, [], 'panels no tab can reach: ' + orphanPanels.join(', '));
});

test('EVERY IN-PAGE LINK POINTS AT A TAB THAT EXISTS', () => {
  // activateTab looks the tab up and does nothing when it is missing, so a typo here is a dead
  // link that throws nothing and logs nothing.
  const dead = [...new Set(gotos)].filter((g) => !tabs.includes(g));
  assert.deepStrictEqual(dead, [], 'links to no tab: ' + dead.join(', '));
});

test('the home panel is loaded even though nothing clicks its tab', () => {
  // It starts active, so the click handler that loads every other panel never fires for it.
  assert.match(app, /if \(t\.dataset\.tab === 'home'\) loadHome\(\);/);
  assert.match(app, /classList\.contains\('active'\)\) loadHome\(\)/,
    'the default-active case needs its own call or the front door renders empty');
});

test('CONTROL: a link to a tab that does not exist is reported', () => {
  const fake = [...new Set([...gotos, 'nosuchtab'])].filter((g) => !tabs.includes(g));
  assert.deepStrictEqual(fake, ['nosuchtab'], 'the check would not notice a dead link');
});

console.log(`\n${passed} home routing tests passed`);
