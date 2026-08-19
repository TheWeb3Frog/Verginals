'use strict';
// The 44 Faces. A Face is a passive: it fires on its own and the player never activates one.
//
// THE RULE THIS TABLE OBEYS. An allele that can be masked is an allele you have to breed for, and
// breeding for a bigger number is a boring project. So every Face that can hide grants a RULE, and
// only Faces that cannot hide are allowed to be a flat number. The line is not a taste call: it is
// read off the collection by pool.js, and test/adventure-content.test.js fails the build if a
// hideable Face carries a flat modifier.
//
// That constraint bit hard. The first draft of this table had Super Happy at "+6 damage" against
// Happy's "+2", In Love at "+8 HP/turn" against Lover's "+3", Big Laughing at "+8" against
// Laughing's "+4": seven rare Faces that were their common cousin with the number doubled. All
// seven are rewritten below, and the ones that survived untouched (the Glasses, Old TV, the Lasers)
// are exactly the ones that were already rules.
//
// Four more were rewritten for a different reason. Grumpy/Grumpier are 98 and 84 copies, Cooler and
// Cool are 91 and 77: peers, not tiers. Presenting them as an upgrade ladder claims a rarity gap
// the data does not contain, so they are now two different rules of comparable weight.

// `kind` is checked by the test, `fx` is what the engine reads. Text is what the player sees, and
// it is the only description that ships: there is no second copy in the UI to fall out of step.
const F = (rank, name, kind, text, fx = {}) => ({ rank, name, kind, text, fx });

