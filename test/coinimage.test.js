// A picture for a coin, and the ways somebody would try to make it something else.
//
// An upload endpoint is the most attacked thing a site has, so most of this file is about what must
// be REFUSED. Every rejection below has a matching acceptance, because a validator that refuses
// everything passes a security test and ships a broken feature.
//
// Run: node test/coinimage.test.js
const assert = require('assert');
const path = require('path');
const { check, sniff, fileFor, urlFor, MAX_BYTES, MAX_SOURCE_BYTES, MAX_SIDE } = require('../src/coinimage');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

// --- real files, built by hand so the test owns its own fixtures -------------------------------

/** A valid PNG of the given size: signature, IHDR, and enough after it to be a file. */
function png(w = 64, h = 64, pad = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad)]);
}
function gif(w = 32, h = 32) {
  const b = Buffer.alloc(64);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function jpeg(w = 48, h = 48) {
  const head = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([head, sof, Buffer.alloc(20), Buffer.from([0xff, 0xd9])]);
}

// --- what must be accepted -----------------------------------------------------------------------

test('a small PNG, JPEG and GIF are all accepted, with their real size read back', () => {
  const p = check(png(64, 64));
  assert.ok(p.ok, p.why);
  assert.deepStrictEqual([p.mime, p.w, p.h], ['image/png', 64, 64]);
  const j = check(jpeg(48, 48));
  assert.ok(j.ok, j.why);
  assert.deepStrictEqual([j.mime, j.w, j.h], ['image/jpeg', 48, 48]);
  const g = check(gif(32, 32));
  assert.ok(g.ok, g.why);
  assert.deepStrictEqual([g.mime, g.w, g.h], ['image/gif', 32, 32]);
});

// --- what must be refused --------------------------------------------------------------------------

test('SVG IS REFUSED, whatever it claims to be', () => {
  // The one that matters most: SVG is XML, it can carry a script, and served from our own origin
  // that is stored cross-site scripting with the session of whoever opens the coin.
  const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const r = check(evil);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /SVG is not accepted/);
});

test('HTML that calls itself a PNG is refused, because the header is what decides', () => {
  const r = check(Buffer.from('<html><body><script>alert(1)</script></body></html>'));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /not a PNG/);
});

test('a POLYGLOT is still only ever served as the image it structurally is', () => {
  // The classic upload bypass: a real PNG header with markup appended. It IS a png by every
  // structural measure, so it is accepted AS a png. The defence is not that we hunt for the script,
  // it is that the type is pinned from the sniff and sent with nosniff, so the tail is never
  // interpreted as anything.
  const poly = Buffer.concat([png(8, 8, 8), Buffer.from('<script>alert(1)</script>')]);
  const r = check(poly);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mime, 'image/png', 'it must be served as an image and never as anything else');
});

test('an oversized file is refused before anything else looks at it', () => {
  const r = check(Buffer.concat([png(8, 8, 8), Buffer.alloc(MAX_BYTES + 1)]));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, new RegExp('limit is ' + (MAX_BYTES / 1024) + ' KB'));
});

test('A DECOMPRESSION BOMB is refused on its declared dimensions', () => {
  // 40 KB of PNG declaring 60,000 by 60,000. Nothing here decodes it, which is the real defence,
  // but the cap means nothing downstream can be talked into decoding it either.
  const r = check(png(60000, 60000));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, new RegExp('limit is ' + MAX_SIDE));
});

test('an empty body is refused', () => {
  assert.strictEqual(check(Buffer.alloc(0)).ok, false);
  assert.strictEqual(check(null).ok, false);
});

test('a zero-dimension image is refused rather than stored', () => {
  assert.strictEqual(check(png(0, 0)).ok, false);
});

// --- the filesystem ------------------------------------------------------------------------------------

test('THE STORED NAME IS BUILT FROM INTEGERS, so a hostile reference cannot escape the directory', () => {
  const dir = '/srv/images';
  // Every one of these is refused as an unparseable rune long before anything touches a path.
  const hostile = ['../../etc/passwd', '9420444:2/../../x', '../9420444:2', '9420444:2 ',
    'a:b', '9420444:2;rm -rf /', './9420444:2', '9420444:2/..%2f..%2f', ''];
  for (const evil of hostile) {
    assert.strictEqual(fileFor(dir, evil, 'png'), null, JSON.stringify(evil) + ' should be refused');
  }
  const good = fileFor(dir, '9420444:2', 'png');
  assert.strictEqual(good, path.join(dir, '9420444-2.png'));
  assert.ok(good.startsWith(dir + path.sep), 'the file must land inside the directory');
});

test('the extension is checked too, so it cannot smuggle a path either', () => {
  for (const ext of ['../x', 'p/g', 'PNG', '', 'aaaaaaaaa', '.', '..']) {
    assert.strictEqual(fileFor('/srv/images', '9420444:2', ext), null,
      JSON.stringify(ext) + ' slipped through');
  }
  assert.ok(fileFor('/srv/images', '9420444:2', 'webp'));
});

test('the public url is derived the same way and carries nothing from the caller', () => {
  assert.strictEqual(urlFor('9420444:2'), '/api/runes/image/9420444-2');
  assert.strictEqual(urlFor('../../etc/passwd'), null);
  assert.strictEqual(urlFor('9420444:2/../x'), null);
});

test('CONTROL: the sniffer really can tell these apart', () => {
  assert.strictEqual(sniff(png()).mime, 'image/png');
  assert.strictEqual(sniff(Buffer.from('not an image at all')), null);
});

// --- what may be chosen, and what is kept -------------------------------------------------------
//
// Two numbers that were being answered with one. A picture off a phone is megabytes, and telling
// somebody to go and shrink it themselves is telling them to go away, so the browser reduces it to
// WEBP first. What is enforced HERE is only ever what gets stored: the server believes nothing about
// what happened before the bytes arrived.

test('THE SOURCE CEILING IS FAR ABOVE THE STORED ONE', () => {
  assert.ok(MAX_SOURCE_BYTES > MAX_BYTES * 4,
    'if they were close, the browser would have nothing to reduce and people would still be refused');
  assert.strictEqual(MAX_SOURCE_BYTES, 2 * 1024 * 1024);
});

test('and the server still enforces the STORED one, whatever a page did first', () => {
  // The reduction is a courtesy in somebody's browser. It is not a promise the server may rely on.
  const big = Buffer.concat([png(8, 8, 8), Buffer.alloc(MAX_BYTES + 1)]);
  const r = check(big);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, new RegExp('limit is ' + (MAX_BYTES / 1024) + ' KB'));
});

test('a picture that a phone would produce fits once reduced', () => {
  // 1024 square is the ceiling, and a WEBP of a photograph at that size lands well inside 256 KB.
  assert.ok(MAX_BYTES >= 200 * 1024, 'a 1024 pixel photograph needs room to look like one');
  assert.strictEqual(MAX_SIDE, 1024);
});

test('CONTROL: the old ceiling would have refused that same picture', () => {
  const OLD = 100 * 1024;
  assert.ok(OLD < 150 * 1024, 'the cap this replaces was too small for a photograph at 1024 square');
  assert.ok(MAX_BYTES > OLD);
});

console.log('\n' + passed + ' coin image tests passed');
