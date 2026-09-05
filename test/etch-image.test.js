// Asking for a coin's picture at the moment somebody is naming it.
//
// The upload endpoint already existed, on the coin's own page, and almost nobody went back to it:
// a market of unnamed grey squares is what you get when the only place to add a picture is a page
// people visit once. So the ask moved to the etch form.
//
// That creates one hard ordering problem and one soft promise, and this file is about both.
//
//   THE COIN HAS TO EXIST FIRST. The endpoint checks that the wallet asking is the one the chain
//   says etched the coin, and until a miner has placed the etching there is no such fact to check
//   against. The file is held in the page and attached at the end.
//
//   AND IT HAS TO STAY OPTIONAL. Nothing about the etching may wait on it, fail because of it, or
//   be reordered around it. Somebody spending five thousand XVG on a permanent name must not lose
//   the thing that matters because a picture upload was slow.
//
// Run: node test/etch-image.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const WEB = path.join(__dirname, '..', 'web');
const js = fs.readFileSync(path.join(WEB, 'etch.js'), 'utf8');
const html = fs.readFileSync(path.join(WEB, 'etch.html'), 'utf8');
const coinimage = require('../src/coinimage');

test('the harness found the page, so an empty check is not a pass', () => {
  assert.ok(js.length > 20000);
  assert.match(js, /function attachPicture\(/);
  assert.match(js, /function wirePicture\(/);
});

// --- the field ---------------------------------------------------------------------------------------

test('the form offers a picture, and says it is optional', () => {
  assert.match(html, /id="et-image"/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  const label = /<label class="et-label" for="et-image">([\s\S]*?)<\/label>/.exec(html);
  assert.ok(label, 'the picture field should carry a label');
  assert.match(label[1], /optional/i, 'and the label itself has to say so');
});

test('the picker is actually wired at boot, not just defined', () => {
  assert.match(js, /^wirePicture\(\);$/m);
});

// --- the ordering that cannot be got wrong -------------------------------------------------------------

test('THE UPLOAD ONLY HAPPENS ONCE THE COIN EXISTS', () => {
  // Attaching earlier cannot work: the server has nobody to check the signature against yet.
  const start = js.indexOf('if (s.runeRef) {');
  const call = js.indexOf('attachPicture(s.runeRef, host)');
  assert.ok(start > 0, 'the success branch should still exist');
  assert.ok(call > start, 'attachPicture must sit inside the branch that has a rune id');
});

test('AND IT IS NOT AWAITED, so a slow upload cannot delay the way back to the deposit', () => {
  // The release below it is the irreplaceable part of the flow. A picture must never sit in front
  // of it, however slow the wallet or the network is being.
  const call = /(\S+\s*)attachPicture\(s\.runeRef, host\);/.exec(js);
  assert.ok(call, 'the call should exist');
  assert.ok(!/await\s*$/.test(call[1]), 'attachPicture is awaited, which puts it in front of the release');
  const attach = js.indexOf('attachPicture(s.runeRef, host)');
  const release = js.indexOf('Writing down the way back to your deposit');
  assert.ok(release > attach, 'and the release still follows it');
});

test('a failure says so and stops, rather than taking the etching with it', () => {
  const fn = /async function attachPicture\([\s\S]*?\n\}\n/.exec(js)[0];
  assert.match(fn, /catch \(e\)/, 'every failure is caught inside the function');
  assert.match(fn, /Nothing else was affected/, 'and the page says so plainly');
  assert.match(fn, /coin\\?'s own page/, 'and points at the other place it can be done');
});

test('it waits out an index that has not caught up, but not a real refusal', () => {
  const fn = /async function attachPicture\([\s\S]*?\n\}\n/.exec(js)[0];
  assert.match(fn, /no such coin\|cannot be set yet\|index/,
    'the retryable refusals are the ones about the coin not being visible yet');
  assert.match(fn, /attempt < 8/, 'and the retrying is bounded');
  assert.match(fn, /if \(!waiting \|\| attempt === 7\)/,
    'anything else gives up at once instead of hammering the endpoint');
});

test('no wallet is a plain sentence, not a crash', () => {
  const fn = /async function attachPicture\([\s\S]*?\n\}\n/.exec(js)[0];
  assert.match(fn, /if \(!address \|\| typeof w\.signMessage !== 'function'\)/);
  assert.match(fn, /needs a connected wallet/);
});

// --- the promise that it changes nothing else ------------------------------------------------------------

test('THE ETCHING PAYLOAD DOES NOT CARRY THE PICTURE', () => {
  // The strongest form of "optional": the picture is not part of what gets signed, quoted or
  // written, so a coin etched without one is byte for byte the coin it would always have been.
  const compose = js.slice(js.indexOf('async function startEtch'), js.indexOf('for (let i = 0; i < 3600'));
  assert.ok(!/picked/.test(compose), 'the held picture leaks into the etch request');
  const body = /body: JSON\.stringify\(payload\)/.test(js);
  assert.ok(body, 'the etch request still sends the plain payload');
});

// --- the two caps have to be the same number ---------------------------------------------------------------

test('THE CLIENT CAP IS THE SERVER CAP, or somebody is refused after paying', () => {
  // A client that allows more than the server accepts means the refusal lands after the coin has
  // been etched, which is the worst possible moment to learn about a size limit.
  const m = /const MAX_IMAGE_BYTES = (\d+) \* 1024;/.exec(js);
  assert.ok(m, 'the client should state its own cap');
  assert.strictEqual(Number(m[1]) * 1024, coinimage.MAX_BYTES,
    'web/etch.js and src/coinimage.js disagree about the maximum size');
  assert.match(html, new RegExp('up to ' + (coinimage.MAX_BYTES / 1024) + ' KB'),
    'and the sentence under the field quotes the same number');
});

test('CONTROL: a cap that drifted would fail the check above', () => {
  assert.notStrictEqual(90 * 1024, coinimage.MAX_BYTES);
});

test('the formats offered are the formats the server accepts, SVG excluded', () => {
  const offered = /accept="([^"]+)"/.exec(html)[1].split(',').map((t) => t.trim());
  const accepted = coinimage.TYPES.map((t) => t.mime);
  assert.deepStrictEqual(offered.slice().sort(), accepted.slice().sort(),
    'the file picker offers a different set from the one the server will store');
  assert.ok(!offered.some((t) => /svg/i.test(t)), 'SVG must never be offered: it is scriptable');
});

console.log('\n' + passed + ' etch image tests passed');
