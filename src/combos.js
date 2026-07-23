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
//   - Both rainbow elements together (a Rainbow-ish face + a Spectrum background) = "Double
//     Rainbow", +80.
//   - Curated perfect pair (a background and body drawn to match): Pink Sky + Harlequin Pink, +25.

const POINTS = { 2: 5, 3: 20, 4: 60, doubleRainbow: 80, perfectPair: 25 };

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
function slotColors(m) {
  return [
    BACKGROUND[m.Background] || [],
    BODY[m.Body] || [],
    COLLAR[m.Collar] || [],
    runeColors(m.Rune),
    FACE[m.Face] || [],
  ];
}

/** Largest number of slots sharing one color family. Returns { level, color }. */
function bestMatch(slots) {
  const count = {};
  for (const colors of slots) for (const c of new Set(colors)) if (c !== 'rainbow') count[c] = (count[c] || 0) + 1;
  let level = 1;
  let color = null;
  for (const [c, k] of Object.entries(count)) if (k > level) { level = k; color = c; }
  return { level, color };
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
 * Combo bonus for one item: { points, badges }. Points stack (a Double Rainbow can also match a
 * color); badges start at a 3-color match (a 2-match is common, so it earns points but no badge).
 */
function comboBonus(item) {
  const m = attrs(item);
  const slots = slotColors(m);
  const match = bestMatch(slots);
  const rainbow = rainbowElements(m);
  const badges = [];
  let points = 0;

  if (match.level >= 2) points += POINTS[match.level] || 0;
  if (match.level === 3) badges.push(`Chromatic ${cap(match.color)}`);
  if (match.level >= 4) badges.push(`Prismatic ${cap(match.color)}`);
  if (rainbow >= 2) { points += POINTS.doubleRainbow; badges.push('Double Rainbow'); }
  if (isPerfectPair(m)) { points += POINTS.perfectPair; badges.push('Perfect Pair'); }

  return { points, badges };
}

module.exports = { comboBonus, POINTS };
