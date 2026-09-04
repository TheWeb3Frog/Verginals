// Launchpad lifecycle: submission drafts, validation, curation, and live collection loading.
// Run: node test/launchpad.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Launchpad, sniffImage, ago, queueReport } = require('../src/launchpad');

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

// --- disk budgets --------------------------------------------------------------------------
test('a submission is capped by its own byte budget', () => {
  const lp = new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vlaunch-')), draftBytes: 15 });
  const { id } = lp.createDraft({ name: 'Frogs' });
  lp.addItem(id, { dataBase64: png64 }); // 11 bytes, fits
  assert.throws(() => lp.addItem(id, { dataBase64: png64 }), /total budget/);
});

test('the global launchpad budget refuses writes at capacity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlaunch-'));
  const a = new Launchpad({ dataDir: dir });
  const d1 = a.createDraft({ name: 'One' });
  a.addItem(d1.id, { dataBase64: png64 });
  // Reopen with a ceiling just above what is already on disk: the next image cannot fit.
  const b = new Launchpad({ dataDir: dir, budgetBytes: a.usageBytes() + 5 });
  const d2 = b.createDraft({ name: 'Two' });
  assert.throws(() => b.addItem(d2.id, { dataBase64: png64 }), /at capacity/);
});

test('usage is recounted after a rejection frees space', () => {
  const lp = new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vlaunch-')) });
  const bigPng = Buffer.concat([PNG, Buffer.alloc(2048)]); // big enough to dominate metadata noise
  const a = lp.createDraft({ name: 'One' });
  lp.addItem(a.id, { dataBase64: bigPng.toString('base64') });
  lp.finalize(a.id);
  const before = lp.usageBytes();
  lp.reject(a.id, 'no');
  assert.ok(lp.usageBytes() < before, 'usage shrank after images were dropped');
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

// --- the review queue, read from a terminal ------------------------------------------------
//
// A submission that nobody looks at is a submission that never happened, and there is no
// notification anywhere: the terminal is the only place the operator finds out. So the first
// line of the report has to answer the question on its own.

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 4, 12);
const sub = (over) => Object.assign(
  { id: 'a'.repeat(16), name: 'Frogs', status: 'pending', createdAt: NOW - DAY, items: [{}, {}] }, over);

test('an empty queue says so in the first line, not by printing nothing', () => {
  // Silence is ambiguous: it reads the same as a command that failed to reach the server.
  assert.strictEqual(queueReport([], NOW)[0], 'nothing waiting for review');
});

test('THE FIRST LINE COUNTS ONLY WHAT IS STILL WAITING', () => {
  const subs = [
    sub({ id: 'b'.repeat(16), status: 'draft' }),
    sub({ id: 'c'.repeat(16), status: 'approved' }),
    sub({ id: 'd'.repeat(16), status: 'rejected' }),
    sub({ id: 'e'.repeat(16), status: 'pending' }),
  ];
  assert.strictEqual(queueReport(subs, NOW)[0], '1 collection waiting for review');
  const two = queueReport(subs.concat(sub({ id: 'f'.repeat(16) })), NOW);
  assert.strictEqual(two[0], '2 collections waiting for review');
});

test('a waiting submission is listed with its id, age, size and who sent it', () => {
  const out = queueReport([sub({ finalizedAt: NOW - 3 * HOUR, creator: '@frogman' })], NOW).join('\n');
  assert.match(out, /a{16}/, 'the id is what every other command takes');
  assert.match(out, /3 hours ago/);
  assert.match(out, /2 items/);
  assert.match(queueReport([sub({ items: [{}] })], NOW).join('\n'), /1 item[^s]/, 'one item is not "1 items"');
  assert.match(out, /Frogs by @frogman/);
  assert.match(out, /approve <id> <slug>/, 'and it says what to do next');
});

test('age is measured from when it was SENT, not when it was started', () => {
  // A draft can sit half-finished for days before somebody finishes it. Dating the queue entry
  // from createdAt would make a fresh submission look neglected.
  const out = queueReport([sub({ createdAt: NOW - 6 * DAY, finalizedAt: NOW - 2 * HOUR })], NOW).join('\n');
  assert.match(out, /2 hours ago/);
  assert.doesNotMatch(out, /6 days ago/);
});

test('the ones already dealt with get one line, not a screen', () => {
  const subs = [sub({ status: 'approved' }), sub({ status: 'approved' }), sub({ status: 'rejected' })];
  const out = queueReport(subs, NOW);
  assert.strictEqual(out[0], 'nothing waiting for review');
  assert.ok(out.some((l) => l === 'also on file: 2 approved, 1 rejected'));
  assert.ok(out.length <= 4, 'the summary stays short');
});

test('ago() reads as a person would say it, singular and plural', () => {
  assert.strictEqual(ago(NOW - 30 * 1000, NOW), 'just now');
  assert.strictEqual(ago(NOW - 60 * 1000, NOW), '1 minute ago');
  assert.strictEqual(ago(NOW - 90 * 60 * 1000, NOW), '1 hour ago');
  assert.strictEqual(ago(NOW - 5 * HOUR, NOW), '5 hours ago');
  assert.strictEqual(ago(NOW - 8 * DAY, NOW), '8 days ago');
  assert.strictEqual(ago(NOW + 5000, NOW), 'just now', 'a clock skew must not print a negative age');
});

test('CONTROL: a report that ignored status would fail the count check', () => {
  const subs = [sub({ status: 'approved' }), sub({ status: 'pending' })];
  const wrong = `${subs.length} collections waiting for review`;
  assert.notStrictEqual(queueReport(subs, NOW)[0], wrong);
});

console.log(`\n${passed} launchpad tests passed`);
