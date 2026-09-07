// Verginals Arena auth: one-time challenges and HMAC session tokens. Hermetic (injected clock).
// Also exercises the full path end to end with a real wallet-style signature via src/message.js.
// Run: node test/gameauth.test.js
const assert = require('assert');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { GameAuth } = require('../src/gameauth');
const { magicHash, verifyMessage } = require('../src/message');
const { mainnet } = require('../src/networks');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok - ${name}`); }

function makeAuth(startAt = 1_000_000) {
  let t = startAt;
  let i = 0;
  const auth = new GameAuth({ secret: 'test-secret', now: () => t, nonce: () => `n${i++}` });
  return { auth, advance: (ms) => { t += ms; }, at: () => t };
}

// --- challenges ---
test('a challenge can be consumed once, with the exact signed string', () => {
  const { auth } = makeAuth();
  const { nonce, challenge, expiry } = auth.issueChallenge('Dabc');
  assert.strictEqual(challenge, `verginals-arena:Dabc:${nonce}:${expiry}`);
  assert.strictEqual(auth.consumeChallenge('Dabc', nonce), challenge);
});

test('a nonce cannot be replayed', () => {
  const { auth } = makeAuth();
  const { nonce } = auth.issueChallenge('Dabc');
  auth.consumeChallenge('Dabc', nonce);
  assert.throws(() => auth.consumeChallenge('Dabc', nonce), /already used/);
});

test('a challenge is bound to its address', () => {
  const { auth } = makeAuth();
  const { nonce } = auth.issueChallenge('Dabc');
  assert.throws(() => auth.consumeChallenge('Dxyz', nonce), /address mismatch/);
});

test('an expired challenge is rejected and pruned', () => {
  const { auth, advance } = makeAuth();
  const { nonce } = auth.issueChallenge('Dabc');
  advance(6 * 60 * 1000); // past the 5-minute TTL
  assert.throws(() => auth.consumeChallenge('Dabc', nonce), /unknown or expired/);
});

test('an unknown nonce is rejected', () => {
  const { auth } = makeAuth();
  assert.throws(() => auth.consumeChallenge('Dabc', 'nope'), /unknown or expired/);
});

// --- tokens ---
test('a fresh token verifies to its address', () => {
  const { auth } = makeAuth();
  const tok = auth.issueToken('Dabc');
  assert.strictEqual(auth.verifyToken(tok), 'Dabc');
});

test('a tampered token is rejected', () => {
  const { auth } = makeAuth();
  const tok = auth.issueToken('Dabc');
  assert.strictEqual(auth.verifyToken(tok + 'x'), null);
  assert.strictEqual(auth.verifyToken(tok.slice(0, -2)), null);
  assert.strictEqual(auth.verifyToken('garbage'), null);
  assert.strictEqual(auth.verifyToken(''), null);
});

test('a token from a different secret is rejected', () => {
  const { auth } = makeAuth();
  const tok = auth.issueToken('Dabc');
  const other = new GameAuth({ secret: 'different', now: auth.now });
  assert.strictEqual(other.verifyToken(tok), null);
});

test('an expired token is rejected', () => {
  const { auth, advance } = makeAuth();
  const tok = auth.issueToken('Dabc', 1000);
  advance(1001);
  assert.strictEqual(auth.verifyToken(tok), null);
});

// --- full path with a real signature ---
test('challenge -> wallet signature -> verify -> token authenticates the player', () => {
  const { auth } = makeAuth();
  // A player key + mainnet address.
  let priv; do { priv = crypto.randomBytes(32); } while (!ecc.isPrivate(priv));
  const pubkey = Buffer.from(ecc.pointFromScalar(priv, true));
  const address = bitcoin.payments.p2pkh({ pubkey, network: mainnet }).address;

  // 1. server issues a challenge; 2. wallet signs it; 3. server verifies + consumes; 4. token.
  const { nonce, challenge } = auth.issueChallenge(address);
  const h = magicHash(challenge);
  const { signature, recoveryId } = ecc.signRecoverable(h, priv);
  const sig = Buffer.concat([Buffer.from([27 + (recoveryId & 1) + 4]), Buffer.from(signature)]).toString('base64');

  const expected = auth.consumeChallenge(address, nonce);
  assert.strictEqual(verifyMessage(address, expected, sig, mainnet), true);
  const token = auth.issueToken(address);
  assert.strictEqual(auth.verifyToken(token), address);
});

// --- every handshake in the server calls a method that exists -----------------------------------
//
// A real submitter hit "submitAuth.newChallenge is not a function" on the launchpad. The method is
// issueChallenge; newChallenge never existed. Two handshakes had the wrong name, the launchpad one
// and the coin picture one, so the coin picture upload had never worked at all from the day it
// shipped.
//
// The tests around both of them asserted that "submitAuth.consumeChallenge" and
// "imageAuth.newChallenge" APPEARED IN THE SOURCE. A string appearing in a file is not a function
// existing, and that is the entire lesson: a structural check reads words, not code. This one asks
// the class.

const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

/** Every `<something>Auth.<method>(` the server calls, with where it is. */
function authCalls(src) {
  const out = [];
  for (const m of src.matchAll(/\b(\w*[Aa]uth)\.(\w+)\s*\(/g)) {
    if (m[1] === 'GameAuth') continue; // the class itself, not an instance
    out.push({ instance: m[1], method: m[2] });
  }
  return out;
}

test('the harness finds the calls, so an empty check is not a pass', () => {
  const calls = authCalls(server);
  assert.ok(calls.length >= 4, `only ${calls.length} handshake calls found`);
  const instances = new Set(calls.map((c) => c.instance));
  assert.ok(instances.size >= 3, 'the arena, the coin picture and the launchpad each have one');
});

test('EVERY METHOD THE SERVER CALLS ON A HANDSHAKE ACTUALLY EXISTS', () => {
  const missing = authCalls(server)
    .filter((c) => typeof GameAuth.prototype[c.method] !== 'function')
    .map((c) => `${c.instance}.${c.method}()`);
  assert.deepStrictEqual([...new Set(missing)], [],
    'these are called and are not methods of GameAuth:\n  ' + missing.join('\n  '));
});

test('CONTROL: the check really catches a name that does not exist', () => {
  const pretend = 'const x = submitAuth.newChallenge(address);';
  const missing = authCalls(pretend).filter((c) => typeof GameAuth.prototype[c.method] !== 'function');
  assert.strictEqual(missing.length, 1, 'the exact call that broke the launchpad must be caught');
  assert.strictEqual(missing[0].method, 'newChallenge');
});

test('and a challenge really can be issued and spent, once', () => {
  // The path itself, not a description of it.
  const { auth } = makeAuth();
  const { nonce, challenge } = auth.issueChallenge('Dabc');
  assert.ok(challenge.startsWith('verginals-arena:Dabc:'));
  assert.strictEqual(auth.consumeChallenge('Dabc', nonce), challenge);
  assert.throws(() => auth.consumeChallenge('Dabc', nonce), /used|unknown|expired/i);
});

console.log(`\n${passed} passed`);
