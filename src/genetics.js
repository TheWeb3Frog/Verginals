'use strict';
// Verginals Adventure Mode: the genetics engine. See spec/ADVENTURE-MODE-v0.md §3.
//
// Like src/game.js this is pure: no DB, no network, no wallet, and no randomness beyond a
// caller-supplied seed. breed() is a deterministic function of (mother, father, seed, config), so a
// litter can be recomputed by anyone holding the parents and the revealed seed. That matters here
// for the same reason it matters in combat: the server is the only thing that can produce a
// descendant, so the only defence against "you rigged my breeding" is that anyone can rerun it.
//
// Three rules carry the whole design, and each one is forced by the spec rather than invented:
//
//   1. DOMINANCE IS POPULATION FREQUENCY (§3.3), BUT ONLY WHERE THE GAP IS REAL. Within a locus a
//      clearly commoner allele is dominant, so rare values are recessive, hide as invisible
//      carriers, and can only be expressed once they converge from both parents. That is precisely
//      the Monochrome hunt the spec describes, and it needs no hand-authored dominance table: it is
//      read off the 3333 Alphas and stays true if the collection is ever extended.
//
//      Two alleles of comparable frequency are instead CO-DOMINANT: the individual expresses one of
//      them, drawn from its own genome. Without this the engine is strictly Mendelian and every
//      litter from a given pair is phenotypically identical — measured at 100% of 300 real Alpha
//      pairings. That is correct biology (F1 uniformity, Mendel's first law) and a broken game:
//      phase 1 of the spec is "breed two Alphas", and it would always return the same creature.
//      Co-dominance restores variation in F1 without touching the recessive machinery that makes
//      the grails hard, because a grail allele is by definition far rarer than its partner.
//
//   2. ALPHAS ARE HOMOZYGOUS for what they show. An Alpha's genome is therefore fully determined
//      by its on-chain metadata — no hidden server-side allele, nothing a player has to trust us
//      about. The invisible carriers the game runs on are created by the first cross, not handed
//      out at genesis.
//
//   3. RARITY BUYS STRANGENESS, NOT STRENGTH (§4.2/§4.5). Nothing here returns a combat stat.
//      Genetics decides which traits a descendant expresses; src/combos.js scores them and
//      src/game.js fights them. This module never touches power.
//
// House needs no special case once rule 1 is stated that way: the three Houses are 1111/1111/1111,
// exactly tied by design, so they are the most co-dominant pair in the collection and a
// heterozygote expresses one of its two at random. Which is what §4.5 requires — any fixed
// ordering would permanently tilt a combat layer built on a three-way cycle.

const { rngFromSeed } = require('./game');

// The six heritable loci. Ears is deliberately absent: it is 1671/1662 pink/grey across the
// collection and src/combos.js already discards it as "near 50/50 noise" — it is the sex locus
// (§3.1), inherited by sexOf() below rather than as a trait.
//
// Background IS here, and has to be: Double Rainbow needs a rainbow Face *and* a Spectrum
// Background, and Camouflage needs Body and Background to share a vivid colour. Drop Background
// from the heritable set and both of those become unreachable by breeding.
const LOCI = ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House'];

// Where dominance stops being decisive. Two alleles are co-dominant when the rarer is at least a
// third as common as its partner; below that the commoner one is expressed and the rarer is
// carried invisibly. A third is high enough that the grails stay recessive (a Rainbow face is 9 in
// 3333 against a common face's ~200, a ratio of 0.05) and low enough that ordinary traits vary
// inside a litter. It is the main tuning knob in this file: raise it for a more Mendelian game
// with sharper reveals, lower it for more visible variety.
const CODOMINANCE_RATIO = 1 / 3;

// Mutation: the only source of new material (§3.2), and the only way a value neither parent carries
// can enter a bloodline. Expressed per allele transmitted. A descendant draws twelve times (six
// loci, one allele from each parent), so the per-creature odds are 1 - (1 - rate)^12:
//
//     rate      per allele     per descendant
//     1/500        0.20%           2.37%
//     1/1000       0.10%           1.19%     <- default
//     1/5000       0.02%           0.24%
//
// Use mutationOdds() rather than doing that arithmetic by hand anywhere else. The default is set so
// a mutation stays "an event people talk about": roughly one descendant in eighty. Raise it and
// mutations stop being remarkable; lower it and a season may pass without anyone seeing one.
const MUTATION_RATE = 1 / 1000;

