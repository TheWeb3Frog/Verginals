// Turn-by-turn bot duels (§4.4). The two properties under test are the two the design rests on:
// a round already shown never changes, and the turn-by-turn result is the SAME result a committed
// match would produce, not an approximation of it.
// Run: node test/duel.test.js
const assert = require('assert');
const { openBotDuel, playRound, publicView, botLoadoutFrom, PAD } = require('../src/duel');
const { resolveMatch, serverSeedHash, ELEMENTS } = require('../src/game');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const P1 = { address: 'DPlayer', house: 'fire', rarityScore: 100, comeback: false, shield: false };
const BOT = { address: 'bot', house: 'water', rarityScore: 100, comeback: false, shield: false };
const seedOf = (n) => `${n}`.padStart(64, '0');

/** Play a whole duel, one round at a time, with a chosen list of player moves. */
function playAll(seed, moves) {
  const d = openBotDuel(P1, BOT, { seed });
  const steps = moves.map((m) => playRound(d, m));
  return { d, steps, last: steps[steps.length - 1] };
}
const THREE = [{ element: 'fire' }, { element: 'water', poison: true }, { element: 'earth' }];

// --- the commitment -----------------------------------------------------------------------------

test('opening a duel publishes a hash and withholds the seed and the bot moves', () => {
  const d = openBotDuel(P1, BOT, { seed: seedOf(1) });
  const v = publicView(d);
  assert.strictEqual(v.serverSeedHash, serverSeedHash(seedOf(1)));
  assert.strictEqual(v.seed, undefined);
  assert.strictEqual(v.botMoves, undefined);
  assert.strictEqual(v.round, 0);
});

test('THE BOT CANNOT REACT: its whole match is fixed by the seed before a single move is played', () => {
  const seed = seedOf(7);
  const expected = botLoadoutFrom(seed);
  // Two duels on the same seed, played completely differently, get the identical bot.
  const a = playAll(seed, THREE);
  const b = playAll(seed, [{ element: 'earth' }, { element: 'earth' }, { element: 'fire', potion: true }]);
  assert.deepStrictEqual(a.d.botMoves, expected);
  assert.deepStrictEqual(b.d.botMoves, expected);
});

test('the seed and the bot moves are revealed only once nothing can be influenced', () => {
  const { d, steps } = playAll(seedOf(3), THREE);
  assert.strictEqual(steps[0].seed, undefined);
  assert.strictEqual(steps[1].seed, undefined);
  assert.strictEqual(steps[2].seed, d.seed);
  assert.deepStrictEqual(steps[2].botMoves, d.botMoves);
});

// --- the invariant that makes turn-by-turn honest ------------------------------------------------

test('A ROUND ALREADY SHOWN NEVER CHANGES when later moves arrive', () => {
  for (let n = 1; n <= 40; n++) {
    const seed = seedOf(n);
    const d = openBotDuel(P1, BOT, { seed });
    const shown = [];
    for (const move of THREE) {
      const r = playRound(d, move);
      shown.push(r.result);
      // Every round shown so far must still read exactly as it did when it was shown.
      assert.deepStrictEqual(d.results, shown, `seed ${n}: an earlier round changed`);
    }
  }
});

test('THE TURN-BY-TURN RESULT IS THE COMMITTED RESULT: same winner, same rounds, same seed', () => {
  for (let n = 1; n <= 60; n++) {
    const seed = seedOf(n);
    const { d, last } = playAll(seed, THREE);
    // What a tournament would have produced from the same three moves, resolved in one go.
    const committed = resolveMatch({
      p1: P1,
      p2: BOT,
      moves: THREE.map((m, i) => ({ p1: { element: m.element, poison: !!m.poison, potion: !!m.potion }, p2: d.botMoves[i] })),
      seed,
    });
    assert.deepStrictEqual(last.match.rounds, committed.rounds, `seed ${n}: rounds diverged`);
    assert.strictEqual(last.match.winner, committed.winner, `seed ${n}: winner diverged`);
    assert.deepStrictEqual(last.match.score, committed.score);
    assert.strictEqual(last.match.seed, seed);
  }
});

test('padding cannot leak into a shown round: the pad is a plain element with no charges', () => {
  assert.deepStrictEqual(Object.keys(PAD), ['element']);
  assert.ok(ELEMENTS.includes(PAD.element));
});

// --- playing ------------------------------------------------------------------------------------

test('each round returns its own outcome as it happens', () => {
  const { steps } = playAll(seedOf(11), THREE);
  steps.forEach((s, i) => {
    assert.strictEqual(s.round, i + 1);
    assert.ok(['p1', 'p2'].includes(s.result.winner));
    assert.ok(typeof s.result.reason === 'string' && s.result.reason.length);
  });
  assert.strictEqual(steps[0].done, false);
  assert.strictEqual(steps[2].done, true);
});

test('a fourth round is refused rather than silently ignored', () => {
  const { d } = playAll(seedOf(13), THREE);
  assert.strictEqual(playRound(d, { element: 'fire' }).error, 'this duel is over');
});

test('a move without a valid element is refused, naming the round the player is looking at', () => {
  const d = openBotDuel(P1, BOT, { seed: seedOf(17) });
  assert.match(playRound(d, {}).error, /round 1 needs an element/);
  assert.match(playRound(d, { element: 'lightning' }).error, /round 1 needs an element/);
  playRound(d, { element: 'fire' });
  assert.match(playRound(d, null).error, /round 2 needs an element/);
});

test('a refused move does not consume the round', () => {
  const d = openBotDuel(P1, BOT, { seed: seedOf(19) });
  playRound(d, { element: 'nope' });
  assert.strictEqual(d.playerMoves.length, 0);
  assert.strictEqual(playRound(d, { element: 'fire' }).round, 1);
});

test('a second poison or potion is refused with a message about the match, not the round', () => {
  const d = openBotDuel(P1, BOT, { seed: seedOf(23) });
  playRound(d, { element: 'fire', poison: true });
  assert.match(playRound(d, { element: 'water', poison: true }).error, /already used your poison/);
  playRound(d, { element: 'water', potion: true });
  assert.match(playRound(d, { element: 'earth', potion: true }).error, /already used your potion/);
});

// --- the bot is worth reading ---------------------------------------------------------------------

test('the bot does not always spend everything, so its pattern is worth learning', () => {
  let withheldPoison = 0;
  let spentPoison = 0;
  for (let n = 0; n < 300; n++) {
    const moves = botLoadoutFrom(seedOf(n));
    if (moves.some((m) => m.poison)) spentPoison += 1; else withheldPoison += 1;
    assert.strictEqual(moves.filter((m) => m.poison).length <= 1, true, 'the bot spent two poisons');
    assert.strictEqual(moves.filter((m) => m.potion).length <= 1, true, 'the bot spent two potions');
    for (const m of moves) assert.ok(ELEMENTS.includes(m.element));
  }
  assert.ok(spentPoison > 0 && withheldPoison > 0, 'the bot is not varying its power-ups at all');
});

test('the bot loadout is a pure function of the seed', () => {
  assert.deepStrictEqual(botLoadoutFrom(seedOf(5)), botLoadoutFrom(seedOf(5)));
  assert.notDeepStrictEqual(botLoadoutFrom(seedOf(5)), botLoadoutFrom(seedOf(6)));
});

console.log(`\n${passed} duel tests passed`);
