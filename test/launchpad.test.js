// Launchpad lifecycle: submission drafts, validation, curation, and live collection loading.
// Run: node test/launchpad.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Launchpad, sniffImage } = require('../src/launchpad');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPxxxx')]);
const png64 = PNG.toString('base64');

function fresh() {
  return new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vlaunch-')) });
}

// --- image sniffing ------------------------------------------------------------------------
test('sniffImage identifies the accepted formats and rejects junk', () => {
  assert.strictEqual(sniffImage(PNG), 'image/png');
  assert.strictEqual(sniffImage(WEBP), 'image/webp');
  assert.strictEqual(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.strictEqual(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.strictEqual(sniffImage(Buffer.from('hello world')), null);
});

// --- submission flow -----------------------------------------------------------------------
test('draft -> items -> finalize produces a pending submission', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs', symbol: 'frg', description: 'ribbit', creator: '@frog' });
  assert.strictEqual(lp.addItem(id, { filename: 'a.png', dataBase64: png64, name: 'Frog 1', attributes: [{ trait_type: 'Mood', value: 'Happy' }] }).count, 1);
  assert.strictEqual(lp.addItem(id, { filename: 'b.png', dataBase64: png64 }).count, 2);
  const fin = lp.finalize(id);
  assert.strictEqual(fin.status, 'pending');
  assert.strictEqual(fin.items, 2);
  const d = lp.listSubmissions()[0];
  assert.strictEqual(d.symbol, 'FRG');
  assert.strictEqual(d.items[1].name, 'Frogs #2'); // default name
});

test('a finalized submission accepts no more items', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs' });
  lp.addItem(id, { dataBase64: png64 });
  lp.finalize(id);
  assert.throws(() => lp.addItem(id, { dataBase64: png64 }), /closed/);
});

test('images must all share one format', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs' });
  lp.addItem(id, { dataBase64: png64 });
  assert.throws(() => lp.addItem(id, { dataBase64: WEBP.toString('base64') }), /share one format/);
});

test('junk bytes and oversized images are rejected', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs' });
  assert.throws(() => lp.addItem(id, { dataBase64: Buffer.from('not an image').toString('base64') }), /not a supported image/);
  const big = Buffer.concat([PNG, Buffer.alloc(61 * 1024)]);
  assert.throws(() => lp.addItem(id, { dataBase64: big.toString('base64') }), /too large/);
});

test('item filenames on disk are server-chosen, never user input', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs' });
  lp.addItem(id, { filename: '../../evil.sh', dataBase64: png64 });
  const files = fs.readdirSync(path.join(lp.subsDir, id, 'images'));
  assert.deepStrictEqual(files, ['1.png']);
});

// --- curation ------------------------------------------------------------------------------
test('approve builds a live, loadable collection with committed-random order', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs', creator: '@frog' });
  lp.addItem(id, { dataBase64: png64, name: 'A', attributes: [{ trait_type: 'X', value: '1' }] });
  lp.addItem(id, { dataBase64: png64, name: 'B' });
  lp.finalize(id);
  const r = lp.approve(id, 'frogs');
  assert.strictEqual(r.slug, 'frogs');
  assert.strictEqual(r.supply, 2);
  const live = lp.get('frogs');
  assert.ok(live && live.ctl.commitment, 'has a fairness commitment');
  const a = live.ctl.reserve('job1');
  assert.ok([1, 2].includes(a.number));
  const s = live.ctl.status();
  assert.strictEqual(s.supply, 2);
  assert.strictEqual(s.reserved, 1);
});

test('slugs are validated, reserved names and duplicates refused', () => {
  const lp = fresh();
  const mk = () => {
    const { id } = lp.createDraft({ name: 'X' });
    lp.addItem(id, { dataBase64: png64 });
    lp.finalize(id);
    return id;
  };
  assert.throws(() => lp.approve(mk(), 'Bad Slug!'), /slug must be/);
  assert.throws(() => lp.approve(mk(), 'alpha'), /reserved/);
  lp.approve(mk(), 'frogs');
  assert.throws(() => lp.approve(mk(), 'frogs'), /already in use/);
});

test('reject closes the submission and drops its images from disk', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Bad stuff' });
  lp.addItem(id, { dataBase64: png64 });
  lp.finalize(id);
  lp.reject(id, 'not suitable');
  const d = lp.listSubmissions()[0];
  assert.strictEqual(d.status, 'rejected');
  assert.ok(!fs.existsSync(path.join(lp.subsDir, id, 'images')), 'images removed');
  assert.throws(() => lp.approve(id, 'nope'), /rejected/);
});

test('approve is only possible on pending submissions', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs' });
  lp.addItem(id, { dataBase64: png64 });
  assert.throws(() => lp.approve(id, 'frogs'), /draft, not pending/);
});

test('list() surfaces live collections with mint status', () => {
  const lp = fresh();
  const { id } = lp.createDraft({ name: 'Frogs', description: 'ribbit', creator: '@frog' });
  lp.addItem(id, { dataBase64: png64 });
  lp.finalize(id);
  lp.approve(id, 'frogs');
  const list = lp.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].slug, 'frogs');
  assert.strictEqual(list[0].creator, '@frog');
  assert.strictEqual(list[0].remaining, 1);
});

console.log(`\n${passed} launchpad tests passed`);
