// Genetics: dominance from frequency, Mendelian transmission, mutation, sex, Wright's coefficient.
// Run: node test/genetics.test.js
const assert = require('assert');
const {
  LOCI, VIABILITY_FLOOR,
  buildGenePool, genomeFromItem, phenotype, zygosity, toAttributes,
  breed, kinship, inbreeding, pairingReport,
} = require('../src/genetics');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

// The real 3333 are a gitignored dump (served from the live API, not shipped), so the checks that
// need them run for a developer who has the file and announce themselves skipped for everyone else.
const { buildCollection, realCollection } = require('./fixtures/collection');
const REAL = realCollection();
function whenReal(name, fn) {
  if (!REAL) return void console.log('  -- skipped, needs verginals/metadata.json - ' + name);
  return test(name, fn);
}


const item = (n, a) => ({ number: n, name: `Verginals #${n}`, attributes: Object.entries(a).map(([trait_type, value]) => ({ trait_type, value })) });

// A miniature collection with a deliberately lopsided Face locus, so every dominance case is
// checkable by hand:
//   Happy x10   commonest
//   Cool  x4    4/10 = 0.40 >= 1/3  -> CO-DOMINANT with Happy
//   Rainbow x2  2/10 = 0.20 <  1/3  -> RECESSIVE to Happy (the grail case)
// Houses alternate so Fire and Water stay level, mirroring the real 1111/1111/1111 that makes them
// the most co-dominant pair in the collection (§4.5).
const COMMON = { Background: 'Blue', Body: 'Grey', Collar: 'Blue', Rune: 'Birch White' };
const MINI = [];
let nextId = 1;
const add = (face, ears, extra = {}) => MINI.push(item(nextId++, {
  ...COMMON, Face: face, Ears: ears, House: nextId % 2 ? 'Fire' : 'Water', ...extra,
}));
for (let i = 0; i < 5; i++) { add('Happy', 'Pink', { House: 'Fire' }); add('Happy', 'Grey'); }
for (let i = 0; i < 2; i++) { add('Cool', 'Pink'); add('Cool', 'Grey'); }
add('Rainbow', 'Pink');
add('Rainbow', 'Grey', { House: 'Water' });
const POOL = buildGenePool(MINI);
const HAPPY_F = MINI[0];                    // Happy/Happy, female
const RAINBOW_F = MINI[MINI.length - 2];    // Rainbow/Rainbow, female
const RAINBOW_M = MINI[MINI.length - 1];    // Rainbow/Rainbow, male, House Water
const COOL_M = MINI.find((i) => i.attributes.some((a) => a.trait_type === 'Face' && a.value === 'Cool')
  && i.attributes.some((a) => a.trait_type === 'Ears' && a.value === 'Grey'));

// --- the pool reads dominance off the collection ----------------------------------------------

test('dominance rank is population frequency: the commonest value in a locus is dominant', () => {
  assert.deepStrictEqual(POOL.alleles.Face, ['Happy', 'Cool', 'Rainbow']);
  assert.strictEqual(POOL.rank.Face.get('Happy'), 0);
  assert.strictEqual(POOL.rank.Face.get('Rainbow'), 2);
  assert.strictEqual(POOL.count.Face.get('Happy'), 10);
  assert.strictEqual(POOL.count.Face.get('Rainbow'), 2);
});

test('Ears is not a heritable locus — it is the sex locus (combos.js discards it as noise)', () => {
  assert.ok(!LOCI.includes('Ears'));
  assert.ok(LOCI.includes('Background'), 'Background must be heritable or Double Rainbow is unreachable');
});

// --- Alphas ------------------------------------------------------------------------------------

test('an Alpha is homozygous everywhere, so its genome is fully determined by its on-chain traits', () => {
  const g = genomeFromItem(RAINBOW_F, POOL);
  for (const locus of LOCI) assert.strictEqual(zygosity(g, locus), 'hom', locus);
  assert.strictEqual(g.sex, 'F');
  assert.strictEqual(g.alpha, true);
});

test("an Alpha's phenotype round-trips its metadata exactly — even a fully recessive Rainbow", () => {
  const src = RAINBOW_F;
  const p = phenotype(genomeFromItem(src, POOL), POOL);
  for (const a of src.attributes) assert.strictEqual(p[a.trait_type], a.value, a.trait_type);
});

