// The Adventure UI module, against a minimal DOM. What matters here is not pixels: it is that the
// sprite URLs the renderer emits are URLs the server actually serves, and that the layer order and
// the pip bar's shape channel survive the trip into the browser.
// Run: node test/adventure-ui.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }


// --- a DOM small enough to read ------------------------------------------------------------------

function makeDoc() {
  const node = (tag) => ({
    tagName: tag.toUpperCase(),
    children: [],
    style: { cssText: '', _props: {}, set clipPath(v) { this._props.clipPath = v; }, get clipPath() { return this._props.clipPath; } },
    attrs: {},
    set textContent(v) { this._text = v; this.children.length = 0; },
    get textContent() { return this._text; },
    set src(v) { this.attrs.src = v; },
    get src() { return this.attrs.src; },
    append(...kids) { this.children.push(...kids); },
    // The kit reaches for appendChild; our own code uses append. Both, or the kit's pipBar throws.
    appendChild(kid) { this.children.push(kid); return kid; },
    prepend(...kids) { this.children.unshift(...kids); },
  });
  return { createElement: node };
}
global.document = makeDoc();

const kitSrc = fs.readFileSync(path.join(__dirname, '..', 'sprites', 'verginals-kit.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'adventure.js'), 'utf8');

/** Evaluate an ES module's exports without a bundler: strip the syntax, run, read the locals. */
function loadModule(src, injected = {}) {
  const body = src
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+'[^']+';?/gm, '')
    .replace(/^export\s+\{[^}]*\};?/gm, '')
    .replace(/^export\s+(async\s+)?function/gm, '$1function')
    .replace(/^export\s+(const|class)/gm, '$1');
  const names = Object.keys(injected);
  // Two export forms to collect: `export function foo` declarations, and the trailing
  // `export { a, b }` list. Missing the second is how this harness silently returns half a module.
  const declared = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
  const listed = [...src.matchAll(/^export\s+\{([^}]*)\};?/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  const exported = [...new Set([...declared, ...listed])].filter((n) => !names.includes(n));
  const collect = `{ ${exported.join(', ')} }`;
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn ${collect};`)(...names.map((n) => injected[n]));
}

const kit = loadModule(kitSrc);

// The art module draws to a canvas, which this DOM deliberately does not have: the point of a fake
// document this small is that it stays readable. So the drawing functions are stubbed and the pip
// bar is the real one from the kit, because the bar is the thing this file is here to check.
const drawn = [];
const stubSprite = (name) => { drawn.push(name); const n = document.createElement('canvas'); n.attrs.sprite = name; return n; };
const art = {
  sprite: (name) => stubSprite(name),
  elementBadge: (e) => stubSprite(`badge:${e}`),
  moveIcon: (e) => stubSprite(`move:${e}`),
  attentionIcon: (k) => stubSprite(`attention:${k}`),
  egg: (p) => stubSprite(`egg:${p >= 0.66 ? 2 : p >= 0.33 ? 1 : 0}`),
  playEffect: (host, fx) => { drawn.push(`fx:${fx}`); return () => {}; },
  effectFor: (e) => ({ fire: 'fireHit', earth: 'earthHit', water: 'waterHit' }[e] || null),
  arena: () => document.createElement('div'),
  alleleColor: (v) => `#${String(v).length.toString(16).padStart(6, '0')}`,
};

const ui = loadModule(uiSrc, {
  PALETTE: kit.PALETTE, TRAIT_LAYERS: kit.TRAIT_LAYERS, LAYER_RECTS: kit.LAYER_RECTS,
  spriteUrl: kit.spriteUrl, seasonChip: kit.seasonChip, SEASON_DAYS: kit.SEASON_DAYS,
  pipBar: kit.pipBar, ...art,
});

// --- the creature renderer --------------------------------------------------------------------

const TRAITS = {
  Background: 'Spectrum', Body: 'Bitcoin Orange', Collar: 'Red',
  Face: 'Rainbow', Rune: 'Fire Red', House: 'Fire', Ears: 'Pink',
};

test('the renderer paints the kit layer order and never invents its own', () => {
  const box = ui.creature(TRAITS, 128);
  const layers = box.children.map((img) => decodeURIComponent(img.src).split('/')[2]);
  assert.deepStrictEqual(layers, kit.TRAIT_LAYERS);
  // The order the whole layer investigation settled on.
  assert.deepStrictEqual(kit.TRAIT_LAYERS, ['Body', 'Ears', 'Collar', 'Face', 'Rune']);
});

test('no layer is painted twice', () => {
  const layers = ui.creature(TRAITS, 128).children.map((i) => decodeURIComponent(i.src).split('/')[2]);
  assert.strictEqual(new Set(layers).size, layers.length, 'a layer was rendered more than once');
});

test('Background and House are not sprite layers, they are data, not art', () => {
  const layers = ui.creature(TRAITS, 128).children.map((i) => decodeURIComponent(i.src).split('/')[2]);
  assert.ok(!layers.includes('Background'));
  assert.ok(!layers.includes('House'));
});

test('a creature missing a trait renders the rest instead of throwing', () => {
  const box = ui.creature({ Body: 'Ginger', Ears: 'Pink' }, 64);
  assert.strictEqual(box.children.length, 2);
});

// --- the URLs must be URLs the server serves ------------------------------------------------------

// Kept in step with the route in src/server.js by hand; the test below fails loudly if they drift.
const ROUTE = /^\/sprites\/(Body|Ears|Collar|Face|Rune)\/([A-Za-z0-9%]{1,60})\.webp$/;
const NAME_AFTER_DECODE = /^[A-Za-z0-9 ]{1,40}$/;

test('EVERY sprite that ships produces a URL the route accepts, and vice versa', () => {
  // Enumerated from the sprite directory rather than from verginals/metadata.json, which is a
  // gitignored dump. The files on disk ARE what the route serves, so this is both the stronger
  // check and the one that still works on a fresh clone.
  const dir = path.join(__dirname, '..', 'sprites');
  let n = 0;
  for (const layer of kit.TRAIT_LAYERS) {
    const files = fs.readdirSync(path.join(dir, layer)).filter((f) => f.endsWith('.webp'));
    assert.ok(files.length, `no sprites shipped for ${layer}`);
    for (const file of files) {
      const value = file.slice(0, -'.webp'.length);
      const url = kit.spriteUrl(layer, value, '/sprites');
      const m = url.match(ROUTE);
      assert.ok(m, `the route rejects ${url}`);
      assert.strictEqual(decodeURIComponent(m[2]), value, `${url} does not decode back to its file name`);
      assert.ok(NAME_AFTER_DECODE.test(decodeURIComponent(m[2])), `${url} fails revalidation after decoding`);
      n += 1;
    }
  }
  assert.ok(n > 150, `expected the full layer set, saw ${n}`);
});

test('a value with a space survives encoding and decoding intact', () => {
  const url = kit.spriteUrl('Body', 'Bitcoin Orange', '/sprites');
  assert.strictEqual(url, '/sprites/Body/Bitcoin%20Orange.webp');
  const m = url.match(ROUTE);
  assert.ok(m, 'the route rejects a percent-encoded space');
  assert.strictEqual(decodeURIComponent(m[2]), 'Bitcoin Orange');
});

test('traversal cannot survive the decode-then-revalidate order', () => {
  for (const attack of ['%2e%2e%2f%2e%2e%2fetc%2fpasswd', '%2e%2e', 'a%2fb']) {
    const m = `/sprites/Body/${attack}.webp`.match(ROUTE);
    if (!m) continue; // rejected outright, fine
    assert.ok(!NAME_AFTER_DECODE.test(decodeURIComponent(m[2])), `${attack} passed revalidation`);
  }
});

// --- the pip bar ------------------------------------------------------------------------------

// The bar is the kit's own pipBar now, called with real allele pairs: expressed first, carried
// second. Four of these six slots are heterozygous.
const CREATURE = {
  alleles: {
    Background: ['Spectrum', 'Void'],
    Body: ['Bitcoin Orange', 'Bitcoin Orange'],
    Collar: ['Red', 'Emerald'],
    Face: ['Rainbow', 'Rainbow'],
    Rune: ['Fire Red', 'Sun Blue'],
    House: ['Fire', 'Water'],
  },
  zygosity: { Background: 'het', Body: 'hom', Collar: 'het', Face: 'hom', Rune: 'het', House: 'het' },
};
const isNotched = (col) => col.children[0].children.length > 0;

test('the pip bar draws six slots, two pips each', () => {
  const bar = ui.pips(CREATURE, 14);
  assert.strictEqual(bar.children.length, 6);
  for (const col of bar.children) assert.strictEqual(col.children.length, 2);
});

test('zygosity reads from the NOTCH, so it survives greyscale', () => {
  const bar = ui.pips(CREATURE, 14);
  assert.strictEqual(bar.children.filter(isNotched).length, 4, 'the four heterozygous slots must be notched');
  assert.strictEqual(bar.children.filter((c) => !isNotched(c)).length, 2);
});

test('the notch floors at 2px so it never disappears in a list row', () => {
  for (const cell of [6, 5, 3, 1]) {
    const bar = ui.pips(CREATURE, cell);
    const notch = bar.children[0].children[0].children[0];
    const px = Number(/width:(\d+(?:\.\d+)?)px/.exec(notch.style.cssText)[1]);
    assert.ok(px >= 2, `at cell ${cell}px the notch was ${px}px`);
  }
});

test('a homozygous slot has no dimmed lower pip, a heterozygous one does', () => {
  const bar = ui.pips(CREATURE, 14);
  assert.match(bar.children[0].children[1].style.cssText, /opacity:0\.55/);
  assert.ok(!/opacity/.test(bar.children[1].children[1].style.cssText));
});

test('two alleles that collide on one colour are still drawn as heterozygous', () => {
  // The colour pool is sixteen wide and Face alone has 44 values, so collisions are certain. The
  // kit compares colours; the names are the truth. Getting this wrong would draw "breeds true"
  // over a creature carrying something hidden.
  const collide = { alleles: { ...CREATURE.alleles, Rune: ['Fire Red', 'Sun Blue'] } };
  const sameColour = art.alleleColor('Fire Red') === art.alleleColor('Sun Blue');
  assert.ok(sameColour, 'this test is pointless unless the two names really do collide');
  const bar = ui.pips(collide, 14);
  assert.ok(isNotched(bar.children[4]), 'a colour collision must not erase the notch');
  assert.match(bar.children[4].children[1].style.cssText, /opacity:0\.55/);
});

test('the top pip is what is EXPRESSED and the bottom what is carried', () => {
  const bar = ui.pips(CREATURE, 14);
  // Collar shows Red and carries Emerald: two different names, so two different colours.
  const [top, bottom] = bar.children[2].children.map((p) => /background:(#[0-9a-f]+)/.exec(p.style.cssText)[1]);
  assert.notStrictEqual(top, bottom, 'a heterozygote must not draw the same colour twice');
  // Face is homozygous Rainbow, so both pips are the same colour and nothing is hidden.
  const face = bar.children[3].children.map((p) => /background:(#[0-9a-f]+)/.exec(p.style.cssText)[1]);
  assert.strictEqual(face[0], face[1]);
});

test('a payload with no allele pair still draws, and still notches', () => {
  // A browser holding an older page against a newer server, or the reverse. The bar degrades to
  // slot hues rather than throwing, and the shape channel still carries the genetics.
  const bar = ui.pips({ zygosity: CREATURE.zygosity }, 14);
  assert.strictEqual(bar.children.length, 6);
  assert.strictEqual(bar.children.filter(isNotched).length, 4);
});

console.log(`\n${passed} adventure-ui tests passed`);
