'use strict';
// The 63 Runes are 9 families times 7 colours. The player learns nine effects, never sixty three:
// colour decides Tuning with the Collar and nothing else, so it never touches power.
//
// The families are named Fire and Earth, which are also House names. That collision is deliberate
// and there is deliberately NO synergy between them: a Fire rune on a Fire house does nothing
// special. A synergy would quietly penalise House Water, which has no rune family of its own.
//
// One data note that costs three cats if it is missed. Fifty five Alphas carry the rune
// "Hope Bicoin Orange", a typo in the collection for "Hope Bitcoin Orange". Parse the colour off
// the last word and those runes read as a colour called "Orange" that no collar can match, so three
// Alphas with a Bitcoin Orange collar silently lose their Tuned status. colourOf() below folds the
// typo, and keeps the original string, which is what the chain says and what must be matched on.

const COLOURS = ['Red', 'Purple', 'Yellow', 'Green', 'Blue', 'White', 'Bitcoin Orange'];

const FAMILIES = {
  Fire:      { text: 'Burn. +5 damage per turn for 2 turns.',                     fx: { burn: { amount: 5, turns: 2 } } },
  Sun:       { text: 'Heal 20 HP.',                                               fx: { heal: 20 } },
  Hope:      { text: 'Shield. Fully negates the next incoming attack.',           fx: { shield: true } },
  Ride:      { text: 'Surge. Attack twice this turn.',                            fx: { extraAttack: 1 } },
  Stone:     { text: '+4 Armor for the rest of the fight.',                       fx: { armor: 4 } },
  Earth:     { text: 'Riposte. Returns the next hit you take, in full.',          fx: { riposte: true } },
  Birch:     { text: 'Growth. +3 Force, and it stacks each time you cast it.',    fx: { force: 3 } },

  // No combat effect at all, and that is the point: it is the farmer's rune, and it makes loadout
  // a real question without adding a rule to combat.
  Wealth:    { text: 'No combat effect. Doubles every reward on victory.',        fx: { doubleRewards: true } },

  Runestone: { text: "Echo. Replays the last Rune cast, including the opponent's.", fx: { echo: true } },
};

const CHARGE_BASE = 4;   // turns
const CHARGE_TUNED = 2;

/** Split an on-chain rune name into family and colour, folding the Bicoin typo. */
function parseRune(name) {
  const s = String(name || '');
  const tail2 = s.split(' ').slice(-2).join(' ');
  if (tail2 === 'Bitcoin Orange' || tail2 === 'Bicoin Orange') {
    return { family: s.slice(0, s.length - tail2.length).trim(), colour: 'Bitcoin Orange', raw: s };
  }
  const i = s.lastIndexOf(' ');
  return i < 0 ? { family: s, colour: null, raw: s } : { family: s.slice(0, i), colour: s.slice(i + 1), raw: s };
}

const colourOf = (name) => parseRune(name).colour;
const familyOf = (name) => parseRune(name).family;
const effectOf = (name) => FAMILIES[parseRune(name).family] || null;

/** A collar and a rune are Tuned when they name the same colour. */
const isTuned = (collarName, runeName) => colourOf(runeName) === collarName;

/** Turns to charge, before any Face modifier. */
const chargeTurns = (tuned) => (tuned ? CHARGE_TUNED : CHARGE_BASE);

module.exports = {
  COLOURS, FAMILIES, CHARGE_BASE, CHARGE_TUNED,
  parseRune, colourOf, familyOf, effectOf, isTuned, chargeTurns,
};
