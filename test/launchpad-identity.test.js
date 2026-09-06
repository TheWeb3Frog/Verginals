// Giving a collection a face, and giving its creator a way back.
//
// A collection had a name, a symbol, a description and a free-text creator string. No avatar, no
// banner, no links: it could not look like anything, so it could not make anybody want it. And a
// submission was a one-way door. No contact was ever collected, no endpoint answered about a
// submission, and the rejection reason has always been STORED with no path by which anybody could
// read one. A decision could not reach the person who asked for it.
//
// Run: node test/launchpad-identity.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Launchpad, cleanLink, LIMITS } = require('../src/launchpad');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function png(w = 64, h = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr]);
}
const b64 = png().toString('base64');
const ADDR = 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM';
const fresh = () => new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vid-')) });

test('the harness found every side, so an empty check is not a pass', () => {
  assert.ok(typeof cleanLink === 'function' && LIMITS.linkHosts);
  assert.ok(server.length > 100000 && html.length > 20000 && app.length > 80000);
});

// --- links are checked against hosts, not accepted as text -------------------------------------------

test('A LINK IS CHECKED AGAINST A HOST LIST, not taken as text', () => {
  // The first collection that writes discord.gg/something-else in a free field publishes it from
  // this site, wrapped in this site's name, and a visitor reads that as an endorsement.
  assert.strictEqual(cleanLink('x', 'x.com/verginals'), 'https://x.com/verginals');
  assert.strictEqual(cleanLink('x', 'https://twitter.com/verginals'), 'https://twitter.com/verginals');
  assert.throws(() => cleanLink('x', 'https://not-x.example/verginals'), /has to be on x\.com/);
  assert.throws(() => cleanLink('discord', 'https://evil.example/invite'), /has to be on discord\.gg/);
  assert.strictEqual(cleanLink('discord', 'discord.gg/abcdef'), 'https://discord.gg/abcdef');
});

test('and a website may be anywhere, but still has to be a web address', () => {
  assert.strictEqual(cleanLink('website', 'verginals.com'), 'https://verginals.com/');
  assert.throws(() => cleanLink('website', 'javascript:alert(1)'), /not a web address/);
  assert.throws(() => cleanLink('website', 'not a url at all'), /not a web address/);
});

test('http is upgraded rather than published as typed', () => {
  assert.match(cleanLink('website', 'http://verginals.com'), /^https:/);
});

test('nothing given is nothing stored', () => {
  assert.strictEqual(cleanLink('x', ''), null);
  assert.strictEqual(cleanLink('x', '   '), null);
  assert.strictEqual(cleanLink('discord', undefined), null);
});

test('a bad link is REFUSED, not silently dropped', () => {
  // Stripping it would publish the collection without the link the creator thought they gave.
  const l = fresh();
  assert.throws(
    () => l.createDraft({ name: 'Frogs', address: ADDR, links: { x: 'https://evil.example/x' } }),
    /has to be on x\.com/);
});

// --- the images -------------------------------------------------------------------------------------

test('the avatar is checked exactly as hard as the art is', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR });
  assert.throws(() => l.setBrandImage(id, 'avatar', png(4000, 4000).toString('base64')),
    new RegExp(`4000 by 4000 and the limit is ${LIMITS.maxImageSide}`));
  const r = l.setBrandImage(id, 'avatar', b64);
  assert.deepStrictEqual([r.kind, r.w, r.h], ['avatar', 64, 64]);
});

test('and only an avatar or a banner: the kind is a closed set', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR });
  for (const bad of ['../../etc/passwd', 'items', '', 'AVATAR']) {
    assert.throws(() => l.setBrandImage(id, bad, b64), /avatar or a banner/);
  }
});

test('THE STORED NAME IS SERVER CHOSEN, so nothing a caller sends reaches the filesystem', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR });
  l.setBrandImage(id, 'banner', b64);
  const d = l._loadDraft(id);
  assert.strictEqual(d.banner, 'banner.png');
  assert.match(server, /path\.basename\(name\)/, 'and the route basenames it again on the way out');
});