test('toAttributes hands a descendant straight to combos.js / rarity.js in their own shape', () => {
  const attrs = toAttributes(genomeFromItem(HAPPY_F, POOL), POOL);
  const types = attrs.map((a) => a.trait_type).sort();
  assert.deepStrictEqual(types, ['Background', 'Body', 'Collar', 'Ears', 'Face', 'House', 'Rune']);
});

// --- breeding ----------------------------------------------------------------------------------

const mumHappy = genomeFromItem(HAPPY_F, POOL);    // Happy/Happy, F, House Fire
const dadRainbow = genomeFromItem(RAINBOW_M, POOL); // Rainbow/Rainbow, M, House Water

test('breed is deterministic: same parents and seed give the identical descendant', () => {
  const a = breed(mumHappy, dadRainbow, 'seed-alpha', { pool: POOL });
  const b = breed(mumHappy, dadRainbow, 'seed-alpha', { pool: POOL });
  assert.deepStrictEqual(a.genes, b.genes);
  assert.strictEqual(a.sex, b.sex);
});

test('breed refuses a pairing that is not one female and one male', () => {
  assert.throws(() => breed(dadRainbow, mumHappy, 's', { pool: POOL }), /female and one male/);
});

test('F1 of two homozygous Alphas is heterozygous at every locus', () => {
  const kid = breed(mumHappy, dadRainbow, 'seed-f1', { pool: POOL, mutationRate: 0 });
  assert.deepStrictEqual(kid.genes.Face, ['Happy', 'Rainbow']);
  assert.strictEqual(zygosity(kid, 'Face'), 'het');
});

test('the rare allele hides in F1: a Happy/Rainbow carrier shows Happy', () => {
  const kid = breed(mumHappy, dadRainbow, 'seed-f1', { pool: POOL, mutationRate: 0 });
  assert.strictEqual(phenotype(kid, POOL).Face, 'Happy');
});

test('a recessive only surfaces on convergence — the Monochrome mechanic in miniature (§3.3)', () => {
  // Cross two carriers. Over many seeds ~1/4 of the litter is Rainbow/Rainbow, and those are the
  // only ones that show Rainbow. Nothing else in the run may express it.
  const carrierF = { ...breed(mumHappy, dadRainbow, 'c1', { pool: POOL, mutationRate: 0 }), sex: 'F', id: 'cf' };
  const carrierM = { ...breed(mumHappy, dadRainbow, 'c2', { pool: POOL, mutationRate: 0 }), sex: 'M', id: 'cm' };
  let shown = 0;
  for (let i = 0; i < 400; i++) {
    const kid = breed(carrierF, carrierM, `gen2-${i}`, { pool: POOL, mutationRate: 0 });
    const showsRainbow = phenotype(kid, POOL).Face === 'Rainbow';
    if (showsRainbow) {
      assert.deepStrictEqual(kid.genes.Face, ['Rainbow', 'Rainbow'], 'Rainbow expressed while heterozygous');
      shown += 1;
    }
  }
  assert.ok(shown > 60 && shown < 140, `expected ~100 of 400 homozygous recessives, got ${shown}`);
});

test('sex is roughly even across a large litter', () => {
  let females = 0;
  for (let i = 0; i < 600; i++) {
    if (breed(mumHappy, dadRainbow, `sex-${i}`, { pool: POOL, mutationRate: 0 }).sex === 'F') females += 1;
  }
  assert.ok(females > 250 && females < 350, `expected ~300 of 600, got ${females}`);
});

test('co-dominant alleles vary inside one litter, and only ever show one of the two', () => {
  // Happy (10) x Cool (4) is 0.40, above the co-dominance ratio, so a Happy/Cool kid may show
  // either. This is what stops a pairing from being phenotypically deterministic.
  const coolDad = genomeFromItem(COOL_M, POOL);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const kid = breed(mumHappy, coolDad, `cod-${i}`, { pool: POOL, mutationRate: 0 });
    const face = phenotype(kid, POOL).Face;
    assert.ok(face === 'Happy' || face === 'Cool', `expressed ${face}`);
    seen.add(face);
  }
  assert.deepStrictEqual([...seen].sort(), ['Cool', 'Happy']);
});

