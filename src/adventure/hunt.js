'use strict';
// Hunt mode: a small node graph, a stamina budget, and a way home.
//
// The one rule that matters here is negative. Wild Alphas draw their alleles at exact collection
// frequency and ADVANCED BIOMES NEVER CHANGE THAT. Biasing the wild pool toward rare alleles is the
// single easiest way to destroy this game: it turns the grail hunt from a season into a week, and
// every hidden allele in the vivarium stops being worth carrying. Difficulty scales on bot tier,
// wild Vigor and fights per run, all of which sit outside the genetic economy.
//
// The Strand is the other half of that bargain. A wild Alpha drops one, the PLAYER chooses which
// locus it samples, and the game returns one of the wild's two alleles at that locus. Choosing is
// not a convenience: with a random locus a large share of players never converge on a grail at all,
// because the reward has a tail longer than anyone's patience.

const { LOCI, POOL, sizeOf, nameOf } = require('./pool');
const { createFighter } = require('./combat');

const STAMINA_PER_ALPHA = 8;
const WATER_PER_ALPHA = 12;

const NODE_TABLE = [
  { type: 'dew',     weight: 15, water: 4 },
  { type: 'pool',    weight: 12, water: 8 },
  { type: 'spring',  weight: 8,  water: 14 },
  { type: 'seeds',   weight: 20 },
  { type: 'nubbin',  weight: 12 },
  { type: 'glim',    weight: 8 },
  { type: 'wild',    weight: 20 },
  { type: 'empty',   weight: 5 },
];

function draw(seed, label) {
  let h = 0x811c9dc5;
  const s = `${seed}|${label}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 8) / 0x1000000;
}

function pickWeighted(table, r) {
  const total = table.reduce((s, x) => s + x.weight, 0);
  let acc = 0, target = r * total;
  for (const x of table) { acc += x.weight; if (target < acc) return x; }
  return table[table.length - 1];
}

/** Draw one allele at exact collection frequency. Never biased, at any biome, ever. */
function drawByFrequency(locus, r) {
  const counts = POOL[locus].counts;
  const total = counts.reduce((s, c) => s + c, 0);
  let acc = 0, target = r * total;
  for (let i = 0; i < counts.length; i++) { acc += counts[i]; if (target < acc) return i; }
  return counts.length - 1;
}

/**
 * A wild Alpha. Always a hybrid, which is how the player first sees a Flip happen at all, and how
 * they learn that the padlocked button on their own founder is a thing worth breeding for.
 */
function generateWild(seed, index, { vigor = 100, tier = 1 } = {}) {
  const genome = {};
  for (const locus of LOCI) {
    let a = drawByFrequency(locus, draw(seed, `w${index}:${locus}:a`));
    let b = drawByFrequency(locus, draw(seed, `w${index}:${locus}:b`));
    if (a === b) b = (b + 1) % sizeOf(locus);   // hybrid by construction
    genome[locus] = [a, b];
  }
  const f = createFighter({ id: `wild:${seed}:${index}`, name: 'Wild Alpha', genome, vigor, catnip: 1 });
  f.tier = tier;
  return f;
}

/** The map for one run. Procedural, seeded, and small enough to read in one glance. */
function generateHunt(seed, { nodes = 12, party = 1, biome = 'starter', tier = 1, wildVigor = 100, firstEver = false } = {}) {
  const list = [];
  for (let i = 0; i < nodes; i++) {
    // The first hunt is the bootstrap and it is scripted, because the vivarium starts as empty dirt
    // and a player who draws four Empty nodes has no game to come back to.
    // Stamina is 8 for a solo party, so the bootstrap has to deliver inside eight visits, not
    // twelve. A nest holds two Nubbins and a shoal three Glims on this run only.
    const forced = firstEver ? ['dew', 'seeds', 'nubbin', 'wild', 'pool', 'nubbin', 'glim', 'seeds', 'dew', 'nubbin', 'glim', 'spring'][i] : null;
    const t = forced ? NODE_TABLE.find((x) => x.type === forced) : pickWeighted(NODE_TABLE, draw(seed, `node:${i}`));
    list.push({
      index: i, type: t.type, water: t.water || 0, visited: false,
      seeds: t.type === 'seeds' ? (firstEver ? 3 : 1 + Math.floor(draw(seed, `seeds:${i}`) * 3)) : 0,
      wild: t.type === 'wild' ? { seed, index: i, tier, vigor: wildVigor } : null,
      yield: firstEver ? (t.type === 'nubbin' ? 2 : t.type === 'glim' ? 3 : 1) : 1,
    });
  }
  return {
    seed, biome, nodes: list, at: 0,
    stamina: STAMINA_PER_ALPHA * party,
    waterCap: WATER_PER_ALPHA * party,
    bag: { water: 0, seeds: 0, nubbins: 0, glims: 0, strands: [] },
    over: false,
  };
}

/** Move to a node and collect it. Costs one stamina; returns what happened. */
function visit(hunt, index) {
  if (hunt.over) return { error: 'the run is over' };
  const node = hunt.nodes[index];
  if (!node) return { error: 'no such node' };
  if (node.visited) return { error: 'already visited' };
  if (hunt.stamina <= 0) return { error: 'out of stamina' };

  hunt.stamina -= 1;
  node.visited = true;
  hunt.at = index;
  const got = { type: node.type };

  if (node.water) { const room = hunt.waterCap - hunt.bag.water; got.water = Math.min(node.water, room); hunt.bag.water += got.water; }
  if (node.seeds) { hunt.bag.seeds += node.seeds; got.seeds = node.seeds; }
  const many = node.yield || 1;
  if (node.type === 'nubbin') { hunt.bag.nubbins += many; got.nubbins = many; }
  if (node.type === 'glim') { hunt.bag.glims += many; got.glims = many; }
  if (node.type === 'wild') got.wild = generateWild(node.wild.seed, node.wild.index, { vigor: node.wild.vigor, tier: node.wild.tier });

  if (hunt.stamina <= 0) hunt.over = true;
  return got;
}

/**
 * Take a Strand off a defeated wild. The player names the locus; the game returns one of the two
 * alleles that wild carried there, at random. Single use.
 */
function takeStrand(hunt, wild, locus, seedSalt = '') {
  if (!LOCI.includes(locus)) return { error: 'not a locus' };
  const pair = wild.genome[locus];
  const rank = draw(`${wild.id}|${seedSalt}`, `strand:${locus}`) < 0.5 ? pair[0] : pair[1];
  const strand = { locus, rank, name: nameOf(locus, rank), from: wild.id };
  hunt.bag.strands.push(strand);
  return strand;
}

module.exports = {
  STAMINA_PER_ALPHA, WATER_PER_ALPHA, NODE_TABLE,
  draw, drawByFrequency, generateWild, generateHunt, visit, takeStrand,
};