const FACES = [
  F(0,  'Sour',                    'rule', "Sour. The opponent's Rune needs one extra turn to charge.", { opponentRuneSlower: 1 }),

  // Roughly a fifth of the pool is deliberately blank. A game where every cat has a trick is a game
  // where no trick reads, and the Perplexed tribe is what makes the others legible.
  F(1,  'Perplexed Tiny Big Eyes', 'none', 'No passive.'),
  F(2,  'Cheeky',                  'flat', '+2 damage.', { damageBonus: 2 }),
  F(3,  'Happy Big Eyes',          'flat', '+2 damage.', { damageBonus: 2 }),
  F(4,  'Happy',                   'flat', '+2 damage.', { damageBonus: 2 }),
  F(5,  'Sleeping Tif',            'rule', 'Asleep. Skips turn 1, then +6 Force.', { skipTurn1: true, forceAfterWaking: 6 }),
  F(6,  'Lover',                   'flat', '+3 HP each turn.', { regen: 3 }),
  F(7,  'Grumpy',                  'flat', '+3 damage if you were hit last turn.', { damageBonusIfHit: 3 }),
  F(8,  'Orange Glasses',          'rule', "Glasses. You see the opponent's Second Form.", { seeSecondForm: true }),
  F(9,  'Perplexed Tif',           'none', 'No passive.'),
  F(10, 'Satisfied',               'flat', '+2 damage.', { damageBonus: 2 }),
  F(11, 'Perplexed Big Eyes',      'none', 'No passive.'),
  F(12, 'Perplexed Large',         'none', 'No passive.'),
  F(13, 'Sleepy Drool',            'rule', 'Asleep. Skips turn 1, then +6 Force.', { skipTurn1: true, forceAfterWaking: 6 }),
  F(14, 'UwU',                     'flat', '+2 damage.', { damageBonus: 2 }),

  // 3D Glasses written backwards, and it was in the artwork before any of this was designed. At 97
  // copies it is a common face, so its effect has to be strange rather than strong: useless against
  // a Perplexed, ruinous against a rare Face. It also makes a junk common the natural counter to
  // the nine-copy grail. Do not put this in the in-game help. Let it be found.
  F(15, 'sessalG D3',              'rule', 'Mirror. Face passives are swapped between both fighters for the whole fight.', { mirrorFaces: true }),

  F(16, 'Crying',                  'flat', 'Heals 4 HP each time you take damage.', { healOnDamage: 4 }),
  F(17, 'Perplexed Medium',        'none', 'No passive.'),
  F(18, 'Perplexed Small',         'none', 'No passive.'),
  F(19, 'Cooler',                  'flat', '-2 damage taken.', { damageReduction: 2 }),
  F(20, 'Stunned',                 'rule', 'The first hit you take is halved.', { firstHitTaken: 'halve' }),
  F(21, '3D Glasses',              'rule', "Glasses. You see the opponent's Second Form.", { seeSecondForm: true }),
  F(22, 'Laughing',                'flat', '+4 damage after the opponent misses.', { damageAfterMiss: 4 }),
  F(23, 'Stunned Tif',             'rule', 'The first hit you take is halved.', { firstHitTaken: 'halve' }),
  F(24, 'Happy Big Mouth',         'flat', '+2 damage.', { damageBonus: 2 }),
  F(25, 'Pink Glasses',            'rule', "Glasses. You see the opponent's Second Form.", { seeSecondForm: true }),
  F(26, 'Perplexed Tiny',          'none', 'No passive.'),

  // 84 copies against Grumpy's 98. Peers, so a different rule rather than a bigger one.
  F(27, 'Grumpier',                'rule', 'Grudge. The first fighter to hit you loses 2 Force for the rest of the fight.', { grudge: 2 }),

  F(28, 'Sky Blue Glasses',        'rule', "Glasses. You see the opponent's Second Form.", { seeSecondForm: true }),
  F(29, 'Happy Tif',               'flat', '+2 damage.', { damageBonus: 2 }),

  // 77 against Cooler's 91. Immunity to the arena is the counter to the four Backgrounds that have
  // a rule at all, which makes Cool a pre-combat answer rather than a slightly better Cooler.
  F(30, 'Cool',                    'rule', 'Unbothered. Arena rules do not apply to you.', { arenaImmune: true }),

  // Initiative decides who imposes the arena, so this is the one Face that reaches into team
  // composition. It beats a Tuned collar, and Cow's Placid beats it back.
  F(31, 'Shiny Eyes Happy',        'rule', 'Wide awake. You act first, whatever the collars say.', { alwaysFirst: true }),

  F(32, 'Shiny Eyes Drool',        'rule', "Dreaming. Skips turn 1, then copies the opponent's Face for the rest of the fight.", { skipTurn1: true, copyFaceOnWaking: true }),
  F(33, 'Rainbow Glasses',         'rule', "Prism lenses. You see the opponent's entire genome.", { seeGenome: true }),

  // --- from here down, every Face can be masked, so every Face is a rule -----------------------

  F(34, 'Big Laughing',            'rule', 'Infectious. When the opponent misses, they miss their next attack too.', { contagiousMiss: true }),
  F(35, 'Double Shocked',          'rule', "Both fighters' first attack of the fight misses.", { bothMissFirst: true }),
  F(36, 'In Love',                 'rule', 'Devotion. The first time you would fall, you stand at 1 HP instead.', { standAtOne: true }),
  F(37, 'Cyber Punk',              'rule', 'Your Rune charges one turn faster.', { runeChargeFaster: 1 }),
  F(38, 'Lazer',                   'rule', 'Ignores Armor.', { ignoreArmor: true }),
  F(39, 'Super Happy',             'rule', 'Nothing sticks. Burn, Poison and Static expire on you immediately.', { nothingSticks: true }),
  F(40, 'Demon',                   'rule', 'Below 40% HP, the arena becomes your Background for the rest of the fight.', { arenaBecomesMineBelow: 0.40 }),
  F(41, 'Super Laser',             'rule', 'Ignores Armor and Shields.', { ignoreArmor: true, ignoreShield: true }),
  F(42, 'Old TV',                  'rule', "Static. The opponent's Rune misfires: it resolves as a random family instead of its own.", { staticRune: true }),

  // Nine copies. The triangle is the first thing the game teaches and the last thing this removes.
  F(43, 'Rainbow',                 'rule', 'Prism. The House triangle does not apply to you: every matchup is favourable.', { prism: true }),
];

const BY_NAME = new Map(FACES.map((f) => [f.name, f]));
const faceAt = (rank) => FACES[rank];
const faceNamed = (name) => BY_NAME.get(name) || null;

module.exports = { FACES, faceAt, faceNamed };