whenReal('REGRESSION: a real Alpha pairing must not produce a litter of clones', () => {
  // Strict frequency dominance made every kid of a given pair phenotypically identical — correct
  // Mendelian F1 uniformity, and a dead phase 1, since the spec's first playable loop is exactly
  // "breed two Alphas". Measured at 100% of 300 pairings before co-dominance was introduced.
  const items = REAL;
  const real = buildGenePool(items);
  const at = (i, t) => i.attributes.find((a) => a.trait_type === t).value;
  const females = items.filter((i) => at(i, 'Ears') === 'Pink');
  const males = items.filter((i) => at(i, 'Ears') === 'Grey');
  const visible = ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House'];

  let uniform = 0;
  const pairings = 40;
  for (let n = 0; n < pairings; n++) {
    const mum = genomeFromItem(females[(n * 37) % females.length], real);
    const dad = genomeFromItem(males[(n * 53) % males.length], real);
    const looks = new Set();
    for (let s = 0; s < 6; s++) {
      const p = phenotype(breed(mum, dad, `reg-${n}-${s}`, { pool: real, mutationRate: 0 }), real);
      looks.add(visible.map((t) => p[t]).join('|'));
    }
    if (looks.size === 1) uniform += 1;
  }
  assert.ok(uniform < pairings * 0.1, `${uniform}/${pairings} pairings produced identical-looking litters`);
});

// --- mutation ----------------------------------------------------------------------------------

test('a mutation is always a value present in neither parent (§3.2)', () => {
  let seen = 0;
  for (let i = 0; i < 300; i++) {
    const kid = breed(mumHappy, dadRainbow, `mut-${i}`, { pool: POOL, mutationRate: 0.5 });
    for (const m of kid.mutations) {
      // Neither parent, not merely the transmitting one.
      assert.ok(!mumHappy.genes[m.locus].includes(m.value), `${m.locus}: ${m.value} was in the mother`);
      assert.ok(!dadRainbow.genes[m.locus].includes(m.value), `${m.locus}: ${m.value} was in the father`);
      seen += 1;
    }
  }
  assert.ok(seen > 0, 'the run produced no mutations to check');
});

test('mutationOdds reports the per-descendant chance, not the per-allele one', () => {
  const { MUTATION_RATE, mutationOdds } = require('../src/genetics');
  assert.strictEqual(MUTATION_RATE, 1 / 1000);
  assert.ok(Math.abs(mutationOdds() - 0.0119) < 0.0002, `default odds were ${mutationOdds()}`);
  assert.ok(Math.abs(mutationOdds(1 / 500) - 0.0237) < 0.0002);
  assert.strictEqual(mutationOdds(0), 0);
});

test('a mutation can land on any other value of that trait, rarest included', () => {
  // Uniform across the locus, so a mutation is the one route to a value nobody in the line carries.
  const landed = new Set();
  for (let i = 0; i < 4000; i++) {
    for (const m of breed(mumHappy, dadRainbow, `uni-${i}`, { pool: POOL, mutationRate: 0.2 }).mutations) {
      if (m.locus === 'Face') landed.add(m.value);
    }
  }
  assert.ok(landed.has('Cool'), 'a Face mutation never reached Cool');
  assert.ok(!landed.has('Happy') && !landed.has('Rainbow'), 'a mutation returned a value a parent already carried');
});

test('a mutation records what it replaced, so the reveal can say what was lost', () => {
  for (let i = 0; i < 200; i++) {
    for (const m of breed(mumHappy, dadRainbow, `rep-${i}`, { pool: POOL, mutationRate: 0.5 }).mutations) {
      const parent = m.from === 'mother' ? mumHappy : dadRainbow;
      assert.ok(parent.genes[m.locus].includes(m.replaced), `${m.locus}: replaced ${m.replaced} came from nowhere`);
      assert.notStrictEqual(m.value, m.replaced);
    }
  }
});

test('a per-locus rate overrides the base rate for that trait only', () => {
  let faceMuts = 0, otherMuts = 0;
  for (let i = 0; i < 300; i++) {
    const kid = breed(mumHappy, dadRainbow, `pl-${i}`, {
      pool: POOL, mutationRate: 0, mutationRateByLocus: { Face: 0.5 },
    });
    for (const m of kid.mutations) (m.locus === 'Face' ? faceMuts++ : otherMuts++);
  }
  assert.ok(faceMuts > 100, `expected many Face mutations, got ${faceMuts}`);
  assert.strictEqual(otherMuts, 0, 'a locus without an override mutated anyway');
});

test('mutation is off when the rate is zero', () => {
  for (let i = 0; i < 50; i++) {
    assert.deepStrictEqual(breed(mumHappy, dadRainbow, `z-${i}`, { pool: POOL, mutationRate: 0 }).mutations, []);
  }
});

// --- House -------------------------------------------------------------------------------------

