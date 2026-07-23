'use strict';
// Verginals combo bonuses: fixed points layered on top of the statistical rarity (src/rarity.js).
// The trait-by-trait math stays the backbone; combos reward the visual coherence it cannot see.
// Passed to computeRarity as { bonusFor: comboBonus }.
//
// Rules (curated with the artist):
//   - Tones of one color read as that color: grey / dark grey / black are all "grey", cream /
//     beige / sand / au lait are "white", etc.
//   - Patterned bodies show every color they carry: Harlequin Lava is red AND orange, so it can
//     complete a red match OR an orange match. Ears are ignored (they are near 50/50 noise).
//   - Color-match points: 2 slots = +5, 3 = +20 (badge "Chromatic"), 4 = +60 (badge "Prismatic").
//   - Monochrome (+60): every color slot is neutral (grey/white/black), so the piece reads as one
//     black-and-white look even across two neutral families.
//   - Duotone (+50): two vivid colors coordinated at once (one on 3+ slots, another on 2+).
//   - Tailored (+10): the Collar, Body and Rune all share a color, a clean deliberate set.
//   - Double Rainbow (+80): a Rainbow-ish face together with a Spectrum background.
//   - Perfect Pair (+25): a curated background/body drawn to match (Pink Sky + Harlequin Pink).

const POINTS = {
  2: 5, 3: 20, 4: 60, // color matches: pair, Chromatic, Prismatic
  monochrome: 60,     // every color slot is neutral (grey/white/black), read as one black-and-white look
  duotone: 50,        // two vivid colors coordinated at once (one on 3+ slots, another on 2+)
  tailored: 10,       // the Collar, Body and Rune all share a color (a clean, deliberate set)
  doubleRainbow: 80, perfectPair: 25,
};
// Neutrals read as one "black and white" family (black already folds to grey in the maps above).
const NEUTRAL = new Set(['grey', 'white']);

// Each slot maps a trait value to the set of color families it shows (empty = no dominant color).
const BACKGROUND = {
  Purple: ['purple'], Yellow: ['yellow'], Black: ['grey'], Grey: ['grey'], Red: ['red'],
  'Cool Green': ['green'], 'Sky Blue': ['blue'], Blue: ['blue'], Pink: ['pink'], Lemon: ['yellow'],
  'Blue Sky': ['blue'], 'Pink Sky': ['pink'], Emerald: ['green'], Fuchsia: ['pink'], 'Sea Green': ['green'],
  'Bitcoin Orange': ['orange'], 'Night Sky': ['grey', 'white'], Zombie: ['green'], Spectrum: ['rainbow'],
  Punk: ['purple', 'orange', 'green'], Blocks: [],
};
const BODY = {
  'Harlequin Lava': ['red', 'orange'], 'Harlequin Cream': ['white'], Chocolate: ['brown'],
  'Harlequin Ginger': ['orange', 'grey'], Bengal: ['grey'], Burmilla: ['grey', 'white'],
  'Harlequin Earth': ['blue', 'green'], 'Harlequin Lava Lamp': ['yellow', 'red'],
  'Light Calico': ['white', 'orange', 'grey'], 'Harlequin Pink': ['pink', 'white'], Tortie: ['orange', 'grey'],
  Cow: ['white', 'grey'], Tiger: ['white', 'orange', 'grey'], 'Harlequin Monster': ['blue', 'purple'],
  Oreo: ['white', 'grey'], 'Harlequin Poison': ['purple', 'orange'], 'Harlequin Lime': ['green', 'yellow'],
  Sand: ['white'], 'Dark Grey': ['grey'], Grey: ['grey'], Brown: ['brown'], Green: ['green'], Ginger: ['orange'],
  'Bitcoin Orange': ['orange'], White: ['white'], Caramel: ['orange'], Yellow: ['yellow'], Red: ['red'],
  'Au Lait': ['white'], Cream: ['white'], Blue: ['blue'], Pink: ['pink'],
};
const COLLAR = {
  Red: ['red'], Purple: ['purple'], Yellow: ['yellow'], Green: ['green'], Emerald: ['green'],
  'Bitcoin Orange': ['orange'], Black: ['grey'], Fuchsia: ['pink'], 'Sea Green': ['green'], 'Dark Grey': ['grey'],
  Lemon: ['yellow'], Blue: ['blue'], 'Sky Blue': ['blue'], Pink: ['pink'], White: ['white'],
};
const FACE = {
  Rainbow: ['rainbow'], 'Rainbow Glasses': ['rainbow'], 'Old TV': ['rainbow'],
  Lover: ['red'], Lazer: ['red'], 'Super Laser': ['red'],
  'Orange Glasses': ['orange'], 'Pink Glasses': ['pink'], 'Sky Blue Glasses': ['blue'],
  '3D Glasses': ['red', 'blue'], 'sessalG D3': ['red', 'blue'],
  Cooler: ['grey'], Cool: ['grey'], Crying: ['blue'], 'Cyber Punk': ['green'],
};

