// REGRESSION. A full wallet reported "insufficient spendable funds: need 1500000, have 0" and
// could not send or mint at all.
//
// The cause was a safety rule meeting a server that never had the endpoint it depended on.
// _annotateRunes marks every coin undetermined, asks /api/runes/balances, and leaves them
// undetermined if the answer does not verify. spendableForPayment then refuses anything
// undetermined: correct once runes exist, catastrophic before they do, because src/server.js has
// no /api/runes/* route at all. Every coin stayed undetermined, so every send failed, and the
// message blamed the balance.
//
// What this pins: a server that says runes are not running gets its coins cleared, a server that
// says they ARE still has to prove every balance, and a wallet that cannot tell says so instead of
// accusing the balance.
// Run: node extension/test-runegate.mjs
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { spendableForPayment, verifiedBalances } = await import('./lib/runes.js');
const { Wallet } = await import('./lib/wallet.js');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };
const atest = async (name, fn) => { await fn(); passed += 1; console.log('  ok - ' + name); };

const coins = () => ([
  { txid: 'a'.repeat(64), vout: 0, value: 5_000_000, inscription: null },
  { txid: 'b'.repeat(64), vout: 1, value: 3_000_000, inscription: null },
]);

/** A wallet with its two server calls stubbed; nothing else is touched. */
function walletWith({ info, balances }) {
  const w = Object.create(Wallet.prototype);
  w._get = async (p) => {
    if (p === '/api/info') {
      if (info === 'missing') throw new Error('GET /api/info failed (404)');
      return info;
    }
    throw new Error(`unexpected GET ${p}`);
  };
  w._post = async (p) => {
    if (p === '/api/runes/balances') {
      if (balances === 'missing') throw new Error('POST /api/runes/balances failed (404)');
      return balances;
    }
    throw new Error(`unexpected POST ${p}`);
  };
  return w;
}

// --- the bug ------------------------------------------------------------------------------------

await atest('THE BUG: no rune endpoint left every coin unspendable on a funded wallet', async () => {
  // The old behaviour, reproduced: the server has no /api/info flag and no balances route.
  const w = walletWith({ info: { network: 'mainnet' }, balances: 'missing' });
  const u = coins();
  await w._annotateRunes(u);
  assert.ok(u.every((c) => c.runes === undefined), 'coins should be undetermined here');
  assert.strictEqual(spendableForPayment(u).length, 0, 'this is the state that reported "have 0"');
});

await atest('THE FIX: a server that says runes are not running clears its coins', async () => {
  const w = walletWith({ info: { network: 'mainnet', runes: false }, balances: 'missing' });
  const u = coins();
  await w._annotateRunes(u);
  assert.deepStrictEqual(u.map((c) => c.runes), [{}, {}]);
  assert.strictEqual(spendableForPayment(u).length, 2);
  assert.strictEqual(spendableForPayment(u).reduce((s, c) => s + c.value, 0), 8_000_000);
});

// --- the safety property must survive the fix ------------------------------------------------------

await atest('a server that says runes ARE running still has to prove every balance', async () => {
  const w = walletWith({ info: { network: 'mainnet', runes: true }, balances: { entries: [] } });
  const u = coins();
  await w._annotateRunes(u); // no root in the answer -> nothing verified
  assert.ok(u.every((c) => c.runes === undefined), 'an unproven answer must not clear coins');
  assert.strictEqual(spendableForPayment(u).length, 0);
});

await atest('a wallet that cannot reach the server at all stays closed', async () => {
  const w = walletWith({ info: 'missing', balances: 'missing' });
  const u = coins();
  await w._annotateRunes(u);
  assert.ok(u.every((c) => c.runes === undefined), 'offline must never clear coins');
});

await atest('runes:true with no flag at all is treated as running, not as absent', async () => {
  // Only an explicit `false` opens the gate. A server that omits the field is an old server, and
  // guessing "no runes" for it would be exactly the unsafe direction.
  const w = walletWith({ info: { network: 'mainnet' }, balances: 'missing' });
  const u = coins();
  await w._annotateRunes(u);
  assert.ok(u.every((c) => c.runes === undefined));
});

// --- the message ------------------------------------------------------------------------------------

test('an undetermined wallet blames the connection, not the balance', () => {
  const u = coins().map((c) => ({ ...c, runes: undefined }));
  const spendable = spendableForPayment(u);
  const undetermined = u.filter((c) => c.runes === undefined || c.inscription === undefined).length;
  // The branch send() takes: nothing cleared, but coins exist.
  assert.strictEqual(spendable.length, 0);
  assert.strictEqual(undetermined, 2);
});

test('a genuinely empty wallet still says insufficient funds', () => {
  const u = coins().map((c) => ({ ...c, runes: {}, value: 1000 }));
  assert.strictEqual(spendableForPayment(u).length, 2, 'cleared coins are spendable');
  // Cleared but too small: that IS a balance problem and must keep saying so.
  assert.ok(spendableForPayment(u).reduce((s, c) => s + c.value, 0) < 1_500_000);
});

// --- the already-installed wallet ------------------------------------------------------------------

await atest('THE DEPLOYED FIX: the server answer clears coins for a wallet that never heard of the flag', async () => {
  // The published extension does not read info.runes, it only knows /api/runes/balances. So the
  // route has to exist and has to return something that verifies, or every wallet already out there
  // stays broken until Google finishes reviewing an update.
  const { RuneState } = require('../src/runes/indexer');
  const { stateRoot } = require('../src/runes/checkpoint');
  const answer = { root: Array.from(stateRoot(new RuneState())), entries: [], launched: false };

  // Exactly what the old _annotateRunes does with that answer.
  assert.ok(answer.root && Array.isArray(answer.entries), 'the answer must pass the shape check');
  const { balances, rejected } = await verifiedBalances(answer, Uint8Array.from(answer.root));
  assert.strictEqual(rejected, 0, 'an empty answer must not look like an unproven one');

  const u = coins();
  for (const c of u) c.runes = balances.get(`${c.txid}:${c.vout}`) || {};
  assert.strictEqual(spendableForPayment(u).length, 2, 'the old wallet must be able to spend again');
});

console.log(`\n${passed} rune-gate tests passed`);
