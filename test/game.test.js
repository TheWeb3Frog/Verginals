// Verginals Arena combat engine: determinism, elemental rules, poison/potion, trait modifiers,
// charge validation, seeds, and Elo. All hermetic (no DB, no chain, no wallet).
// Run: node test/game.test.js
const assert = require('assert');
const {
  ELEMENTS, BEATS,
  serverSeedHash, combineSeed, beaconSeed, rngFromSeed,
  deriveFighter, resolveMatch, updateElo, SCHEMA, BADGE_DEFS,
} = require('../src/game');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// A plain fighter (no traits) unless a test overrides fields.
const plain = (address, over = {}) => ({ address, house: null, rarityScore: 0, comeback: false, shield: false, ...over });

// Helper: three rounds of fixed elements, no charges.
const rounds = (e1p1, e1p2, e2p1, e2p2, e3p1, e3p2) => ([
  { p1: { element: e1p1 }, p2: { element: e1p2 } },
  { p1: { element: e2p1 }, p2: { element: e2p2 } },
  { p1: { element: e3p1 }, p2: { element: e3p2 } },
]);

const SEED = 'a'.repeat(64);

// --- elemental cycle ---
test('elemental cycle: fire>earth>water>fire', () => {
  assert.strictEqual(BEATS.fire, 'earth');
  assert.strictEqual(BEATS.earth, 'water');
  assert.strictEqual(BEATS.water, 'fire');
});

test('a fighter who wins every element round wins the match', () => {
  // p1 plays fire/earth/water, p2 plays earth/water/fire -> p1 beats each round.
  const r = resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: rounds('fire', 'earth', 'earth', 'water', 'water', 'fire'), seed: SEED });
  assert.strictEqual(r.winner, 'P1');
  assert.deepStrictEqual(r.score, [3, 0]);
  assert.ok(r.rounds.every((x) => x.reason === 'element'));
});

// --- determinism ---
test('same inputs give the same result', () => {
  const args = { p1: plain('P1'), p2: plain('P2'), moves: rounds('fire', 'fire', 'water', 'water', 'earth', 'earth'), seed: SEED };
  const a = resolveMatch(args);
  const b = resolveMatch(args);
  assert.deepStrictEqual(a.rounds, b.rounds);
  assert.strictEqual(a.winner, b.winner);
});

test('an all-tie match is decided purely by the seed, and the seed can flip it', () => {
  const mv = rounds('fire', 'fire', 'water', 'water', 'earth', 'earth'); // every round a mirror tie
  const winners = new Set();
  for (const s of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)]) {
    winners.add(resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: s }).winner);
  }
  assert.deepStrictEqual([...winners].sort(), ['P1', 'P2']); // both outcomes occur across seeds
});

// --- poison / potion ---
test('poison wins a round outright when unanswered', () => {
  const mv = [
    { p1: { element: 'fire', poison: true }, p2: { element: 'fire' } }, // tie element, poison decides
    { p1: { element: 'water' }, p2: { element: 'water' } },
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
  ];
  const r = resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: SEED });
  assert.strictEqual(r.rounds[0].winner, 'p1');
  assert.strictEqual(r.rounds[0].reason, 'poison');
});

test('potion is an antidote: it cancels the opponent poison that round', () => {
  const mv = [
    { p1: { element: 'water', poison: true }, p2: { element: 'water', potion: true } }, // poison negated -> tie
    { p1: { element: 'fire' }, p2: { element: 'fire' } },
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
  ];
  const r = resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: SEED });
  assert.notStrictEqual(r.rounds[0].reason, 'poison'); // fell through to the tie path
});

test('both poisoning cancels and the round falls back to the element compare', () => {
  const mv = [
    { p1: { element: 'fire', poison: true }, p2: { element: 'earth', poison: true } }, // fire beats earth
    { p1: { element: 'water' }, p2: { element: 'water' } },
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
  ];
  const r = resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: SEED });
  assert.strictEqual(r.rounds[0].winner, 'p1');
  assert.strictEqual(r.rounds[0].reason, 'element');
});