function runeColors(value) {
  const t = String(value || '').split(' ');
  if (t.slice(-2).join(' ') === 'Bitcoin Orange') return ['orange'];
  const map = { Blue: 'blue', Red: 'red', Green: 'green', Yellow: 'yellow', Purple: 'purple', White: 'white' };
  const c = map[t[t.length - 1]];
  return c ? [c] : [];
}

function attrs(item) {
  const m = {};
  for (const a of item.attributes || []) if (a && a.trait_type) m[a.trait_type] = String(a.value);
  return m;
}

/** The color families shown by each color-bearing slot (Background, Body, Collar, Rune, Face). */
/** Map every color family to the SET of slot names showing it (a bicolor slot appears under each). */
function colorsBySlot(m) {
  const slots = {
    Background: BACKGROUND[m.Background] || [],
    Body: BODY[m.Body] || [],
    Collar: COLLAR[m.Collar] || [],
    Rune: runeColors(m.Rune),
    Face: FACE[m.Face] || [],
  };
  const by = {}; // color -> Set(slotName)
  for (const [name, colors] of Object.entries(slots)) {
    for (const c of new Set(colors)) if (c !== 'rainbow') (by[c] || (by[c] = new Set())).add(name);
  }
  return by;
}

/** How many of the two rainbow elements are present (Rainbow-ish face + Spectrum background). */
function rainbowElements(m) {
  let n = 0;
  if (m.Face === 'Rainbow' || m.Face === 'Rainbow Glasses' || m.Face === 'Old TV') n += 1;
  if (m.Background === 'Spectrum') n += 1;
  return n;
}

/** Curated pairs drawn to match perfectly. */
function isPerfectPair(m) {
  return m.Background === 'Pink Sky' && m.Body === 'Harlequin Pink';
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Combo bonus for one item: { points, badges }.
 *
 * One primary color-coordination badge (strongest wins): Prismatic (4 slots one vivid color) >
 * Monochrome (all-neutral, 3+ slots) > Duotone (two vivid colors coordinated at once) > Chromatic
 * (3 slots one color) > a plain 2-match (points, no badge). On top of it, a Tailored bonus when the
 * Collar, Body and Rune share a color, and two independent axes (Double Rainbow, Perfect Pair).
 */
function comboBonus(item) {
  const m = attrs(item);
  const by = colorsBySlot(m);
  const counts = Object.entries(by).map(([c, set]) => [c, set.size]).sort((a, b) => b[1] - a[1]);
  const colors = Object.keys(by);
  const top = counts[0] || [null, 1];
  const level = top[1] >= 2 ? top[1] : 1;

  const neutralSlots = new Set([...(by.grey || []), ...(by.white || [])]);
  const monochrome = colors.length > 0 && colors.every((c) => NEUTRAL.has(c)) && neutralSlots.size >= 3;
  const vivid = counts.filter(([c]) => !NEUTRAL.has(c));
  const duotone = vivid.length >= 2 && vivid[0][1] >= 3 && vivid[1][1] >= 2;
  const tailored = Object.values(by).some((set) => set.has('Collar') && set.has('Body') && set.has('Rune'));

  const badges = [];
  let points = 0;

  // Primary color-coordination badge (exactly one).
  if (level >= 4) { points += POINTS[4]; badges.push(`Prismatic ${cap(top[0])}`); }
  else if (monochrome) { points += POINTS.monochrome; badges.push('Monochrome'); }
  else if (duotone) { points += POINTS.duotone; badges.push(`Duotone ${cap(vivid[0][0])}/${cap(vivid[1][0])}`); }
  else if (level === 3) { points += POINTS[3]; badges.push(`Chromatic ${cap(top[0])}`); }
  else if (level === 2) { points += POINTS[2]; }

  // Add-on and independent axes.
  if (tailored) { points += POINTS.tailored; badges.push('Tailored'); }
  if (rainbowElements(m) >= 2) { points += POINTS.doubleRainbow; badges.push('Double Rainbow'); }
  if (isPerfectPair(m)) { points += POINTS.perfectPair; badges.push('Perfect Pair'); }

  return { points, badges };
}

module.exports = { comboBonus, POINTS };
