// Ticker allocation and its payment rule (RUNES-SPEC-v0 §7).
// The schedule is permanent once the first rune is etched, so these numbers are a contract.
// Run: node test/runes-tickers.test.js
const assert = require('assert');
const {
  priceOf, costOfHoarding, PRICE_LONG_XVG, LOCK_SECONDS, LOCK_GRACE_SECONDS,
  lockRedeemScript, p2shScriptPubKey, isLocked,
  normalizeSpacers, displayTicker, bareTicker, SPACER_CHAR,
} = require('../src/runes/tickers');

const COIN = 1e6;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok - ' + name); };

const NOW = 1700000000;
const KEY = Buffer.from('02' + '11'.repeat(32), 'hex');
const lockedOut = (value, locktime = NOW + LOCK_SECONDS, key = KEY) => ({
  value, scriptPubKey: p2shScriptPubKey(lockRedeemScript(locktime, key)), isOpReturn: false,
});
const elsewhere = (value) => ({ value, scriptPubKey: Buffer.from('76a914' + '22'.repeat(20) + '88ac', 'hex'), isOpReturn: false });

test('the published schedule is exactly what the spec promises', () => {
  const expected = { 3: 25000, 4: 10000, 5: 5000, 6: 2500, 8: 500, 10: 100 };
  for (const [len, xvg] of Object.entries(expected)) {
    assert.strictEqual(priceOf('A'.repeat(Number(len))) / COIN, xvg, len + ' characters');
  }
  assert.strictEqual(priceOf('A'.repeat(12)) / COIN, PRICE_LONG_XVG);
  assert.strictEqual(priceOf('A'.repeat(26)) / COIN, PRICE_LONG_XVG);
});

test('a shorter ticker never costs less than a longer one', () => {
  for (let len = 1; len < 26; len++) {
    assert.ok(priceOf('A'.repeat(len)) >= priceOf('A'.repeat(len + 1)), 'broke at ' + len);
  }
});

test('the price is what makes hoarding ruinous but one good name affordable', () => {
  // the point of the whole schedule, asserted rather than claimed
  assert.strictEqual(priceOf('FROG') / COIN, 10000);          // one real project
  assert.strictEqual(costOfHoarding(4, 50) / COIN, 500000);   // a squatter wanting fifty
});

test('case does not change the price', () => {
  assert.strictEqual(priceOf('frog'), priceOf('FROG'));
});

test('an impossible ticker is rejected rather than priced', () => {
  for (const bad of ['', 'has space', 'A'.repeat(27), 'lower-case!', null]) {
    assert.throws(() => priceOf(bad), JSON.stringify(bad));
  }
});

test('a lock the etcher can open is a P2SH wrapping a CLTV script', () => {
  const redeem = lockRedeemScript(NOW + LOCK_SECONDS, KEY);
  // <push locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <push 33-byte key> OP_CHECKSIG
  assert.strictEqual(redeem[redeem.length - 1], 0xac);
  assert.ok(redeem.includes(Buffer.from([0xb1, 0x75])), 'no CLTV then DROP');
  assert.ok(redeem.includes(KEY), 'the key is not in the script');
  const spk = p2shScriptPubKey(redeem);
  assert.strictEqual(spk.length, 23);
  assert.strictEqual(spk[0], 0xa9);
  assert.strictEqual(spk[spk.length - 1], 0x87);
});

test('a block height, or a key that is not a compressed point, cannot be a lock', () => {
  assert.throws(() => lockRedeemScript(800000, KEY), /timestamp/);          // below the threshold
  assert.throws(() => lockRedeemScript(NOW + LOCK_SECONDS, Buffer.alloc(33)), /compressed/);
  assert.throws(() => lockRedeemScript(NOW + LOCK_SECONDS, Buffer.alloc(32, 2)), /compressed/);
});

test('an etching that locks the full price is paid for', () => {
  const tx = { time: NOW, outputs: [elsewhere(100000), lockedOut(priceOf('FROG'))] };
  const r = isLocked(tx, 'FROG', { t: NOW + LOCK_SECONDS, k: KEY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.locked, priceOf('FROG'));
});

test('underpaying the lock by a single unit does not buy the ticker', () => {
  const tx = { time: NOW, outputs: [lockedOut(priceOf('FROG') - 1)] };
  assert.strictEqual(isLocked(tx, 'FROG', { t: NOW + LOCK_SECONDS, k: KEY }).ok, false);
});

test('paying the price anywhere else does not buy the ticker', () => {
  // the whole amount, to an ordinary address, with a perfectly good lock declared and never funded
  const tx = { time: NOW, outputs: [elsewhere(priceOf('FROG'))] };
  const r = isLocked(tx, 'FROG', { t: NOW + LOCK_SECONDS, k: KEY });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not locked/);
});

test('several outputs to the same lock add up', () => {
  const half = Math.floor(priceOf('MOON') / 2);
  const tx = { time: NOW, outputs: [lockedOut(half), lockedOut(priceOf('MOON') - half)] };
  assert.strictEqual(isLocked(tx, 'MOON', { t: NOW + LOCK_SECONDS, k: KEY }).ok, true);
});

test('overpaying the lock is fine, it is the etcher\'s own money', () => {
  const tx = { time: NOW, outputs: [lockedOut(priceOf('MOON') * 3)] };
  assert.strictEqual(isLocked(tx, 'MOON', { t: NOW + LOCK_SECONDS, k: KEY }).ok, true);
});

test('a lock that expires too soon is not a lock', () => {
  // the attack this rule exists for: declare a timestamp already past, pay yourself, reopen it in
  // the next block, and hold a ticker for the cost of a transaction fee
  const short = NOW + LOCK_SECONDS - LOCK_GRACE_SECONDS - 1;
  const tx = { time: NOW, outputs: [lockedOut(priceOf('FROG'), short)] };
  const r = isLocked(tx, 'FROG', { t: short, k: KEY });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /shorter than/);
});

