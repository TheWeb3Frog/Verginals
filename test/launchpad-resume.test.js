// Coming back to an upload that was interrupted.
//
// A draft lives on the server for a week and the person who started it had no way to know. Closing a
// tab at image 1,500 of 3,000 meant beginning again from zero, and a start that failed before any
// image was sent left an empty draft that then blocked the next attempt.
//
// The worry that prompted this was that closing the page stops the conversion. It does not: the
// conversion is one image at a time, inline, milliseconds each. What closing the page stops is the
// UPLOAD, and moving the conversion to the server would make that worse rather than better, because
// the browser would then send the 2 MB originals instead of the 6 KB WEBPs it sends now. Measured
// against real numbers: 5.86 GB up instead of 0.02 GB, which is 2.8 hours connected instead of 30
// seconds. So the cure is resuming, not relocating.
//
// Run: node test/launchpad-resume.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const WEB = path.join(__dirname, '..', 'web');
const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const submit = app.slice(app.indexOf("$('#lps-submit').addEventListener"));

test('the harness found the flow, so an empty check is not a pass', () => {
  assert.ok(submit.length > 2000, 'the submit handler should be the real one');
  assert.match(app, /function lpsCheckResume\(\)/);
});

// --- remembering ------------------------------------------------------------------------------------

test('THE DRAFT IS REMEMBERED BEFORE A SINGLE IMAGE GOES UP', () => {
  // The whole point is surviving the tab closing during the upload, so nothing may be written
  // after it.
  const create = submit.indexOf("draft = await api('/api/launchpad/submit'");
  const remember = submit.indexOf('lpsRemember({ id: draft.id');
  const firstUpload = submit.indexOf("/brand'");
  assert.ok(create > 0 && remember > create, 'remembered once it exists');
  assert.ok(remember < firstUpload, 'and before anything is sent');
});

test('and kept current as it goes, not left at where it started', () => {
  const loop = submit.slice(submit.indexOf('let sent = from;'));
  const progress = loop.indexOf('uploading ');
  const remember = loop.indexOf('lpsRemember(');
  assert.ok(progress > 0, 'the loop should report progress');
  assert.ok(remember > progress, 'and write the memory right after it, every batch');
  assert.ok(remember - progress < 400, 'in the same step, not somewhere else entirely');
});

test('a private window does not break the form', () => {
  // localStorage throws outright in some browsers rather than coming back empty.
  assert.match(app, /try \{ localStorage\.setItem\(LPS_STORE[\s\S]*?catch \(_\)/);
  assert.match(app, /try \{ return JSON\.parse\(localStorage\.getItem\(LPS_STORE\)[\s\S]*?catch \(_\) \{ return null; \}/);
});

// --- coming back ---------------------------------------------------------------------------------------

test('THE SERVER SAYS HOW FAR IT GOT, not the browser', () => {
  // The browser's count is what it believed when it died. The server's is what actually arrived.
  const fn = /async function lpsCheckResume\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(fn, /api\('\/api\/launchpad\/submit\/' \+ saved\.id\)/);
  assert.match(fn, /d\.items/, 'and the count it shows is the server\'s');
  assert.match(fn, /if \(d\.status !== 'draft'\) return lpsForget\(\)/,
    'a submission already sent or decided is not something to come back to');
});

test('and a draft that has been pruned is forgotten rather than offered', () => {
  const fn = /async function lpsCheckResume\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(fn, /catch \(_\) \{ return lpsForget\(\); \}/);
});

test('RESUMING SKIPS WHAT IS THERE, it does not send it twice', () => {
  // The file order sets the item numbers, so resending would not repeat the collection, it would
  // make a different and longer one.
  assert.match(submit, /let sent = from;/);
  assert.match(submit, /for \(let i = from; i < lpsFileList\.length; i \+= 50\)/);
  assert.match(submit, /from = d\.items;/);
});

test('the identity images are not sent again on a resume', () => {
  const brand = submit.slice(submit.indexOf("for (const kind of ['avatar', 'banner'])"));
  const closes = submit.slice(0, submit.indexOf("for (const kind of ['avatar', 'banner'])"));
  assert.match(closes, /if \(!draft\) \{/, 'the first-attempt block has to open before them');
  assert.ok(brand.indexOf('    }\n\n    // Everything before `from`') > 0
    || /\n    \}\n/.test(brand.slice(0, 900)), 'and close after them');
});

test('a folder with fewer files than the server holds is refused, in words', () => {
  assert.match(submit, /The server already has \$\{fmt\(from\)\} images and you picked/);
  assert.match(submit, /Pick the same folder you started with, or press Start over/);
});

test('and finishing clears it, because there is nothing left to come back to', () => {
  assert.match(submit, /lpsForget\(\); \/\/ it is in the queue now/);
});

// --- the way out -------------------------------------------------------------------------------------------

test('THE OFFER IS VISIBLE AND REFUSABLE', () => {
  assert.match(html, /id="lps-resume"/);
  assert.match(html, /id="lps-resume-go"/);
  assert.match(html, /id="lps-resume-drop"/);
  assert.match(app, /\$\('#lps-resume-drop'\)\.addEventListener\('click', \(\) => \{[\s\S]*?lpsForget\(\)/,
    'somebody who wants to start over must be able to');
});

test('and the button opens the folder chooser, because a page cannot open one alone', () => {
  assert.match(app, /\$\('#lps-resume-go'\)\.addEventListener\('click', \(\) => \$\('#lps-files'\)\.click\(\)\)/);
});

test('the status route it leans on answers about a draft', () => {
  const fn = /function handleLaunchpadSubmitStatus\(res, id\) \{[\s\S]*?\n\}/.exec(server)[0];
  assert.match(fn, /items: \(d\.items \|\| \[\]\)\.length/);
  assert.match(fn, /status: d\.status/);
});

console.log('\n' + passed + ' launchpad resume tests passed');
