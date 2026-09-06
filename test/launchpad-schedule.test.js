// When a collection can be minted, by whom, and how many times.
//
// Three gates, and the reason they are three and not one: "it has not opened", "you are not in the
// holders window" and "you already have three" are different things to a person, and one generic
// refusal for all of them is how a mint page makes somebody think it is broken.
//
// It is a SERVER rule, not a chain rule, and the unit is wall-clock time on purpose. A block height
// converted from an assumed thirty second target drifts by hours over a week, and nothing about
// this needs consensus: the server decides whether to hand out a mint.
//
// There is deliberately no deferred reveal. The art is inscribed as each item is minted, so anybody
// reading the chain sees it at once; hiding it on our own pages would be a curtain in front of a
// window that is already open. That is tested here too, because the absence is a decision.
//
// Run: node test/launchpad-schedule.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Launchpad, LIMITS } = require('../src/launchpad');
const { MintController } = require('../src/mint');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

function png() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(64, 8); ihdr.writeUInt32BE(64, 12);
  return Buffer.concat([sig, ihdr]);
}
const b64 = png().toString('base64');
const ADDR = 'DQd5bGpNkFc3wrdwhAhS6MkeWY5Vqb3opM';
const NOW = 1789000000000;
const S = (ms) => Math.floor(ms / 1000);
const fresh = () => new Launchpad({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vsched-')) });

function launch(over, slug = 'frogs', items = 3) {
  const l = fresh();
  const { id } = l.createDraft(Object.assign({ name: 'Frogs', address: ADDR }, over));
  for (let i = 0; i < items; i++) l.addItem(id, { dataBase64: b64 });
  l.finalize(id);
  l.approve(id, slug);
  return l;
}

test('the harness found both sides, so an empty check is not a pass', () => {
  assert.ok(LIMITS.maxPerWallet > 0 && LIMITS.scheduleAheadDays === 365);
  assert.ok(server.length > 100000 && html.length > 20000);
});

// --- the window --------------------------------------------------------------------------------------

test('NO SCHEDULE MEANS OPEN, which is what most collections want', () => {
  const l = launch({});
  assert.deepStrictEqual(l.gate('frogs', { now: NOW }), { ok: true });
});

test('before it opens it says WHEN, not just no', () => {
  const l = launch({ opensAt: S(NOW) + 3600 });
  const g = l.gate('frogs', { now: NOW });
  assert.strictEqual(g.ok, false);
  assert.match(g.why, /has not opened yet/);
  assert.strictEqual(g.opensAt, S(NOW) + 3600, 'a page can count down to this');
  assert.deepStrictEqual(l.gate('frogs', { now: NOW + 3600 * 1000 }), { ok: true }, 'and then it opens');
});

test('after it closes it stays closed', () => {
  const l = launch({ closesAt: S(NOW) - 1 });
  const g = l.gate('frogs', { now: NOW });
  assert.strictEqual(g.ok, false);
  assert.match(g.why, /has closed/);
});

test('a mint cannot be set to close before it opens', () => {
  const l = fresh();
  assert.throws(() => l.createDraft({ name: 'A', address: ADDR, opensAt: 200, closesAt: 100 }),
    /close before it opened/);
});

test('and a schedule cannot be set a decade out', () => {
  const l = fresh();
  const tooFar = Math.floor(Date.now() / 1000) + 400 * 24 * 3600;
  assert.throws(() => l.createDraft({ name: 'A', address: ADDR, opensAt: tooFar }), /more than a year away/);
});

// --- the holders window --------------------------------------------------------------------------------

test('THE ALPHA WINDOW LETS HOLDERS IN AND ASKS EVERYONE ELSE TO WAIT', () => {
  const l = launch({ allowlistUntil: S(NOW) + 3600 });
  const holder = l.gate('frogs', { now: NOW, holdsAlpha: () => true });
  assert.deepStrictEqual(holder, { ok: true });

  const stranger = l.gate('frogs', { now: NOW, holdsAlpha: () => false });
  assert.strictEqual(stranger.ok, false);
  assert.match(stranger.why, /hold an Alpha Verginal/);
  assert.strictEqual(stranger.opensAt, S(NOW) + 3600, 'and is told when their turn is');
});

test('and once the window is over it is over for everyone equally', () => {
  const l = launch({ allowlistUntil: S(NOW) - 1 });
  assert.deepStrictEqual(l.gate('frogs', { now: NOW, holdsAlpha: () => false }), { ok: true });
});

test('the holders check is not even asked outside the window', () => {
  const l = launch({});
  let asked = false;
  l.gate('frogs', { now: NOW, holdsAlpha: () => { asked = true; return false; } });
  assert.strictEqual(asked, false, 'a collection with no allowlist must not pay for the lookup');
});

// --- the per wallet cap ---------------------------------------------------------------------------------

test('A PER WALLET CAP COUNTS WHAT IS ALREADY HELD', () => {
  const l = launch({ maxPerWallet: 2 });
  assert.deepStrictEqual(l.gate('frogs', { now: NOW, held: 1 }), { ok: true });
  const full = l.gate('frogs', { now: NOW, held: 2 });
  assert.strictEqual(full.ok, false);
  assert.match(full.why, /may mint 2 from this collection/);
});

test('AND RESERVATIONS COUNT, or the cap is walked past by opening quotes in parallel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc-'));
  const l = launch({ maxPerWallet: 2 }, 'frogs', 3);
  const ctl = l.get('frogs').ctl;
  assert.strictEqual(ctl.heldBy(ADDR), 0);
  ctl.reserve('job-1', ADDR);
  assert.strictEqual(ctl.heldBy(ADDR), 1, 'a reservation counts before anything is paid');
  ctl.reserve('job-2', ADDR);
  assert.strictEqual(ctl.heldBy(ADDR), 2);
  assert.strictEqual(ctl.heldBy('D' + 'z'.repeat(33)), 0, 'and it is per address');
});

