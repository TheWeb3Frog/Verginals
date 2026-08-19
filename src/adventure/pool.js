'use strict';
// The allele pool: ranks, co-dominance windows, expression and Second Form.
//
// One rule produces all of it. Two alleles at a locus are co-dominant when the rarer is at least a
// third as common as its partner; below that the commoner one is expressed and the rarer is carried
// invisibly. Nothing here is hand authored, so extending the collection cannot leave a stale table
// behind, and the numbers agree with src/genetics.js by construction rather than by review.
//
// Ranks run 0 (commonest) upward, ties broken on the name so two runs on the same data agree. That
// ordering is also the dominance order: outside its window, an allele is masked by every lower rank
// and masks every higher one.

const { TOTAL, COUNTS, EARS } = require('./counts.gen');

const LOCI = ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House'];
const CODOMINANCE_RATIO = 1 / 3;

function build() {
  const out = {};
  for (const locus of LOCI) {
    const sorted = Object.entries(COUNTS[locus])
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const names = sorted.map(([v]) => v);
    const counts = sorted.map(([, c]) => c);
    const n = names.length;

    // The window is the contiguous run of ranks this allele does not mask and is not masked by.
    // Contiguity is a property of a descending-sorted list, not an assumption: if j is inside the
    // window and k lies between i and j, then count[k] is between them too, so k is inside as well.
    const windows = counts.map((c, i) => {
      let lo = i, hi = i;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = counts[j];
        if (Math.min(c, d) / Math.max(c, d) >= CODOMINANCE_RATIO) { lo = Math.min(lo, j); hi = Math.max(hi, j); }
      }
      return [lo, hi];
    });

    out[locus] = { names, counts, windows, n, index: new Map(names.map((v, i) => [v, i])) };
  }
  return out;
}

const POOL = build();

/** Rank of a named allele, or -1. Names come off chain, so an unknown one must not throw. */
function rankOf(locus, name) {
  const L = POOL[locus];
  const i = L ? L.index.get(name) : undefined;
  return i === undefined ? -1 : i;
}

function nameOf(locus, rank) { return POOL[locus].names[rank]; }
function countOf(locus, rank) { return POOL[locus].counts[rank]; }
function sizeOf(locus) { return POOL[locus].n; }
function windowOf(locus, rank) { return POOL[locus].windows[rank]; }

/** Are these two ranks close enough in frequency that neither masks the other? */
function coDominant(locus, r1, r2) {
  if (r1 === r2) return false;
  const [lo, hi] = POOL[locus].windows[r1];
  return r2 >= lo && r2 <= hi;
}

// --- expression -----------------------------------------------------------------------------

// A small non-cryptographic hash. Expression must be identical on the client and the server, so it
// cannot depend on anything platform specific, and it runs on every locus of every visible creature
// so it must be cheap. FNV-1a over the string, which is deterministic everywhere.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which of a pair is expressed, and which is held back as Second Form.
 *
 * The draw for a co-dominant pair is seeded on the individual, so a creature never changes
 * appearance between two reads, and two full siblings with identical genomes can still express
 * differently because their ids differ. The pair itself is in the seed, so adding a locus later
 * cannot reshuffle the expression of the ones already decided.
 */
function express(locus, r1, r2, individualSeed) {
  if (r1 === r2) return { rank: r1, second: r1, mode: 'homozygous' };
  const lo = Math.min(r1, r2), hi = Math.max(r1, r2);
  if (coDominant(locus, r1, r2)) {
    const pick = (hash32(`${individualSeed}|${locus}|${lo}|${hi}`) & 1) ? hi : lo;
    return { rank: pick, second: pick === lo ? hi : lo, mode: 'codominant' };
  }
  // Masked: the commoner allele is the lower rank, and it always wins.
  return { rank: lo, second: hi, mode: 'masked' };
}

/** The visible creature, plus the form it would take on a Flip. */
function phenotype(genome, individualSeed) {
  const first = {}, second = {}, mode = {};
  for (const locus of LOCI) {
    const [a, b] = genome[locus];
    const e = express(locus, a, b, individualSeed);
    first[locus] = e.rank; second[locus] = e.second; mode[locus] = e.mode;
  }
  return { first, second, mode };
}

/** A founder shows what it is: homozygous everywhere, so it has no Second Form and cannot Flip. */
function canFlip(genome) {
  return LOCI.some((locus) => genome[locus][0] !== genome[locus][1]);
}

/** Names rather than ranks, for anything that has to be read by a person. */
function readable(form) {
  const out = {};
  for (const locus of LOCI) out[locus] = nameOf(locus, form[locus]);
  return out;
}

module.exports = {
  TOTAL, EARS, LOCI, CODOMINANCE_RATIO, POOL,
  rankOf, nameOf, countOf, sizeOf, windowOf,
  coDominant, hash32, express, phenotype, canFlip, readable,
};
