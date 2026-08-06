'use strict';
// A synthetic Alpha collection for tests.
//
// verginals/metadata.json is gitignored — the real trait dump is served from the live API rather
// than shipped, to keep clones small — so nothing in the suite may depend on it being present.
// test/mint.test.js already establishes the convention: synthesise a collection, do not read the
// dump. This module is that convention, shared.
//
// It reproduces the three structural facts the game's rules actually rest on:
//
//   - Ears is exactly two values, near 50/50. It is the sex locus (§3.1), not a trait.
//   - The three Houses are exactly equal, which is what makes them co-dominant (§4.5) and stops
//     any element getting a permanent edge in a three-way combat cycle.
//   - Every other locus has a long tail: a few common values and some rare ones, so recessives
//     genuinely hide and the grail hunt has something to converge on (§3.3).
//
// Trait VALUES are real names from the collection, so a fixture creature can be rendered from the
// sprite files that ship in sprites/.

const BACKGROUND = ['Blue', 'Red', 'Grey', 'Pink Sky', 'Night Sky', 'Spectrum'];
const BODY = ['Ginger', 'Grey', 'Blue', 'Dark Grey', 'Bitcoin Orange', 'Harlequin Poison'];
const COLLAR = ['Red', 'Blue', 'Black', 'White', 'Emerald'];
const FACE = ['Happy', 'Cool', 'Grumpy', 'Sour', 'Lazer', 'Rainbow'];
const RUNE = ['Birch White', 'Fire Red', 'Earth Blue', 'Ride Red', 'Sun Red', 'Hope Green'];
const HOUSES = ['Fire', 'Water', 'Earth'];

// Weights give each locus a real frequency gradient: the last value in each list is the rare one,
// well under the co-dominance ratio, so it behaves as a recessive the way Rainbow does for real.
const WEIGHTS = [30, 22, 16, 11, 7, 2];

function pick(list, i) {
  const weights = WEIGHTS.slice(0, list.length);
  const total = weights.reduce((a, b) => a + b, 0);
  let n = (i * 37) % total;
  for (let k = 0; k < list.length; k++) {
    if (n < weights[k]) return list[k];
    n -= weights[k];
  }
  return list[list.length - 1];
}

/**
 * @param {number} [size] how many Alphas. The default is small enough to be fast and large enough
 *   that every locus sees its rare value at least once.
 */
function buildCollection(size = 360) {
  const items = [];
  for (let i = 1; i <= size; i++) {
    items.push({
      number: i,
      name: `Verginals #${i}`,
      inscription_id: null,
      attributes: [
        { trait_type: 'Background', value: pick(BACKGROUND, i) },
        { trait_type: 'Body', value: pick(BODY, i * 3) },
        { trait_type: 'Collar', value: pick(COLLAR, i * 5) },
        { trait_type: 'Ears', value: i % 2 ? 'Pink' : 'Grey' },   // the sex locus, exactly 50/50
        { trait_type: 'Face', value: pick(FACE, i * 7) },
        { trait_type: 'Rune', value: pick(RUNE, i * 11) },
        { trait_type: 'House', value: HOUSES[i % 3] },            // exactly equal thirds
      ],
    });
  }
  return items;
}

/** The real dump when a developer has it, otherwise null. Never required by a test to pass. */
function realCollection() {
  try {
    // eslint-disable-next-line global-require
    return require('../../verginals/metadata.json');
  } catch (_) {
    return null;
  }
}

module.exports = { buildCollection, realCollection, BACKGROUND, BODY, COLLAR, FACE, RUNE, HOUSES };