test('zero means no limit rather than no mints', () => {
  const l = launch({ maxPerWallet: 0 });
  assert.deepStrictEqual(l.gate('frogs', { now: NOW, held: 999 }), { ok: true });
});

// --- the wiring ---------------------------------------------------------------------------------------------

test('THE GATE RUNS BEFORE A NUMBER IS RESERVED', () => {
  // Reserving first and refusing after takes an item out of the pool on every attempt during a
  // closed window, and a collection nobody could mint would quietly sell out.
  const fn = /async function handleLaunchpadMint\([\s\S]*?\n\}\n/.exec(server);
  assert.ok(fn, 'the mint route should exist');
  const gate = fn[0].indexOf('launchpad.gate(');
  const reserve = fn[0].indexOf('c.ctl.reserve(');
  assert.ok(gate > 0 && reserve > gate, 'the gate must come first');
  assert.match(fn[0], /c\.ctl\.reserve\(jobId, to\)/, 'and the reservation records who it is for');
});

test('the Alpha holder set is never replaced by an empty one', () => {
  // During a rescan the index holds nothing, and an empty set would lock every holder out of their
  // own window without anybody touching a setting.
  const fn = /function sweepAlphaHolders\(\) \{[\s\S]*?\n\}/.exec(server);
  assert.ok(fn, 'the sweep should exist');
  assert.match(fn[0], /if \(held\.size \|\| !alphaHolders\.size\)/);
});

test('and it is computed on the sweep, not inside a mint request', () => {
  assert.match(server, /sweepAlphaHolders\(\);\n\s*await sweepHolders\(\)/);
  const fn = /async function handleLaunchpadMint\([\s\S]*?\n\}\n/.exec(server)[0];
  assert.match(fn, /alphaHolders\.has\(to\)/, 'the request only asks the set');
});

test('THERE IS NO DEFERRED REVEAL, and the form says why', () => {
  // The absence is a decision. The art is inscribed as each item is minted, so anybody reading the
  // chain sees it at once, and hiding it on our own pages would be theatre.
  assert.ok(!/reveal_at|revealAt|deferredReveal/.test(server), 'no reveal machinery may creep in');
  assert.match(html, /There is no hidden reveal/);
  assert.match(html, /curtain in front of an open window/);
});

test('the status endpoint publishes the schedule, so a page can say when', () => {
  const fn = /function handleLaunchpadStatus\(res, slug\) \{[\s\S]*?\n\}/.exec(server)[0];
  for (const f of ['opensAt', 'closesAt', 'allowlistUntil', 'maxPerWallet']) {
    assert.ok(fn.includes(f), 'missing ' + f);
  }
});

// --- one item is not a draw -----------------------------------------------------------------------

test('A SINGLE PIECE IS NOT SOLD AS A PROVABLY FAIR DRAW', () => {
  // A draw with one possible outcome is not a draw. Decided from the SUPPLY, so nothing has to be
  // declared at submission and no collection approved before this existed needs a field it was
  // never given.
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const fair = /\$\('#lp-fair'\)\.innerHTML = [\s\S]*?;\n/.exec(app);
  assert.ok(fair, 'the fairness line should exist');
  assert.match(fair[0], /s\.supply > 1/, 'it has to branch on how many there are');
  assert.match(fair[0], /A single piece\. There is nothing to draw/);
  assert.match(fair[0], /Provably fair/, 'and still say it for a real collection');
});

test('and the launch window is shown where somebody would look for it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.match(app, /Alpha holders only until/);
  assert.match(app, /per wallet`/);
  assert.match(app, /XVG to the creator/);
  assert.match(html, /id="lp-schedule"/, 'and there is somewhere to put it');
});

console.log('\n' + passed + ' launchpad schedule tests passed');
