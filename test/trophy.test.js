// Trophy SVG generation: structure, embedded image, escaping, size budget. Hermetic.
// Run: node test/trophy.test.js
const assert = require('assert');
const { buildTrophySVG } = require('../src/trophy');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

const IMG = 'data:image/webp;base64,' + Buffer.alloc(4000, 7).toString('base64'); // ~5.3KB stand-in

const base = {
  number: 1856, house: 'earth', imageDataUri: IMG,
  tournamentName: 'First Blood Cup', seasonName: 'Season 1', dateISO: '2026-07-14', place: 'CHAMPION',
};

test('produces a standalone SVG document', () => {
  const svg = buildTrophySVG(base);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
});

test('embeds the champion image and identity', () => {
  const svg = buildTrophySVG(base);
  assert.ok(svg.includes(IMG), 'image data URI embedded');
  assert.ok(svg.includes('Verginals #1856'));
  assert.ok(svg.includes('CHAMPION'));
  assert.ok(svg.includes('First Blood Cup'));
  assert.ok(svg.includes('House of Earth'));
});

test('runner-up variant reads RUNNER-UP and stays valid', () => {
  const svg = buildTrophySVG({ ...base, place: 'RUNNER-UP' });
  assert.ok(svg.includes('RUNNER-UP'));
  assert.ok(!/>CHAMPION</.test(svg));
});

test('an unknown place defaults to CHAMPION', () => {
  assert.ok(buildTrophySVG({ ...base, place: 'whatever' }).includes('CHAMPION'));
});

test('escapes hostile tournament names (no raw markup injection)', () => {
  const svg = buildTrophySVG({ ...base, tournamentName: '<script>x</script>&"' });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('stays comfortably under the 68 KB inscription cap for a typical Verginal', () => {
  const svg = buildTrophySVG(base);
  assert.ok(Buffer.byteLength(svg, 'utf8') < 68 * 1024, `trophy is ${Buffer.byteLength(svg)} bytes`);
});

test('missing house still renders (default accent, no House line)', () => {
  const svg = buildTrophySVG({ ...base, house: undefined });
  assert.ok(svg.includes('Verginals #1856'));
  assert.ok(!svg.includes('House of'));
});

console.log(`\n${passed} passed`);