test('a heterozygous House expresses one of its two, never a third, and neither is favoured', () => {
  let fire = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const kid = breed(mumHappy, dadRainbow, `h-${i}`, { pool: POOL, mutationRate: 0 });
    if (zygosity(kid, 'House') !== 'het') continue;
    const h = phenotype(kid, POOL).House;
    assert.ok(h === 'Fire' || h === 'Water', `expressed ${h} from ${kid.genes.House}`);
    if (h === 'Fire') fire += 1;
    n += 1;
  }
  assert.ok(n > 300, `expected most kids heterozygous for House, got ${n}`);
  assert.ok(fire > n * 0.4 && fire < n * 0.6, `House expression skewed: ${fire}/${n} Fire`);
});

test('House expression is stable for a given genome, so a creature never changes element', () => {
  const kid = breed(mumHappy, dadRainbow, 'stable', { pool: POOL, mutationRate: 0 });
  const first = phenotype(kid, POOL).House;
  for (let i = 0; i < 20; i++) assert.strictEqual(phenotype(kid, POOL).House, first);
});

// --- inbreeding (§3.4) -------------------------------------------------------------------------

// G is the shared grandparent; every other founder is unrelated.
//   A = G x X1     B = G x X2        (half siblings)
//   P1 = A x Y1    P2 = B x Y2       (parents sharing exactly one grandparent)
const PED = {
  A: { mother: 'G', father: 'X1' },
  B: { mother: 'G', father: 'X2' },
  P1: { mother: 'A', father: 'Y1' },
  P2: { mother: 'B', father: 'Y2' },
  fullSibA: { mother: 'M1', father: 'F1' },
  fullSibB: { mother: 'M1', father: 'F1' },
  halfSibA: { mother: 'M1', father: 'F1' },
  halfSibB: { mother: 'M1', father: 'F2' },
};

test("Wright's coefficient: full siblings 0.25, half siblings 0.125", () => {
  assert.strictEqual(kinship(PED, 'fullSibA', 'fullSibB'), 0.25);
  assert.strictEqual(kinship(PED, 'halfSibA', 'halfSibB'), 0.125);
});

test('parents sharing exactly one grandparent give F = 1/32', () => {
  assert.strictEqual(kinship(PED, 'P1', 'P2'), 1 / 32);
});

test('unrelated founders are unrelated, and an unknown id is treated as fresh blood', () => {
  assert.strictEqual(kinship(PED, 'X1', 'Y1'), 0);
  assert.strictEqual(kinship(PED, 'P1', 'someAlphaBoughtToday'), 0);
  assert.strictEqual(inbreeding(PED, 'A'), 0);
});

test("the spec's own example holds: shared grandparent -> offspring viability -18%", () => {
  const r = pairingReport(PED, 'P1', 'P2');
  assert.strictEqual(r.penaltyPct, 18);
  assert.strictEqual(r.relation, 'Shared grandparent');
});

test('an unrelated pairing has full viability and says so', () => {
  const r = pairingReport(PED, 'X1', 'Y1');
  assert.strictEqual(r.viability, 1);
  assert.strictEqual(r.relation, 'Unrelated');
});

test('a closed line gets fragile but never sterile — viability floors, it does not reach zero', () => {
  const r = pairingReport(PED, 'fullSibA', 'fullSibB');
  assert.ok(r.viability >= VIABILITY_FLOOR - 1e-9, `viability ${r.viability} fell through the floor`);
  assert.ok(r.penaltyPct > 18, 'full siblings must cost more than a shared grandparent');
});

// --- against the real collection ---------------------------------------------------------------

whenReal('the real 3333 build a pool with every locus populated and House exactly tied', () => {
  const real = buildGenePool(REAL);
  assert.deepStrictEqual(real.alleles.House.slice().sort(), ['Earth', 'Fire', 'Water']);
  for (const h of ['Earth', 'Fire', 'Water']) assert.strictEqual(real.count.House.get(h), 1111);
  assert.strictEqual(real.alleles.Face.length, 44);
  assert.strictEqual(real.alleles.Rune.length, 63);
  assert.strictEqual(real.alleles.Background.length, 21);
});

whenReal('every one of the 3333 Alphas produces a genome whose phenotype is its own metadata', () => {
  const items = REAL;
  const real = buildGenePool(items);
  for (const it of items) {
    const p = phenotype(genomeFromItem(it, real), real);
    for (const a of it.attributes) {
      if (p[a.trait_type] !== a.value) {
        assert.fail(`#${it.number} ${a.trait_type}: got ${p[a.trait_type]}, expected ${a.value}`);
      }
    }
  }
});

console.log(`\n${passed} genetics tests passed`);
