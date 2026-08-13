// The habitat's behaviour, without a browser.
//
// The scene itself needs a compositor, an animation loop and a ResizeObserver, none of which belong
// in a test. What can be checked here is the part that carries the design claim: ADVENTURE-MODE-v0
// §5.1 says attention "decides WHAT IT BECOMES", and weightsFor() is where that sentence turns into
// something observable. If these weights stop leaning, the screen still animates and the promise is
// quietly gone, which is exactly the kind of regression nothing else would catch.
// Run: node test/habitat.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

/** Same trick as adventure-ui.test.js: strip the module syntax, run the body, read the locals. */
function loadModule(src, injected = {}) {
  const body = src
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+'[^']+';?/gm, '')
    .replace(/^export\s+\{[^}]*\};?/gm, '')
    .replace(/^export\s+(async\s+)?function/gm, '$1function')
    .replace(/^export\s+(const|class)/gm, '$1');
  const names = Object.keys(injected);
  const declared = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
  const listed = [...src.matchAll(/^export\s+\{([^}]*)\};?/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  const exported = [...new Set([...declared, ...listed])].filter((n) => !names.includes(n));
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { ${exported.join(', ')} };`)(...names.map((n) => injected[n]));
}

const kitSrc = fs.readFileSync(path.join(__dirname, '..', 'sprites', 'verginals-kit.js'), 'utf8');
const kit = loadModule(kitSrc, {});
const habSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'adventure-habitat.js'), 'utf8');
const hab = loadModule(habSrc, {
  PALETTE: kit.PALETTE, PALETTES: kit.PALETTES, SPRITES: kit.SPRITES, toCanvas: () => null,
  creatureSprite: () => null, playEffect: () => {}, effectFor: () => null,
});

const { weightsFor, EMOTES, ACTS } = hab;

/** Which behaviour a set of weights favours most. */
const favourite = (w) => Object.keys(w).reduce((a, b) => (w[b] > w[a] ? b : a));

// --- the design claim ---------------------------------------------------------------------------

test('an untouched juvenile is curious rather than specialised', () => {
  const w = weightsFor({});
  // Nothing dominates: the widest gap is small, so a creature nobody has raised does a bit of
  // everything instead of already having a personality.
  const values = Object.values(w);
  assert.ok(Math.max(...values) - Math.min(...values) <= 2, JSON.stringify(w));
});

test('each upbringing produces its own signature behaviour', () => {
  assert.strictEqual(favourite(weightsFor({ spar: 9 })), 'wander');
  assert.strictEqual(favourite(weightsFor({ feed: 9 })), 'nap');
  assert.strictEqual(favourite(weightsFor({ play: 9 })), 'ball');
  assert.strictEqual(favourite(weightsFor({ drill: 9 })), 'practise');
});

test('the lean grows with how much of that attention it had', () => {
  const light = weightsFor({ play: 1, feed: 1, spar: 1, drill: 1 });
  const heavy = weightsFor({ play: 9, feed: 1, spar: 1, drill: 1 });
  assert.ok(heavy.ball > light.ball, `${heavy.ball} should exceed ${light.ball}`);
});

test('no behaviour is ever weighted out of existence', () => {
  // A creature raised entirely on one thing must still occasionally do the others, or the habitat
  // becomes a loop of one animation and stops reading as an animal.
  for (const kind of ['spar', 'drill', 'feed', 'play']) {
    const w = weightsFor({ [kind]: 50 });
    for (const [name, value] of Object.entries(w)) {
      assert.ok(value > 0, `${kind}-raised has ${name} at ${value}`);
    }
  }
});

test('a balanced upbringing favours nothing in particular', () => {
  const w = weightsFor({ spar: 5, drill: 5, feed: 5, play: 5 });
  const values = Object.values(w);
  assert.ok(Math.max(...values) - Math.min(...values) <= 3.5, JSON.stringify(w));
});

// --- the drawings -------------------------------------------------------------------------------

test('every emote is a well formed 16x16 grid', () => {
  const names = Object.keys(EMOTES);
  assert.ok(names.length >= 6, `only ${names.length} emotes`);
  for (const name of names) {
    const rows = EMOTES[name];
    assert.strictEqual(rows.length, 16, `${name} has ${rows.length} rows`);
    for (const row of rows) assert.strictEqual(row.length, 16, `${name} has a row of ${row.length}`);
  }
});

test('emotes only use palette keys the kit understands', () => {
  // A stray character draws nothing and does it silently, which is the worst way for art to fail.
  const legal = new Set(['.', 'K', 'F', 'L', 'W', 'D']);
  for (const [name, rows] of Object.entries(EMOTES)) {
    for (const row of rows) {
      for (const ch of row) assert.ok(legal.has(ch), `${name} uses "${ch}"`);
    }
  }
});

test('the four props are the four attentions, and they do not overlap', () => {
  assert.deepStrictEqual(ACTS.map((a) => a.kind).sort(), ['drill', 'feed', 'play', 'spar']);
  const xs = ACTS.map((a) => a.at).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] - xs[i - 1] >= 0.15, `props at ${xs[i - 1]} and ${xs[i]} are too close`);
  }
  for (const a of ACTS) assert.ok(a.at > 0.05 && a.at < 0.95, `${a.kind} sits off the floor`);
});

test('every prop names a sprite and a palette the kit actually ships', () => {
  for (const a of ACTS) {
    assert.ok(kit.SPRITES[a.sprite], `no sprite named ${a.sprite}`);
    assert.ok(kit.PALETTES[a.pal], `no palette named ${a.pal}`);
    assert.ok(EMOTES[a.emote], `no emote named ${a.emote}`);
  }
});

console.log(`\n${passed} habitat tests passed`);