/**
 * Per-locus overrides, for when one trait should mutate at a different pace from the rest. Empty by
 * default: a uniform rate is the honest starting point, and this exists so tuning one locus never
 * requires touching breed().
 *
 * @example { Face: 1 / 300 }  faces mutate three times more often than anything else
 */
const MUTATION_RATE_BY_LOCUS = {};

/** The chance that a single descendant carries at least one mutation, at a given per-allele rate. */
function mutationOdds(rate = MUTATION_RATE, loci = LOCI.length) {
  return 1 - Math.pow(1 - rate, loci * 2);
}

// Inbreeding depression. The spec fixes one point on this line by example: "Shared grandparent.
// Offspring viability -18%." Parents sharing a single grandparent give F = 1/32, so the slope is
// 0.18 / 0.03125 = 5.76. The cap exists because §3.4 is explicit that the remedy is never to stop
// breeding — a closed line must get fragile, not sterile.
const VIABILITY_SLOPE = 5.76;
const VIABILITY_FLOOR = 0.40;

// --- the gene pool --------------------------------------------------------------------------

/**
 * Read the allele universe and the dominance order straight off the collection.
 *
 * Rank 0 is the commonest value in a locus and therefore the most dominant. Ties break on the
 * value name so two runs on the same data always agree.
 *
 * @param {Array<{attributes:Array<{trait_type:string,value:string}>}>} items the 3333 Alphas
 */