test('identity survives approval into the manifest and the grid', () => {
  const l = fresh();
  const { id } = l.createDraft({
    name: 'Frogs', address: ADDR, tagline: '3,333 frogs',
    links: { x: 'x.com/frogs', website: 'frogs.example' },
  });
  l.addItem(id, { dataBase64: b64 });
  l.setBrandImage(id, 'avatar', b64);
  l.finalize(id);
  l.approve(id, 'frogs');
  const m = JSON.parse(fs.readFileSync(path.join(l.collsDir, 'frogs', 'collection_manifest.json'), 'utf8'));
  assert.strictEqual(m.tagline, '3,333 frogs');
  assert.strictEqual(m.links.x, 'https://x.com/frogs');
  assert.strictEqual(m.avatar, 'avatar.png');
  assert.ok(fs.existsSync(path.join(l.collsDir, 'frogs', 'images', 'avatar.png')), 'and the file came with it');
  const row = l.list().find((c) => c.slug === 'frogs');
  assert.strictEqual(row.avatar, '/api/launchpad/frogs/brand/avatar');
  assert.strictEqual(row.banner, null, 'a banner nobody gave is null, not a broken url');
});

// --- the way back --------------------------------------------------------------------------------------

test('THE REJECTION REASON CAN FINALLY BE READ', () => {
  const fn = /function handleLaunchpadSubmitStatus\(res, id\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(fn, 'the status route should exist');
  assert.match(fn[0], /reason: d\.reason \|\| null/);
  assert.match(server, /\/api\\\/launchpad\\\/submit\\\/\(\[a-f0-9\]\{16\}\)\$/,
    'and it is routed');
});

test('and it answers about the submission, never about the submitter', () => {
  const fn = /function handleLaunchpadSubmitStatus\(res, id\) \{[\s\S]*?\n\}/.exec(server)[0];
  for (const secret of ['contact', 'address', 'payoutAddress', 'depositWif']) {
    assert.ok(!new RegExp(secret + ':').test(fn), `${secret} must not be published`);
  }
});

test('the contact is collected, and shown only to the reviewer', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs', address: ADDR, contact: 'me@example.com' });
  assert.strictEqual(l._loadDraft(id).contact, 'me@example.com');
  assert.match(html, /id="lps-contact"/, 'the form asks for it');
  const lp = fs.readFileSync(path.join(__dirname, '..', 'src', 'launchpad.js'), 'utf8');
  assert.match(lp, /contact {8}\$\{d\.contact \|\| '\(none given\)'\}/,
    'and the review command prints it');
});

test('NO EMPTY CLASS TOKEN REACHES classList.add', () => {
  // classList.add('') throws, and the tracker did exactly that for a pending submission, which is
  // the answer most people asking will get. It died silently on the common case.
  // Comments stripped first: this checks code, and the comment explaining the bug names the shape.
  const code = app.replace(/^\s*\/\/.*$/gm, '');
  const bad = [...code.matchAll(/classList\.add\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((arg) => /\?[^:]*:\s*''/.test(arg) || /:\s*''\s*$/.test(arg));
  assert.deepStrictEqual(bad, [], 'these can pass an empty token, which throws:\n  ' + bad.join('\n  '));
});

test('CONTROL: the check really catches that shape', () => {
  const sample = "out.classList.add(x === 'a' ? 'is-in' : y ? 'is-out' : '');";
  const found = [...sample.matchAll(/classList\.add\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((arg) => /\?[^:]*:\s*''/.test(arg) || /:\s*''\s*$/.test(arg));
  assert.strictEqual(found.length, 1, 'the pattern that shipped must be detectable');
});

test('a reference can be typed back in, which is the whole point of having one', () => {
  assert.match(html, /id="lps-track-id"/);
  assert.match(app, /api\('\/api\/launchpad\/submit\/' \+ id\)/);
  assert.match(app, /Not accepted/, 'and a refusal says so in words');
});

console.log('\n' + passed + ' launchpad identity tests passed');
