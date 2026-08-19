'use strict';
// The 32 Bodies. A Body is the stat block: HP, Force, Armor, plus at most one extra rule.
//
// THE BUDGET. Raw stats are scored HP + 4*Force + 9*Armor, and the extra rule is priced too, because
// a table that only budgets the numbers will always drift: the first draft rated Harlequin Monster
// the weakest body in the game at 114 while handing it uncapped Force growth, which over an average
// five turn fight is worth more than any stat line on the list. Rules now carry a `worth`, the test
// checks stats + worth, and Monster's growth is capped at +10 so the price is a fact and not a guess.
//
// Oreo also moved. It sat at 158, the highest budget of the 32, on Armor 6, which is punishing
// against the low Force bodies and invisible against the high ones. Armor 5 and 58 HP puts it at
// the top of the band instead of outside it.
//
// The 17 solid colours share one line on purpose. They are 52% of the collection and they are the
// baseline every rule is read against; giving each its own spread would be 17 numbers to learn for
// no decision gained.

const { POOL } = require('./pool');

const B = (rank, name, hp, force, armor, rule = null) => ({
  rank, name, hp, force, armor,
  rule,                                    // { text, worth, fx }
  budget: hp + 4 * force + 9 * armor + (rule ? rule.worth : 0),
});

// Rule prices, in budget points, stated once so they can be argued with.
//   14  a free Rune cast, or a free extra action
//   12  a per-turn drain or a free Flip
//   10  reactive damage
//    8  an unmissable opener
//    6  a narrow immunity, or a conditional reduction
//    5  a heal that depends on the opponent's choice
//    0  variance with no expected gain
//   -8  a permanent downside
const R = (text, worth, fx) => ({ text, worth, fx });

const SOLID = POOL.Body.names.slice(0, 17);

const BODIES = [
  ...SOLID.map((name, i) => B(i, name, 60, 13, 3)),

  B(17, 'Bengal',              52, 16, 2),
  B(18, 'Tortie',              66, 11, 4),

  // --- from here down, every Body can be masked, so every Body carries a rule ------------------

  B(19, 'Harlequin Cream',     58, 14, 2, R('Your first Rune each fight charges instantly.', 14, { firstRuneFree: true })),
  B(20, 'Harlequin Ginger',    58, 14, 2, R('Afterimage. The turn after you Flip, you act twice.', 14, { doubleTurnAfterFlip: true })),
  B(21, 'Light Calico',        66, 10, 4, R('Heals 5 HP when the opponent Flips.', 5, { healOnOpponentFlip: 5 })),
  B(22, 'Harlequin Earth',     62, 12, 3, R('Immune to Burn.', 6, { immuneBurn: true })),
  B(23, 'Harlequin Pink',      56, 15, 2, R('Flip costs no turn.', 12, { freeFlip: true })),
  B(24, 'Tiger',               40, 20, 1, R('Pounce. Your first attack cannot miss and cannot be shielded.', 8, { unmissableOpener: true })),
  B(25, 'Oreo',                58, 10, 5, R('Layered. The first attack against you each turn is reduced by 4.', 6, { firstAttackPerTurnReduction: 4 })),
  B(26, 'Harlequin Lava',      54, 15, 2, R('Burns anyone who hits you: 3 damage per turn for 1 turn.', 10, { burnAttacker: { amount: 3, turns: 1 } })),

  // 90 HP has to cost something, and losing the arena is a real cost rather than a smaller number.
  B(27, 'Cow',                 90,  8, 3, R('Placid. You never act first, whatever the collars say.', -8, { neverFirst: true })),

  B(28, 'Harlequin Lime',      56, 13, 3, R('Regenerates 3 HP per turn.', 12, { regen: 3 })),
  B(29, 'Harlequin Monster',   48, 12, 2, R('+2 Force every turn, up to +10.', 20, { forcePerTurn: 2, forceCap: 10 })),
  B(30, 'Harlequin Poison',    50, 13, 3, R('Poisons on contact: every hit landed on you costs the attacker 2 Force.', 12, { poisonAttacker: 2 })),

  // Ten copies, and deliberately unplayable in a planned way. Do not smooth this.
  B(31, 'Harlequin Lava Lamp', 60, 13, 3, R('All three stats reroll by up to 40% each turn.', 0, { rerollStats: 0.40 })),
];

const BY_NAME = new Map(BODIES.map((b) => [b.name, b]));
const bodyAt = (rank) => BODIES[rank];
const bodyNamed = (name) => BY_NAME.get(name) || null;

module.exports = { BODIES, bodyAt, bodyNamed };
