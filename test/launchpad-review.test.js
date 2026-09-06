// The page a decision is actually made from.
//
// The review command printed the draft record as JSON and named the directory the images were in.
// That directory is on a machine reached over ssh, so looking at the art meant copying files down by
// hand, and the question that matters most, whether this is somebody else's work, could not be
// asked from a terminal at all.
//
// Run: node test/launchpad-review.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reviewPage, duplicates, distribution, MAX_TILES } = require('../src/launchpadreview');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

/** A distinct PNG per call, so identical files are identical on purpose and not by accident. */
function png(seed = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(64, 8); ihdr.writeUInt32BE(64, 12);
  return Buffer.concat([sig, ihdr, Buffer.from([seed])]);
}

function fixture(n = 3, sameAt = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrev-'));
  const items = [];
  for (let i = 1; i <= n; i++) {
    const seed = sameAt && i === sameAt ? 1 : i;
    fs.writeFileSync(path.join(dir, i + '.png'), png(seed));
    items.push({
      number: i, filename: i + '.png', name: 'Frog #' + i,
      attributes: [
        { trait_type: 'Background', value: i === 1 ? 'Nebula' : 'Swamp' },
        { trait_type: 'Eyes', value: 'Laser' },
      ],
    });
  }
  const draft = {
    id: 'a'.repeat(16), name: 'Cosmic Frogs', creator: '@frogman', tagline: 'frogs, on Verge',
    description: 'A test collection', mediaType: 'image/png', totalBytes: 33 * n,
    mintPriceUnits: 500 * 1e6, royaltyBps: 500, payoutAddress: 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM',
    address: 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM', contact: 'me@example.com',
    links: { x: 'https://x.com/frogs', discord: null, website: null },
    items,
  };
  return { dir, draft };
}

test('the harness builds a real fixture, so an empty check is not a pass', () => {
  const { dir, draft } = fixture(3);
  assert.strictEqual(fs.readdirSync(dir).length, 3);
  assert.strictEqual(draft.items.length, 3);
});

// --- the checks that need a machine ------------------------------------------------------------------

test('DUPLICATE IMAGES ARE FOUND BY CONTENT, not by name', () => {
  // The most common defect in a generated collection and the least visible: nothing about a folder
  // of ten thousand files makes two identical ones obvious.
  const { dir, draft } = fixture(4, 3); // item 3 is byte-identical to item 1
  const d = duplicates(dir, draft.items);
  assert.strictEqual(d.length, 1);
  assert.deepStrictEqual(d[0], { a: 1, b: 3 });
});

test('and a clean collection reports none', () => {
  const { dir, draft } = fixture(5);
  assert.deepStrictEqual(duplicates(dir, draft.items), []);
});

test('a missing file does not throw the whole review away', () => {
  const { dir, draft } = fixture(3);
  fs.unlinkSync(path.join(dir, '2.png'));
  assert.doesNotThrow(() => duplicates(dir, draft.items));
  assert.match(reviewPage(draft, dir), /missing/);
});

test('the distribution counts what is there', () => {
  const { draft } = fixture(4);
  const d = distribution(draft.items);
  const bg = d.find((g) => g.type === 'Background');
  assert.deepStrictEqual(bg.values, [['Swamp', 3], ['Nebula', 1]], 'ordered by how common');
});

// --- the page ------------------------------------------------------------------------------------------

test('THE PAGE ANSWERS EVERY QUESTION A DECISION NEEDS', () => {
  const { dir, draft } = fixture(3);
  const html = reviewPage(draft, dir);
  for (const must of ['Cosmic Frogs', '@frogman', 'me@example.com', 'https://x.com/frogs',
    '500 XVG', '5%', 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM', 'Background', 'Nebula']) {
    assert.ok(html.includes(must), 'the page should state: ' + must);
  }
  assert.match(html, /approve a{16} &lt;slug&gt;/, 'and hand over the command to act on it');
});

test('the images are IN the page, so it opens anywhere with nothing beside it', () => {
  const { dir, draft } = fixture(3);
  const html = reviewPage(draft, dir);
  const inlined = (html.match(/data:image\/png;base64,/g) || []).length;
  assert.strictEqual(inlined, 3);
});

test('a huge collection does not become a two hundred megabyte page', () => {
  const { dir, draft } = fixture(2);
  draft.items = Array.from({ length: MAX_TILES + 50 }, (_, i) => ({
    number: i + 1, filename: ((i % 2) + 1) + '.png', name: 'x', attributes: [],
  }));
  const html = reviewPage(draft, dir);
  assert.strictEqual((html.match(/<figure/g) || []).length, MAX_TILES);
  assert.match(html, new RegExp('first ' + MAX_TILES + ' of 350'));
});

test('MIXED FORMATS ARE FLAGGED, because a collection is one format', () => {
  const { dir, draft } = fixture(2);
  draft.items[1].filename = '2.gif';
  fs.writeFileSync(path.join(dir, '2.gif'), png(9));
  assert.match(reviewPage(draft, dir), /Mixed formats/);
  const clean = fixture(2);
  assert.ok(!/Mixed formats/.test(reviewPage(clean.draft, clean.dir)));
});

test('everything from the submission is escaped on the way in', () => {
  const { dir, draft } = fixture(1);
  draft.name = '<script>alert(1)</script>';
  draft.creator = '"onload="alert(2)';
  const html = reviewPage(draft, dir);
  assert.ok(!html.includes('<script>alert(1)'), 'a name is somebody else\'s text');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/"onload="/.test(html.replace(/&quot;/g, '')));
});

test('a free collection with no royalty says so rather than showing a zero', () => {
  const { dir, draft } = fixture(2);
  draft.mintPriceUnits = 0;
  draft.royaltyBps = 0;
  draft.payoutAddress = null;
  const html = reviewPage(draft, dir);
  assert.match(html, /<dd>free<\/dd>/);
  assert.match(html, /<dd>none<\/dd>/);
  assert.match(html, /<dd>nobody<\/dd>/);
});

test('CONTROL: the duplicate check really can tell two files apart', () => {
  const { dir, draft } = fixture(2);
  const bytes = draft.items.map((it) => fs.readFileSync(path.join(dir, it.filename)).toString('hex'));
  assert.notStrictEqual(bytes[0], bytes[1], 'the fixture must produce distinct files');
});

console.log('\n' + passed + ' launchpad review tests passed');
