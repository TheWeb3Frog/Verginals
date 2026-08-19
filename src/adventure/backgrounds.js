'use strict';
// The 21 Backgrounds. The Background of whoever holds initiative becomes the arena for the whole
// fight, so this is a decision made before the fight starts (which cat do I send?) and never during
// it. That is where the complexity belongs: team composition costs the player no reading time.
//
// Seventeen of the twenty-one are decor. Only the three that can be masked carry a rule, plus Night
// Sky, which sits one rank above the line and is the tutorial's way of showing that arenas exist at
// all before any of them matters.

const { POOL } = require('./pool');

const G = (rank, name, text, fx = {}) => ({ rank, name, text, fx, decor: !Object.keys(fx).length });

const PLAIN = POOL.Background.names.slice(0, 17);

const BACKGROUNDS = [
  ...PLAIN.map((name, i) => G(i, name, 'Decor. No arena rule.')),

  G(17, 'Night Sky', 'Both sides miss one attack in six.', { missChance: 1 / 6 }),
  G(18, 'Punk',      'All damage varies by up to 50%.',    { damageVariance: 0.50 }),
  G(19, 'Zombie',    'Nobody can die during the first two turns.', { noDeathBefore: 3 }),

  // Paired with a Rainbow face this is the strongest cat in the game, and not one number was
  // written for it. It is the sum of two rules that were already there.
  G(20, 'Spectrum',  'Only the side that imposed the arena keeps its Face passive.', { imposerKeepsFace: true }),
];

const BY_NAME = new Map(BACKGROUNDS.map((b) => [b.name, b]));
const backgroundAt = (rank) => BACKGROUNDS[rank];
const backgroundNamed = (name) => BY_NAME.get(name) || null;

module.exports = { BACKGROUNDS, backgroundAt, backgroundNamed };