test('the grace window absorbs the delay between signing and confirming', () => {
  // an etcher computes the lock when they sign; the block that carries it is always later
  const signedEarlier = NOW - LOCK_GRACE_SECONDS + 60 + LOCK_SECONDS;
  const tx = { time: NOW, outputs: [lockedOut(priceOf('FROG'), signedEarlier)] };
  assert.strictEqual(isLocked(tx, 'FROG', { t: signedEarlier, k: KEY }).ok, true);
});

test('paying a lock the etching did not declare buys nothing', () => {
  // the output is funded, but `l` names a different key, so the script the indexer rebuilds is not
  // the one that got paid
  const other = Buffer.from('03' + '33'.repeat(32), 'hex');
  const tx = { time: NOW, outputs: [lockedOut(priceOf('FROG'))] };
  assert.strictEqual(isLocked(tx, 'FROG', { t: NOW + LOCK_SECONDS, k: other }).ok, false);
});

test('an etching with no lock at all is refused', () => {
  const tx = { time: NOW, outputs: [lockedOut(priceOf('FROG'))] };
  for (const bad of [null, undefined, {}, { t: NOW + LOCK_SECONDS }, { k: KEY }]) {
    const r = isLocked(tx, 'FROG', bad);
    assert.strictEqual(r.ok, false, JSON.stringify(bad));
  }
});

test('with no block time there is nothing to measure the lock against, so it fails', () => {
  const tx = { outputs: [lockedOut(priceOf('FROG'))] };
  const r = isLocked(tx, 'FROG', { t: NOW + LOCK_SECONDS, k: KEY });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /block time/);
});

test('the lock lasts the 1460 days the spec promises', () => {
  assert.strictEqual(LOCK_SECONDS, 1460 * 24 * 3600);
});

test('a long ticker is nearly free, so honest naming is never blocked', () => {
  assert.strictEqual(priceOf('MYHONESTPROJECTNAME') / COIN, 10);
});

// --- display spacers (§7.1) --------------------------------------------------------------------

test('a mask renders the separators the etching asked for', () => {
  // DOGGOTOTHEMOON with a separator after characters 2, 4, 6 and 9.
  const mask = (1 << 2) | (1 << 4) | (1 << 6) | (1 << 9);
  assert.strictEqual(displayTicker('DOGGOTOTHEMOON', mask), 'DOG\u2022GO\u2022TO\u2022THE\u2022MOON');
});

test('SPACING IS NOT IDENTITY: a spaced name and its bare name are the same rune', () => {
  // The whole anti-squatting argument rests on this. If re-spacing made a new name, every good
  // ticker could be taken a dozen times over and the length price would mean nothing.
  const a = displayTicker('DOGGOTOTHEMOON', (1 << 2) | (1 << 4));
  const b = displayTicker('DOGGOTOTHEMOON', (1 << 4) | (1 << 8));
  assert.notStrictEqual(a, b, 'they render differently');
  assert.strictEqual(bareTicker(a), bareTicker(b), 'and they are the same rune');
  assert.strictEqual(bareTicker(a), 'DOGGOTOTHEMOON');
});

test('a separator buys no namespace, so it costs nothing', () => {
  const spaced = displayTicker('GRUMPY', (1 << 1) | (1 << 3));
  assert.strictEqual(priceOf(bareTicker(spaced)), priceOf('GRUMPY'));
  assert.strictEqual(bareTicker(spaced).length, 6, 'price follows the bare length, not the rendered one');
});

test('a bit past the end is ignored, never fatal', () => {
  // Rejecting would mean a wallet that sets one bit too many destroys the etching, and the etcher
  // loses the ticker price over where a bullet is drawn. Bitcoin's Runes ignores them too.
  assert.strictEqual(normalizeSpacers('DOG', 1 << 2), 0, 'bit 2 of a 3-char name is trailing');
  assert.strictEqual(normalizeSpacers('DOG', 1 << 5), 0, 'past the end of the name');
  assert.strictEqual(displayTicker('DOG', 1 << 2), 'DOG', 'renders as if the bit were not there');
  assert.strictEqual(normalizeSpacers('DOG', 1 << 0), 1, 'after the first character is meaningful');
});

test('ADJACENT bits are legal: they render single-letter segments', () => {
  // Bit i and bit i+1 are separators in two neighbouring gaps, not two separators in one gap. There
  // is no way to express the latter, so there is nothing to forbid. An earlier version rejected
  // this and would have refused names like R.S.I.C.
  assert.strictEqual(displayTicker('ABC', 0b11), 'A\u2022B\u2022C');
  assert.strictEqual(normalizeSpacers('ABC', 0b11), 0b11);
  assert.strictEqual(bareTicker(displayTicker('ABC', 0b11)), 'ABC');
});

test('normalising keeps the meaningful bits and drops only the impossible ones', () => {
  // Two real positions plus one past the end: the real ones survive.
  const mask = (1 << 0) | (1 << 1) | (1 << 9);
  assert.strictEqual(normalizeSpacers('ABC', mask), 0b11);
  assert.strictEqual(displayTicker('ABC', mask), 'A\u2022B\u2022C');
});

test('no mask means no separator, and the bare name round-trips', () => {
  assert.strictEqual(displayTicker('WRAITH', 0), 'WRAITH');
  assert.strictEqual(bareTicker('WRAITH'), 'WRAITH');
  assert.ok(!displayTicker('WRAITH', 0).includes(SPACER_CHAR));
});

console.log('\nrunes tickers: ' + passed + ' passed');