function buildGenePool(items) {
  const counts = {};
  for (const locus of LOCI) counts[locus] = new Map();
  for (const item of items) {
    for (const a of item.attributes || []) {
      const c = counts[a.trait_type];
      if (c) c.set(a.value, (c.get(a.value) || 0) + 1);
    }
  }
  const pool = { loci: LOCI.slice(), alleles: {}, rank: {}, count: {} };
  for (const locus of LOCI) {
    const sorted = [...counts[locus].entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    pool.alleles[locus] = sorted.map(([value]) => value);
    pool.count[locus] = new Map(sorted);
    pool.rank[locus] = new Map(sorted.map(([value], i) => [value, i]));
  }
  return pool;
}

/** An allele the pool has never seen sorts last, i.e. fully recessive. */
function rankOf(pool, locus, value) {
  const r = pool.rank[locus];
  const v = r ? r.get(value) : undefined;
  return v === undefined ? Number.MAX_SAFE_INTEGER : v;
}

// --- genomes --------------------------------------------------------------------------------

/**
 * An Alpha's genome: homozygous at every locus for the trait it shows on chain (rule 2 above), and
 * sexed by its ears. Nothing is invented, so two people running this on the same inscription get
 * the same genome.
 */
function genomeFromItem(item, pool) {
  const traits = {};
  for (const a of item.attributes || []) traits[a.trait_type] = a.value;
  const genes = {};
  for (const locus of LOCI) {
    const v = traits[locus];
    if (v === undefined) throw new Error(`genomeFromItem: ${item.name || 'item'} has no ${locus}`);
    genes[locus] = [v, v];
  }
  return {
    id: item.inscription_id || `alpha:${item.number}`,
    alpha: true,
    sex: traits.Ears === 'Pink' ? 'F' : 'M',
    genes,
    mother: null,
    father: null,
  };
}

/** Are these two alleles close enough in frequency that neither masks the other? */
function coDominant(pool, locus, a, b) {
  if (a === b) return false;
  const c = pool.count[locus];
  const ca = c ? c.get(a) : undefined;
  const cb = c ? c.get(b) : undefined;
  if (!ca || !cb) return false; // a mutation into unseen territory is recessive, not co-dominant
  return Math.min(ca, cb) / Math.max(ca, cb) >= CODOMINANCE_RATIO;
}

/**
 * Which of a pair is expressed (rule 1).
 *
 * The rng is per locus and derived from the genome itself, so expression is a fixed property of an
 * individual — a creature never changes appearance between two reads — while remaining a pure
 * function of data anyone can recompute.
 */
function expressedAt(pool, locus, pair, rng) {
  if (coDominant(pool, locus, pair[0], pair[1])) return rng() < 0.5 ? pair[0] : pair[1];
  return rankOf(pool, locus, pair[0]) <= rankOf(pool, locus, pair[1]) ? pair[0] : pair[1];
}

/**
 * The visible creature: what the sprite renders and what src/combos.js scores.
 * Ears follow the sex locus, which is what makes sex readable without a label (§3.1).
 */
function phenotype(genome, pool, seed = genome.id) {
  const out = {};
  for (const locus of LOCI) {
    out[locus] = expressedAt(pool, locus, genome.genes[locus], rngFromSeed(`pheno:${seed}:${locus}`));
  }
  out.Ears = genome.sex === 'F' ? 'Pink' : 'Grey';
  return out;
}

/** The pip bar's shape channel (design pass 3a): solid = homozygous, notched = heterozygous. */
function zygosity(genome, locus) {
  const [a, b] = genome.genes[locus];
  return a === b ? 'hom' : 'het';
}

/** As an attributes array, so a descendant drops straight into combos.js / rarity.js / game.js. */
function toAttributes(genome, pool, seed) {
  const p = phenotype(genome, pool, seed);
  return Object.entries(p).map(([trait_type, value]) => ({ trait_type, value }));
}

// --- breeding -------------------------------------------------------------------------------

/**
 * Meiosis at one locus: one allele from the parent, or rarely a brand new one.
 *
 * The mutation draws from the locus's own allele universe and excludes both of the parent's
 * alleles, so a mutation is always "a value present in neither parent" as §3.2 requires — it can
 * never quietly resolve to what the parent already carried.
 */
function transmit(pool, locus, pair, rng, rate, exclude) {
  const inherited = rng() < 0.5 ? pair[0] : pair[1];
  if (rate > 0 && rng() < rate) {
    // Every other value this trait can take, each equally likely — so a mutation is as able to
    // land on the rarest face in the collection as on the commonest. That is what makes mutation
    // the one route to a trait nobody in your line carries, rather than a slow drift toward the
    // average.
    //
    // `exclude` is BOTH parents' alleles at this locus, not just the transmitting one: §3.2 asks
    // for "a value present in neither parent", and a mother-side mutation that landed on something
    // the father already carries would be indistinguishable from ordinary inheritance.
    const universe = pool.alleles[locus].filter((v) => !exclude.has(v));
    if (universe.length) {
      return { allele: universe[Math.floor(rng() * universe.length)], mutated: true, replaced: inherited };
    }
  }
  return { allele: inherited, mutated: false };
}

/**
 * Produce one descendant. Deterministic in (mother, father, seed).
 *
 * Returns the genome plus the list of mutations, because a mutation is the one event in this
 * system worth surfacing to the player the moment it happens.
 *
 * @param {object} mother genome, sex 'F'
 * @param {object} father genome, sex 'M'
 * @param {string} seed   hex seed, committed then revealed like a match seed
 */
function breed(mother, father, seed, opts = {}) {
  const pool = opts.pool;
  if (!pool) throw new Error('breed: opts.pool is required (buildGenePool)');
  if (mother.sex !== 'F' || father.sex !== 'M') throw new Error('breed: needs one female and one male');
  const base = opts.mutationRate === undefined ? MUTATION_RATE : opts.mutationRate;
  const perLocus = opts.mutationRateByLocus || MUTATION_RATE_BY_LOCUS;
  const rng = rngFromSeed(seed);

  const genes = {};
  const mutations = [];
  for (const locus of LOCI) {
    const rate = perLocus[locus] === undefined ? base : perLocus[locus];
    const exclude = new Set([...mother.genes[locus], ...father.genes[locus]]);
    const m = transmit(pool, locus, mother.genes[locus], rng, rate, exclude);
    const f = transmit(pool, locus, father.genes[locus], rng, rate, exclude);
    genes[locus] = [m.allele, f.allele];
    if (m.mutated) mutations.push({ locus, value: m.allele, replaced: m.replaced, from: 'mother' });
    if (f.mutated) mutations.push({ locus, value: f.allele, replaced: f.replaced, from: 'father' });
  }

  return {
    id: opts.id || `desc:${seed.slice(0, 16)}`,
    alpha: false,
    sex: rng() < 0.5 ? 'F' : 'M',
    genes,
    mother: mother.id,
    father: father.id,
    mutations,
  };
}

// --- inbreeding (§3.4) ----------------------------------------------------------------------

/**
 * Wright's coefficient, by the standard kinship recursion rather than by enumerating paths:
 *
 *   f(x, x) = 1/2 * (1 + F_x)
 *   f(x, y) = 1/2 * (f(mother_x, y) + f(father_x, y))   x the younger of the two
 *   F_x     = f(mother_x, father_x)
 *
 * `pedigree` maps id -> { mother, father }, with founders absent or null-parented. Unknown ids are
 * treated as unrelated founders, which is the right default here: an Alpha bought yesterday has no
 * recorded ancestry and genuinely is unrelated stock.
 */
function kinship(pedigree, a, b, memo = new Map()) {
  if (!a || !b) return 0;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (memo.has(key)) return memo.get(key);

  let out;
  if (a === b) {
    out = 0.5 * (1 + inbreeding(pedigree, a, memo));
  } else {
    // Recurse on whichever is younger, so the recursion always walks up the tree.
    const [young, other] = depth(pedigree, a) >= depth(pedigree, b) ? [a, b] : [b, a];
    const p = pedigree[young];
    out = !p || (!p.mother && !p.father)
      ? 0
      : 0.5 * (kinship(pedigree, p.mother, other, memo) + kinship(pedigree, p.father, other, memo));
  }
  memo.set(key, out);
  return out;
}

/** F of an individual: the kinship of its two parents. */
function inbreeding(pedigree, id, memo = new Map()) {
  const p = pedigree[id];
  if (!p || !p.mother || !p.father) return 0;
  return kinship(pedigree, p.mother, p.father, memo);
}

const depthCache = new WeakMap();
function depth(pedigree, id) {
  let cache = depthCache.get(pedigree);
  if (!cache) { cache = new Map(); depthCache.set(pedigree, cache); }
  if (cache.has(id)) return cache.get(id);
  const p = pedigree[id];
  cache.set(id, 0); // guard against a malformed cyclic pedigree
  const d = !p || (!p.mother && !p.father)
    ? 0
    : 1 + Math.max(depth(pedigree, p.mother), depth(pedigree, p.father));
  cache.set(id, d);
  return d;
}

/**
 * The one number the player sees before confirming a pairing (§3.4): "Shared grandparent.
 * Offspring viability -18%."
 *
 * Viability is not combat power and must never become it — it is the chance the pairing produces a
 * live descendant at all, which is why §3.4 can call inbreeding a cost without breaking §4.2.
 */
function pairingReport(pedigree, motherId, fatherId) {
  const f = kinship(pedigree, motherId, fatherId);
  const penalty = Math.min(1 - VIABILITY_FLOOR, f * VIABILITY_SLOPE);
  return {
    coefficient: f,
    viability: 1 - penalty,
    penaltyPct: Math.round(penalty * 100),
    relation: describeRelation(f),
  };
}

/** Plain words for the number, because the percentage is what the player weighs, not F. */
function describeRelation(f) {
  if (f <= 0) return 'Unrelated';
  if (f >= 0.25) return 'Full siblings';
  if (f >= 0.125) return 'Half siblings';
  if (f >= 0.0625) return 'Shared grandparents';
  if (f >= 0.03125) return 'Shared grandparent';
  return 'Distantly related';
}

module.exports = {
  LOCI,
  CODOMINANCE_RATIO,
  MUTATION_RATE,
  MUTATION_RATE_BY_LOCUS,
  mutationOdds,
  VIABILITY_SLOPE,
  VIABILITY_FLOOR,
  buildGenePool,
  genomeFromItem,
  phenotype,
  zygosity,
  toAttributes,
  breed,
  kinship,
  inbreeding,
  pairingReport,
  describeRelation,
};
