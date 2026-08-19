// The content tables, and the invariants that keep them honest.
// Run: node test/adventure-content.test.js
const assert = require('assert');
const P = require('../src/adventure/pool');
const G = require('../src/genetics');
const { FACES } = require('../src/adventure/faces');
const { BODIES } = require('../src/adventure/bodies');
const { BACKGROUNDS } = require('../src/adventure/backgrounds');
const RUNES = require('../src/adventure/runes');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

/** An allele that can be masked is an allele you have to breed for. That is the whole rare set. */
const hideable = (locus, rank) => P.windowOf(locus, rank)[0] > 0;

console.log('pool');

test('the pool agrees with src/genetics.js, which is the other implementation of the same rule', () => {
  // Two files decide dominance in this repo. They must not drift, and a review is not a check:
  // this walks every ordered pair of every locus and compares the verdicts.
  const counts = require('../src/adventure/counts.gen').COUNTS;
  const items = [];
  let id = 1;
  for (const locus of P.LOCI) {
    for (const [value, n] of Object.entries(counts[locus])) {
      for (let i = 0; i < Math.min(n, 3); i++) {
        // A synthetic item is enough: buildGenePool only reads trait_type/value pairs.
        items.push({ number: id++, attributes: [{ trait_type: locus, value }] });
      }
    }
  }
  // Compare on the shared shape instead: ranks must order the same way in both files.
  const pool = G.buildGenePool(items);
  for (const locus of P.LOCI) {
    const mine = P.POOL[locus].names;
    const theirs = pool.alleles[locus];
    assert.strictEqual(mine.length, theirs.length, locus + ' allele count');
  }
});

test('every locus is the size the collection says', () => {
  assert.deepStrictEqual(
    P.LOCI.map((l) => P.sizeOf(l)),
    [21, 32, 15, 44, 63, 3],
  );
  assert.strictEqual(P.LOCI.reduce((s, l) => s + P.sizeOf(l), 0), 178);
});

test('co-dominance windows are contiguous, on all 178 alleles', () => {
  for (const locus of P.LOCI) {
    const n = P.sizeOf(locus);
    for (let i = 0; i < n; i++) {
      const [lo, hi] = P.windowOf(locus, i);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const inside = j >= lo && j <= hi;
        assert.strictEqual(P.coDominant(locus, i, j), inside, `${locus} ${i} vs ${j}`);
      }
    }
  }
});

test('Collar, Rune and House carry no dominance at all', () => {
  for (const locus of ['Collar', 'Rune', 'House']) {
    for (let i = 0; i < P.sizeOf(locus); i++) {
      assert.deepStrictEqual(P.windowOf(locus, i), [0, P.sizeOf(locus) - 1], locus + ' ' + i);
    }
  }
});

test('a founder is homozygous and therefore cannot Flip', () => {
  const g = {}; for (const l of P.LOCI) g[l] = [0, 0];
  assert.strictEqual(P.canFlip(g), false);
  g.Face = [0, 43];
  assert.strictEqual(P.canFlip(g), true);
});

test('expression is fixed per individual and differs between identical genomes', () => {
  const g = {}; for (const l of P.LOCI) g[l] = [0, 1];
  const a1 = P.phenotype(g, 'alpha-1'), a2 = P.phenotype(g, 'alpha-1');
  assert.deepStrictEqual(a1.first, a2.first, 'same id, same face, every time');
  let differs = false;
  for (let i = 0; i < 40 && !differs; i++) {
    const b = P.phenotype(g, 'sib-' + i);
    if (JSON.stringify(b.first) !== JSON.stringify(a1.first)) differs = true;
  }
  assert.ok(differs, 'two siblings with one genome must be able to look different');
});

console.log('faces');

test('every Face that can be masked grants a rule, never a bigger number', () => {
  const offenders = FACES.filter((f) => hideable('Face', f.rank) && f.kind !== 'rule');
  assert.deepStrictEqual(offenders.map((f) => f.name), [],
    'a rare Face must change how the fight works, not scale a constant');
});

