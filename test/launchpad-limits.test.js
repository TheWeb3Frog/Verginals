// The size contract, and the drift that made it a lie.
//
// Three numbers described the same rule in three places. The form promised 10,000 items at 60 KB
// each, the module allowed a 150 MB submission, and the arithmetic between them capped the real
// answer at 2,560: the advertised collection size was not reachable, and nothing anywhere noticed
// because no single file held both halves.
//
// So this file is mostly about agreement. One definition, derived where it can be derived, read by
// the page instead of repeated, and a control that fails on the numbers as they shipped.
//
// The side limit is here for a different reason: it did not exist at all. Bytes alone let a
// 10,000 by 10,000 image through as long as it compressed, and it draws as mush at every size.
//
// Run: node test/launchpad-limits.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Launchpad, LIMITS } = require('../src/launchpad');
const coinimage = require('../src/coinimage');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const WEB = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const lp = fs.readFileSync(path.join(__dirname, '..', 'src', 'launchpad.js'), 'utf8');

/** A structurally real PNG of a given size. Three bytes after a signature is not an image. */
function png(w = 64, h = 64, pad = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(pad)]);
}
const b64 = (b) => b.toString('base64');
const fresh = (over = {}) => new Launchpad(Object.assign(
  { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vlim-')) }, over));

test('the harness found every side of the contract, so an empty check is not a pass', () => {
  assert.ok(LIMITS && LIMITS.maxItems > 0);
  assert.ok(html.length > 20000 && app.length > 80000 && server.length > 100000);
});

// --- the numbers agree ------------------------------------------------------------------------------

test('THE SUBMISSION BUDGET IS DERIVED, NOT TYPED', () => {
  assert.strictEqual(LIMITS.maxDraftBytes, LIMITS.maxItems * LIMITS.maxImageBytes);
  assert.match(lp, /const MAX_DRAFT_BYTES = MAX_ITEMS \* MAX_IMAGE_BYTES;/,
    'written as the product, so the two can never disagree again');
});

test('A FULL COLLECTION AT THE CAP ACTUALLY FITS', () => {
  // The exact contradiction that shipped: the advertised item count was unreachable at the
  // advertised image size.
  const worst = LIMITS.maxItems * LIMITS.maxImageBytes;
  assert.ok(worst <= LIMITS.maxDraftBytes,
    `${LIMITS.maxItems} items at ${LIMITS.maxImageBytes} bytes needs ${worst} and the budget is ${LIMITS.maxDraftBytes}`);
});

test('CONTROL: the numbers as they shipped fail that check', () => {
  const before = { maxItems: 10000, maxImageBytes: 60 * 1024, maxDraftBytes: 150 * 1024 * 1024 };
  assert.ok(before.maxItems * before.maxImageBytes > before.maxDraftBytes,
    'the old trio really was impossible');
  assert.strictEqual(Math.floor(before.maxDraftBytes / before.maxImageBytes), 2560,
    'and the reachable count was 2,560, not the 10,000 on the form');
});

test('the cap clears every image that exists on the chain', () => {
  // Measured over 60 images sampled from 1,488 inscriptions: median 2.3 KB, p90 3.6 KB,
  // largest 14,622 bytes. Nothing already written may become unsubmittable.
  const LARGEST_ON_CHAIN = 14622;
  assert.ok(LIMITS.maxImageBytes > LARGEST_ON_CHAIN,
    'the cap must clear the largest image on the chain, with room');
  assert.ok(LIMITS.maxImageBytes < 32 * 1024, 'and still mean something');
});

// --- nobody repeats them ------------------------------------------------------------------------------

test('THE FORM STATES NO NUMBER OF ITS OWN', () => {
  const card = html.slice(html.indexOf('id="lp-submit-card"'), html.indexOf('id="lps-submit"'));
  assert.ok(card.length > 200, 'the submit card should still be there');
  assert.ok(!/\b60 KB\b/.test(card), 'the old byte cap is still written in the page');
  assert.ok(!/10,000 items/.test(card), 'the old item cap is still written in the page');
  assert.match(html, /id="lps-limits"/, 'and there is a slot the server fills');
});

test('and the client checks against the server, not against a copy', () => {
  const submit = app.slice(app.indexOf("$('#lps-submit').addEventListener"));
  assert.ok(!/60 \* 1024/.test(submit), 'a literal byte cap is back in the client');
  assert.ok(!/> 10000\b/.test(submit), 'a literal item cap is back in the client');
  assert.match(submit, /lim\.maxItems/);
  assert.match(submit, /lim\.maxImageBytes|fitImage\(f, lim\)/);
});

test('the server publishes the limits it enforces', () => {
  const fn = /function handleLaunchpadList\(res\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(fn, 'the list endpoint should exist');
  assert.match(fn[0], /limits: LAUNCHPAD_LIMITS/);
});

// --- the side limit -----------------------------------------------------------------------------------

test('AN IMAGE TOO BIG TO DRAW IS REFUSED, however well it compresses', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs' });
  assert.throws(() => l.addItem(id, { dataBase64: b64(png(10000, 10000)) }),
    new RegExp(`10000 by 10000 and the limit is ${LIMITS.maxImageSide}`));
  assert.ok(l.addItem(id, { dataBase64: b64(png(512, 512)) }), 'and an ordinary one goes in');
});

test('an image with no readable size is refused rather than stored', () => {
  const l = fresh();
  const { id } = l.createDraft({ name: 'Frogs' });
  // A signature and nothing else: what the fixtures used to be, and what passed every old check.
  const headless = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  assert.throws(() => l.addItem(id, { dataBase64: b64(headless) }), /no readable size/);
});

test('the side limit has ONE definition, shared with the coin pictures', () => {
  assert.strictEqual(LIMITS.maxImageSide, coinimage.MAX_SIDE);
  assert.match(lp, /const MAX_IMAGE_SIDE = coinimage\.MAX_SIDE;/);
});

// --- what one address may do ----------------------------------------------------------------------------

test('THREE FINALIZED SUBMISSIONS PER ADDRESS PER DAY', () => {
  const l = fresh();
  const A = 'D' + 'a'.repeat(33);
  for (let i = 0; i < LIMITS.perAddressPerDay; i++) {
    const { id } = l.createDraft({ name: 'C' + i, address: A });
    l.addItem(id, { dataBase64: b64(png()) });
    l.addItem(id, { dataBase64: b64(png()) }); // a collection is at least two
    l.finalize(id);
  }
  assert.strictEqual(l.recentFor(A), LIMITS.perAddressPerDay);
  assert.throws(() => l.createDraft({ name: 'One too many', address: A }), /which is the limit/);
  assert.ok(l.createDraft({ name: 'Someone else', address: 'D' + 'b'.repeat(33) }),
    'and it is per address, not a global gate');
});

test('the allowance is counted on FINALIZED work, not on false starts', () => {
  // Somebody who begins, gets it wrong and begins again has not asked for review twice, and must
  // not spend a day's allowance discovering the form.
  const l = fresh();
  const A = 'D' + 'c'.repeat(33);
  l.createDraft({ name: 'First try', address: A });
  assert.strictEqual(l.recentFor(A), 0, 'an unfinished draft costs no allowance');
});

test('but drafts WITH IMAGES have their own cap, because those cost disk', () => {
  // Only drafts holding something count: an empty one is a failed start and is cleared away rather
  // than held against its owner. See the failed-start test below.
  const l = fresh();
  const A = 'D' + 'd'.repeat(33);
  for (let i = 0; i < LIMITS.openDraftsPerAddress; i++) {
    const { id } = l.createDraft({ name: 'D' + i, address: A });
    l.addItem(id, { dataBase64: b64(png()) });
  }
  assert.throws(() => l.createDraft({ name: 'One too many', address: A }), /part way through/);
});

test('a day later the allowance is back', () => {
  const l = fresh();
  const A = 'D' + 'e'.repeat(33);
  const { id } = l.createDraft({ name: 'Old', address: A });
  l.addItem(id, { dataBase64: b64(png()) });
  l.addItem(id, { dataBase64: b64(png()) });
  l.finalize(id);
  const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
  assert.strictEqual(l.recentFor(A, 24 * 60 * 60 * 1000, tomorrow), 0);
});

test('THE ADDRESS IS PROVEN BEFORE IT IS COUNTED', () => {
  // A counter keyed on a string somebody typed resets every time they press backspace.
  const fn = /async function handleLaunchpadSubmit\(req, res\) \{[\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'the submit handler should exist');
  const verify = fn[0].indexOf('verifyMessage(');
  const create = fn[0].indexOf('launchpad.createDraft(');
  assert.ok(verify > 0, 'the signature must be checked');
  assert.ok(create > verify, 'and checked BEFORE a draft is opened');
  assert.match(fn[0], /submitAuth\.consumeChallenge/, 'the challenge is one-time');
  assert.match(server, /new GameAuth\(\{ prefix: 'verginals-launchpad-submit' \}\)/,
    'and its own prefix, so a coin-picture challenge is not spendable here');
  assert.match(fn[0], /allowQuote\(req\)/, 'the per-IP limit stays as the free first line');
});

// --- nothing may lock somebody out of their own launchpad ----------------------------------------
//
// Both of these happened to a real person on the live site. He opened the form twice, something
// failed before a single image was sent both times, and two empty drafts then stood between him and
// trying again for the seven days an unfinished draft lives. And a rejection, which is the operator
// asking somebody to come back, spent a day of their allowance on the way out.

test('A FAILED START CANNOT EVEN ACCUMULATE, let alone lock anybody out', () => {
  // Each new start clears this address's empty ones first, so however many times somebody's form
  // fails before an image is sent, exactly one open draft exists afterwards. Two of these on the
  // live site had stood between a real person and their own launchpad for a week.
  const l = fresh();
  const A = 'D' + 'f'.repeat(33);
  for (let i = 0; i < 6; i++) {
    assert.ok(l.createDraft({ name: 'Try ' + i, address: A }).id, 'start ' + i + ' should be allowed');
    assert.strictEqual(l.openDraftsFor(A), 1, 'and never more than the live one is left');
  }
});

test('but a draft with images in it is somebody work and is kept', () => {
  const l = fresh();
  const A = 'D' + 'g'.repeat(33);
  const { id } = l.createDraft({ name: 'Real', address: A });
  l.addItem(id, { dataBase64: b64(png()) });
  l.createDraft({ name: 'Second', address: A });
  assert.strictEqual(l.openDraftsFor(A), 2, 'the one with an image survives the next start');
  assert.ok(l._loadDraft(id), 'and is still readable');
});

test('and it only ever touches the asking address', () => {
  const l = fresh();
  const A = 'D' + 'h'.repeat(33);
  const B = 'D' + 'i'.repeat(33);
  l.createDraft({ name: 'Theirs', address: B });
  l.createDraft({ name: 'Mine', address: A });
  assert.strictEqual(l.dropEmptyDraftsFor(A), 1, 'one of mine');
  assert.strictEqual(l.openDraftsFor(B), 1, 'and none of theirs');
});

test('A REJECTION DOES NOT SPEND THE DAILY ALLOWANCE', () => {
  // The allowance protects review attention. A rejection means that attention was already spent
  // and the reviewer chose to invite a retry; charging for it locks out the one person doing
  // exactly what they were asked.
  const l = fresh();
  const A = 'D' + 'j'.repeat(33);
  const ids = [];
  for (let i = 0; i < LIMITS.perAddressPerDay; i++) {
    const { id } = l.createDraft({ name: 'C' + i, address: A });
    l.addItem(id, { dataBase64: b64(png()) });
    l.addItem(id, { dataBase64: b64(png()) });
    l.finalize(id);
    ids.push(id);
  }
  assert.strictEqual(l.recentFor(A), LIMITS.perAddressPerDay, 'the allowance is spent');
  assert.throws(() => l.createDraft({ name: 'Blocked', address: A }), /which is the limit/);

  l.reject(ids[0], 'come back with more items');
  assert.strictEqual(l.recentFor(A), LIMITS.perAddressPerDay - 1, 'and the rejection gives it back');
  assert.ok(l.createDraft({ name: 'Retry', address: A }), 'so the retry they were asked for works');
});

test('an approval still counts, because that attention was spent and kept', () => {
  const l = fresh();
  const A = 'D' + 'k'.repeat(33);
  const { id } = l.createDraft({ name: 'Good', address: A });
  l.addItem(id, { dataBase64: b64(png()) });
  l.addItem(id, { dataBase64: b64(png()) });
  l.finalize(id);
  l.approve(id, 'good-one');
  assert.strictEqual(l.recentFor(A), 1);
});

test('CONTROL: counting every finalized submission would still block the retry', () => {
  const l = fresh();
  const A = 'D' + 'm'.repeat(33);
  const { id } = l.createDraft({ name: 'One', address: A });
  l.addItem(id, { dataBase64: b64(png()) });
  l.addItem(id, { dataBase64: b64(png()) });
  l.finalize(id);
  l.reject(id, 'no');
  const naive = l.listSubmissions().filter((d) => d.address === A && d.finalizedAt).length;
  assert.strictEqual(naive, 1, 'the old rule saw one');
  assert.strictEqual(l.recentFor(A), 0, 'and the real one sees none');
});

console.log('\n' + passed + ' launchpad limit tests passed');
