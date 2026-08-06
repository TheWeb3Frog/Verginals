// Growing up, living slots, season end. The invariant under test throughout: absence never
// subtracts (§5).
// Run: node test/lifecycle.test.js
const assert = require('assert');
const L = require('../src/lifecycle');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

const DAY = L.DAY;
const T0 = 1_770_000_000 - (1_770_000_000 % DAY); // midnight, so day boundaries are unambiguous
const born = () => {
  const j = L.newJuvenile('k1', T0);
  return { j, birth: j.bornAt };
};

// --- gestation ---------------------------------------------------------------------------------

test('a descendant gestates for two days before it is born (§5.3)', () => {
  const { j } = born();
  assert.strictEqual(j.bornAt, T0 + 2 * DAY);
  assert.strictEqual(L.isBorn(j, T0 + DAY), false);
  assert.strictEqual(L.isBorn(j, T0 + 2 * DAY), true);
});

test('an unborn descendant cannot be attended to', () => {
  const { j } = born();
  assert.deepStrictEqual(L.attend(j, 'feed', T0 + DAY), { ok: false, reason: 'gestating', growth: 0 });
  assert.strictEqual(j.growth, 0);
});

// --- the two paces the spec names ----------------------------------------------------------------

test('full attention matures a juvenile in two days (§5.3)', () => {
  const { j, birth } = born();
  for (const d of [0, 1]) {
    for (const k of ['spar', 'feed', 'play']) L.attend(j, k, birth + d * DAY + 3600);
  }
  assert.strictEqual(j.growth, L.GROWTH_TO_ADULT);
  assert.strictEqual(L.isAdult(j), true);
});

test('a player who never shows up still gets an adult, in six days of life rather than two', () => {
  // Days are counted the same way for both routes: the day of birth is a full day, so full
  // attention is days 0-1 and pure drift is days 0-5.
  const { j, birth } = born();
  assert.strictEqual(L.status(j, birth).growth, 1, 'the birth day itself should grow');
  assert.strictEqual(L.status(j, birth + 4 * DAY).growth, 5);
  assert.strictEqual(L.status(j, birth + 4 * DAY).adult, false);
  assert.strictEqual(L.status(j, birth + 5 * DAY).adult, true);
});

test('ABSENCE NEVER SUBTRACTS: growth is monotonic across any sequence of gaps', () => {
  const { j, birth } = born();
  let last = 0;
  for (const day of [0, 1, 4, 5, 30, 31, 400]) {
    const g = L.status(j, birth + day * DAY).growth;
    assert.ok(g >= last, `growth fell from ${last} to ${g} on day ${day}`);
    last = g;
  }
  assert.strictEqual(last, L.GROWTH_TO_ADULT);
});

// --- the shared daily cap ------------------------------------------------------------------------

test('three attentions a day, and the fourth is refused rather than erroring', () => {
  const { j, birth } = born();
  for (let i = 0; i < 3; i++) assert.strictEqual(L.attend(j, 'spar', birth).ok, true);
  const r = L.attend(j, 'spar', birth);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no attentions left today');
});

test('attentions and counted fights are separate budgets sharing one growth cap of 3/day', () => {
  const { j, birth } = born();
  // Three counted fights fill the day's growth. Passive drift already took one point of the cap,
  // so the third fight adds nothing to growth. The day still totals 3 either way, which is the
  // invariant that matters.
  for (let i = 0; i < 3; i++) assert.strictEqual(L.recordFight(j, birth).counted, true);
  const s = L.status(j, birth);
  assert.strictEqual(s.growth, 3);
  assert.strictEqual(s.growthLeftToday, 0);
  assert.strictEqual(s.fightsCountedLeft, 0);
  // ...but the attention budget is untouched, and attending still shapes the creature.
  assert.strictEqual(s.attentionsLeft, 3);
  const a = L.attend(j, 'play', birth);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.growth, 0, 'the daily growth cap was exceeded');
  assert.strictEqual(j.attentions.play, 1, 'the attention did not count toward temperament');
});

test('neither route can beat two days: six points is the floor either way', () => {
  const { j, birth } = born();
  for (let i = 0; i < 3; i++) { L.attend(j, 'feed', birth); L.recordFight(j, birth); }
  assert.strictEqual(j.growth, 3, 'more than the daily cap was granted');
  assert.strictEqual(L.isAdult(j), false);
});

test('fighting is never capped, only the first three of the day count (§5.2)', () => {
  const { j, birth } = born();
  let counted = 0;
  for (let i = 0; i < 30; i++) {
    const r = L.recordFight(j, birth);
    assert.strictEqual(r.ok, true, 'a bot fight was refused');
    if (r.counted) counted += 1;
  }
  assert.strictEqual(counted, 3);
});