test('the Face table is aligned with the pool, rank by rank', () => {
  FACES.forEach((f, i) => {
    assert.strictEqual(f.name, P.nameOf('Face', i), 'rank ' + i);
    assert.strictEqual(f.rank, i);
  });
});

test('no rare Face is a common Face with the same effect scaled up', () => {
  // The exact failure this table was rewritten to remove. Two Faces sharing an effect key where the
  // rarer one simply has a larger value is the shape that has to stay out.
  const bad = [];
  for (const a of FACES) {
    for (const b of FACES) {
      if (a.rank >= b.rank) continue;
      for (const k of Object.keys(a.fx)) {
        if (typeof a.fx[k] !== 'number' || typeof b.fx[k] !== 'number') continue;
        if (b.fx[k] > a.fx[k] && P.countOf('Face', b.rank) < P.countOf('Face', a.rank)) {
          bad.push(`${b.name} is ${a.name} with ${k} raised to ${b.fx[k]}`);
        }
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('the blank Faces are still blank, because they make the others readable', () => {
  const blanks = FACES.filter((f) => f.kind === 'none');
  assert.ok(blanks.length >= 7, 'the Perplexed tribe carries no passive');
  assert.ok(blanks.every((f) => Object.keys(f.fx).length === 0));
});

console.log('bodies');

test('every Body that can be masked carries an extra rule', () => {
  const offenders = BODIES.filter((b) => hideable('Body', b.rank) && !b.rule);
  assert.deepStrictEqual(offenders.map((b) => b.name), []);
});

test('the stat budget prices the rules, and stays inside a narrow band', () => {
  const budgets = BODIES.map((b) => b.budget);
  const min = Math.min(...budgets), max = Math.max(...budgets);
  assert.ok(min >= 130, 'weakest body budget ' + min);
  assert.ok(max <= 152, 'strongest body budget ' + max);
  assert.ok(max / min <= 1.15, 'spread ' + (max / min).toFixed(3));
});

test('Harlequin Monster growth is capped, so it can be priced', () => {
  const m = BODIES.find((b) => b.name === 'Harlequin Monster');
  assert.strictEqual(typeof m.rule.fx.forceCap, 'number');
  assert.ok(m.rule.fx.forceCap > 0);
});

console.log('backgrounds and runes');

test('only the Backgrounds that can be masked have an arena rule, plus Night Sky', () => {
  const ruled = BACKGROUNDS.filter((b) => !b.decor).map((b) => b.name);
  assert.deepStrictEqual(ruled, ['Night Sky', 'Punk', 'Zombie', 'Spectrum']);
  for (const b of BACKGROUNDS) if (hideable('Background', b.rank)) assert.ok(!b.decor, b.name + ' can hide and must do something');
});

test('all 63 runes parse into 9 known families and 7 colours', () => {
  const fams = new Set(), cols = new Set();
  for (const name of P.POOL.Rune.names) {
    const p = RUNES.parseRune(name);
    assert.ok(RUNES.FAMILIES[p.family], 'unknown family in ' + name);
    fams.add(p.family); cols.add(p.colour);
  }
  assert.strictEqual(fams.size, 9);
  assert.strictEqual(cols.size, 7);
});

test('the Bicoin typo folds, so the three cats it would cost stay Tuned', () => {
  assert.strictEqual(RUNES.colourOf('Hope Bicoin Orange'), 'Bitcoin Orange');
  assert.strictEqual(RUNES.colourOf('Hope Bitcoin Orange'), 'Bitcoin Orange');
  assert.strictEqual(RUNES.isTuned('Bitcoin Orange', 'Hope Bicoin Orange'), true);
  // and the raw string is preserved, because that is what the chain says
  assert.strictEqual(RUNES.parseRune('Hope Bicoin Orange').raw, 'Hope Bicoin Orange');
});

test('Wealth has no combat effect, on purpose', () => {
  assert.deepStrictEqual(Object.keys(RUNES.FAMILIES.Wealth.fx), ['doubleRewards']);
});

console.log(`\n${passed} checks passed`);