// --- house affinity (deterministic tie-break, no rng) ---
test('House affinity wins a same-element tie for the matching House', () => {
  const p1 = plain('P1', { house: 'fire' });
  const p2 = plain('P2', { house: 'water' });
  const mv = rounds('fire', 'fire', 'water', 'water', 'earth', 'earth');
  // Round 1 is a fire mirror: p1 (House Fire) should take it by affinity regardless of seed.
  for (const s of ['a'.repeat(64), 'f'.repeat(64), '1'.repeat(64)]) {
    const r = resolveMatch({ p1, p2, moves: mv, seed: s });
    assert.strictEqual(r.rounds[0].winner, 'p1');
    assert.strictEqual(r.rounds[0].reason, 'house');
  }
});

test('houseAffinity off falls back to the coin flip', () => {
  const p1 = plain('P1', { house: 'fire' });
  const p2 = plain('P2', { house: 'water' });
  const mv = rounds('fire', 'fire', 'water', 'water', 'earth', 'earth');
  const r = resolveMatch({ p1, p2, moves: mv, seed: SEED, config: { traits: { houseAffinity: false } } });
  assert.strictEqual(r.rounds[0].reason, 'flip');
});

// --- comeback face ---
test('a comeback face steals round 3 after losing round 1', () => {
  // p1 loses round 1 on element, round 2 mirror, round 3 mirror -> comeback should hand p1 round 3.
  const p1 = plain('P1', { comeback: true });
  const p2 = plain('P2');
  const mv = rounds('earth', 'fire', 'water', 'water', 'fire', 'fire'); // r1: fire beats earth (p2), r3: fire mirror
  const r = resolveMatch({ p1, p2, moves: mv, seed: SEED });
  assert.strictEqual(r.rounds[0].winner, 'p2');
  assert.strictEqual(r.rounds[2].winner, 'p1');
  assert.strictEqual(r.rounds[2].reason, 'comeback');
});

// --- shield ---
test('a shield turns a losing round into a tie (cannot be lost outright)', () => {
  const p1 = plain('P1', { shield: true });
  const p2 = plain('P2');
  const mv = [
    { p1: { element: 'water', shield: true }, p2: { element: 'earth' } }, // earth beats water, shield saves p1
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
    { p1: { element: 'fire' }, p2: { element: 'fire' } },
  ];
  const r = resolveMatch({ p1, p2, moves: mv, seed: SEED });
  assert.notStrictEqual(r.rounds[0].reason, 'element'); // was rescued into the tie path
});

// --- rarity nudge (statistical) ---
test('rarity nudge biases the coin flip toward the higher score', () => {
  const p1 = plain('P1', { rarityScore: 900 });
  const p2 = plain('P2', { rarityScore: 100 });
  const mv = rounds('fire', 'fire', 'water', 'water', 'earth', 'earth'); // all ties -> all coin flips
  let p1wins = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const r = resolveMatch({ p1, p2, moves: mv, seed: (i.toString(16).padStart(64, '0')) });
    if (r.winner === 'P1') p1wins++;
  }
  assert.ok(p1wins > N * 0.55, `expected the rarer fighter to win >55%, got ${p1wins}/${N}`);
});

test('pure-skill config (all traits off) is an unbiased flip on ties', () => {
  const p1 = plain('P1', { house: 'fire', rarityScore: 999, comeback: true });
  const p2 = plain('P2', { house: 'water', rarityScore: 1 });
  const mv = rounds('fire', 'fire', 'water', 'water', 'earth', 'earth');
  const cfg = { traits: { houseAffinity: false, faceComeback: false, rarityNudge: false, runeShield: false } };
  let p1wins = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const r = resolveMatch({ p1, p2, moves: mv, seed: (i.toString(16).padStart(64, '0')), config: cfg });
    if (r.winner === 'P1') p1wins++;
  }
  assert.ok(p1wins > N * 0.4 && p1wins < N * 0.6, `expected ~50/50, got ${p1wins}/${N}`);
});

// --- validation ---
test('rejects an illegal element', () => {
  const mv = [{ p1: { element: 'lightning' }, p2: { element: 'fire' } }, { p1: { element: 'fire' }, p2: { element: 'fire' } }, { p1: { element: 'fire' }, p2: { element: 'fire' } }];
  assert.throws(() => resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: SEED }), /must play one of/);
});