test('growth never overshoots adulthood', () => {
  const { j, birth } = born();
  for (let d = 0; d < 10; d++) for (const k of L.ATTENTIONS) L.attend(j, k, birth + d * DAY);
  assert.strictEqual(j.growth, L.GROWTH_TO_ADULT);
});

test('an adult stops absorbing attention, and says why', () => {
  const { j, birth } = born();
  L.status(j, birth + 10 * DAY);
  assert.deepStrictEqual(L.attend(j, 'spar', birth + 10 * DAY), { ok: false, reason: 'adult', growth: 0 });
});

test('an unknown attention is a programming error, not a silent no-op', () => {
  const { j, birth } = born();
  assert.throws(() => L.attend(j, 'scold', birth), /unknown attention/);
});

// --- temperament ---------------------------------------------------------------------------------

test('what you did with it decides what it became (§5.1)', () => {
  const { j, birth } = born();
  L.attend(j, 'drill', birth); L.attend(j, 'drill', birth); L.attend(j, 'spar', birth);
  assert.strictEqual(L.temperament(j).dominant, 'drill');
  assert.strictEqual(L.temperament(j).label, 'Specialist');
});

test('two identical genomes raised differently are different individuals', () => {
  const a = L.newJuvenile('a', T0), b = L.newJuvenile('b', T0);
  for (let i = 0; i < 3; i++) { L.attend(a, 'feed', a.bornAt); L.attend(b, 'play', b.bornAt); }
  assert.notStrictEqual(L.temperament(a).label, L.temperament(b).label);
});

test('an evenly raised creature reads Balanced, and an untouched one says so', () => {
  const { j, birth } = born();
  assert.strictEqual(L.temperament(j).label, 'Untouched');
  L.attend(j, 'spar', birth); L.attend(j, 'feed', birth);
  assert.strictEqual(L.temperament(j).dominant, null);
  assert.strictEqual(L.temperament(j).label, 'Balanced');
});

// --- living slots (§6) -----------------------------------------------------------------------------

test('living slots report the state and never evict anything by themselves', () => {
  assert.deepStrictEqual(L.slots([1, 2, 3]), { used: 3, cap: 6, free: 3, full: false });
  assert.deepStrictEqual(L.slots([1, 2, 3, 4, 5, 6]), { used: 6, cap: 6, free: 0, full: true });
  assert.strictEqual(L.slots([1, 2], { livingSlots: 2 }).full, true);
});

// --- season end (§1, §7) ---------------------------------------------------------------------------

test('every descendant dies at season end; Alphas are untouched (§7)', () => {
  const stable = [
    { id: 'alpha:6', alpha: true },
    { id: 'alpha:15', alpha: true },
    { id: 'k1', alpha: false, genes: {}, sex: 'F', mother: 'alpha:6', father: 'alpha:15', attentions: { spar: 2, drill: 0, feed: 0, play: 0 } },
    { id: 'k2', alpha: false, genes: {}, sex: 'M', mother: 'alpha:6', father: 'alpha:15' },
  ];
  const r = L.seasonEnd(stable);
  assert.deepStrictEqual(r.survivors.map((c) => c.id), ['alpha:6', 'alpha:15']);
  assert.deepStrictEqual(r.died.map((c) => c.id), ['k1', 'k2']);
  assert.strictEqual(r.roster.length, 2, 'the roster must carry everything that lived (§7.1)');
  assert.strictEqual(r.roster[0].temperament, 'Scrapper');
});

test('the season clock fills for thirty days and stops there', () => {
  assert.deepStrictEqual(L.seasonClock(T0, T0), { day: 1, days: 30, left: 29, endsAt: T0 + 30 * DAY });
  assert.strictEqual(L.seasonClock(T0, T0 + 22 * DAY).day, 23);
  assert.strictEqual(L.seasonClock(T0, T0 + 29 * DAY).left, 0);
  assert.strictEqual(L.seasonClock(T0, T0 + 90 * DAY).day, 30, 'the clock ran past the end of the season');
});

test('a season fits the six to seven generations the spec promises (§1.2)', () => {
  // gestation 2 days + maturation 2 days at full attention = a 4-day generation.
  const generation = L.GESTATION_DAYS + 2;
  const perSeason = Math.floor(L.SEASON_DAYS / generation);
  assert.ok(perSeason >= 6 && perSeason <= 7, `a season yields ${perSeason} generations, not 6-7`);
});

console.log(`\n${passed} lifecycle tests passed`);