test('rejects too many poison charges', () => {
  const mv = [
    { p1: { element: 'fire', poison: true }, p2: { element: 'fire' } },
    { p1: { element: 'water', poison: true }, p2: { element: 'water' } }, // 2nd poison, default max 1
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
  ];
  assert.throws(() => resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: mv, seed: SEED }), /poison/);
});

test('rejects a shield from a fighter without the rare RUNE', () => {
  const mv = [
    { p1: { element: 'fire', shield: true }, p2: { element: 'fire' } },
    { p1: { element: 'water' }, p2: { element: 'water' } },
    { p1: { element: 'earth' }, p2: { element: 'earth' } },
  ];
  assert.throws(() => resolveMatch({ p1: plain('P1', { shield: false }), p2: plain('P2'), moves: mv, seed: SEED }), /shield/);
});

test('rejects the wrong number of rounds', () => {
  assert.throws(() => resolveMatch({ p1: plain('P1'), p2: plain('P2'), moves: [{ p1: { element: 'fire' }, p2: { element: 'fire' } }], seed: SEED }), /expected 3 rounds/);
});

// --- deriveFighter ---
test('deriveFighter reads House, comeback face, and rare-RUNE shield from traits', () => {
  const item = { attributes: [
    { trait_type: 'HOUSE', value: 'Earth' },
    { trait_type: 'FACE', value: 'Crying' },
    { trait_type: 'RUNE', value: 'Stone White' },
  ] };
  const f = deriveFighter(item, { rarityScore: 178.31, runePct: 1.29 });
  assert.strictEqual(f.house, 'earth');
  assert.strictEqual(f.comeback, true);
  assert.strictEqual(f.shield, true); // 1.29% <= 5% default rare threshold
  assert.strictEqual(f.rarityScore, 178.31);
});

test('deriveFighter: common rune gives no shield, non-elemental House is null', () => {
  const item = { attributes: [{ trait_type: 'House', value: 'Gold' }, { trait_type: 'Rune', value: 'Plain' }] };
  const f = deriveFighter(item, { runePct: 50 });
  assert.strictEqual(f.house, null);
  assert.strictEqual(f.shield, false);
});

// --- seeds ---
test('serverSeedHash is sha256 and combineSeed is deterministic', () => {
  const crypto = require('crypto');
  const s = 'secret-seed';
  assert.strictEqual(serverSeedHash(s), crypto.createHash('sha256').update(s).digest('hex'));
  assert.strictEqual(combineSeed('s', 'c', 'm'), combineSeed('s', 'c', 'm'));
  assert.notStrictEqual(combineSeed('s', 'c', 'm1'), combineSeed('s', 'c', 'm2'));
  assert.notStrictEqual(beaconSeed('hash', 't', 'm1'), beaconSeed('hash', 't', 'm2'));
});

test('rngFromSeed is reproducible and in [0,1)', () => {
  const a = rngFromSeed(SEED);
  const b = rngFromSeed(SEED);
  for (let i = 0; i < 5; i++) {
    const v = a();
    assert.strictEqual(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

// --- Elo ---
test('Elo: the winner gains and the loser loses symmetrically at equal ratings', () => {
  const [a, b] = updateElo(1200, 1200, true);
  assert.strictEqual(a, 1216);
  assert.strictEqual(b, 1184);
});

test('Elo: beating a much stronger opponent gains more', () => {
  const [aWeakBeatsStrong] = updateElo(1000, 1600, true);
  const [aStrongBeatsWeak] = updateElo(1600, 1000, true);
  assert.ok((aWeakBeatsStrong - 1000) > (aStrongBeatsWeak - 1600));
});

// --- schema sanity ---
test('SCHEMA has no leftover custodial tables and defines the core ones', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS tournaments/.test(SCHEMA));
  assert.ok(/CREATE TABLE IF NOT EXISTS house_scores/.test(SCHEMA));
  assert.ok(/trophy_inscription_id/.test(SCHEMA));
  assert.ok(!/season_wallet|claims|SEASON_WALLET|designs/i.test(SCHEMA));
  assert.strictEqual(BADGE_DEFS.find((b) => b.badge_key === 'champion').name, 'CHAMPION');
});

console.log(`\n${passed} passed`);
