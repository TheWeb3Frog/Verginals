// Drawing a creature on the scene canvas, from the collection's own sprites.
//
// The art already exists: 157 webp layers under sprites/ (33 bodies, 15 collars, 2 ears, 44 faces,
// 63 runes), authored by the artist, served by the node at /sprites/<Layer>/<Name>.webp, and
// already composed for the DOM by web/adventure-art.js. Nothing here invents a cat. This module
// exists for one reason the DOM version cannot cover: the scene is a canvas, and the fight needs
// the creature to breathe, flash white on a hit, desaturate for a Flip and be swept through by a
// band of light. Those are canvas transforms over the same five images.
//
// LAYER ORDER IS NOT A CHOICE. It comes from the kit: Body, Ears, Collar, Face, Rune. The collar's
// pendant plate is opaque and two faces in forty four hang past it, so Collar under Face is what
// keeps Rainbow and Crying from rendering truncated.

import { TRAIT_LAYERS, LAYER_RECTS, spriteUrl } from '/verginals-kit.js';

export const INK = '#0E0E13';

const HOUSE_HEX = { Fire: '#E8452C', Water: '#3E8FD0', Earth: '#7FA83F' };
const COLLAR_HEX = {
  Red: '#E8452C', Purple: '#7A5CFF', Yellow: '#EFC93C', Green: '#7FA83F', Emerald: '#2FBE87',
  'Bitcoin Orange': '#F7931A', Black: '#22222C', Fuchsia: '#E040A0', 'Sea Green': '#3FBFA8',
  'Dark Grey': '#4A4C58', Lemon: '#F2E14C', Blue: '#3E8FD0', 'Sky Blue': '#6FC6EE',
  Pink: '#E87AB0', White: '#F2F0E8',
};

export const houseHex = (name) => HOUSE_HEX[name] || '#8A8C99';
export const collarHex = (name) => COLLAR_HEX[name] || '#8A8C99';
export const runeHex = (colour) => ({
  Red: '#E8452C', Purple: '#9A7CFF', Yellow: '#EFC93C', Green: '#7FA83F',
  Blue: '#4FA3E0', White: '#EFEFF8', 'Bitcoin Orange': '#F7931A',
}[colour] || '#EFEFF8');

// --- the image cache ------------------------------------------------------------------------

// One Image per layer value, kept forever. A creature is five of them and a fight redraws sixty
// times a second, so the cache is the difference between a smooth scene and a request storm.
const CACHE = new Map();
let pending = 0;

function layerImage(layer, value) {
  const key = layer + '/' + value;
  let img = CACHE.get(key);
  if (img) return img;
  img = new Image();
  img.decoding = 'async';
  pending += 1;
  img.onload = () => { img.ready = true; pending -= 1; };
  img.onerror = () => { img.failed = true; pending -= 1; };
  img.src = spriteUrl(layer, value, '/sprites');
  CACHE.set(key, img);
  return img;
}

/** Warm the cache for a creature before it has to be drawn, so it never pops in mid fight. */
export function preload(traits) {
  for (const layer of TRAIT_LAYERS) if (traits[layer]) layerImage(layer, traits[layer]);
}
export const stillLoading = () => pending > 0;

/** A fighter carries ranks; the sprites are keyed by the names the chain uses. */
export function traitsOf(f) {
  return {
    Body: f.body.name,
    Ears: f.sex === 'F' ? 'Pink' : 'Grey',
    Collar: f.collar,
    Face: f.face.name,
    Rune: f.rune,
  };
}

// --- drawing --------------------------------------------------------------------------------

const BOX = LAYER_RECTS.Body;   // 576 x 624, the frame every other rect is a fraction of

/**
 * Draw a creature centred on (x, y).
 *
 * `opts`: { size (px across the body box), breathe (phase), flash 0..1, desaturate 0..1,
 *           facing 1 | -1, hideRune }
 */
export function drawCat(ctx, f, opts = {}) {
  const { x = 0, y = 0, size: w = 140, breathe = 0, flash = 0, desaturate = 0, facing = 1, hideRune = false } = opts;
  const h = w * BOX.h / BOX.w;
  const traits = traitsOf(f);
  const grow = 1 + Math.sin(breathe) * 0.014;

  ctx.save();
  ctx.translate(x, y);

  // The House aura on the ground. It is the colour the very first fight teaches, and it is the one
  // piece of a creature the sprite sheet has no layer for, because House is not drawn on the cat.
  const hh = houseHex(f.house);
  const ag = ctx.createRadialGradient(0, h * 0.44, w * 0.04, 0, h * 0.44, w * 0.56);
  ag.addColorStop(0, hh + '4d'); ag.addColorStop(1, hh + '00');
  ctx.fillStyle = ag;
  ctx.beginPath(); ctx.ellipse(0, h * 0.44, w * 0.56, h * 0.13, 0, 0, 7); ctx.fill();

  ctx.scale(facing, 1);
  ctx.scale(grow, grow);
  if (desaturate > 0) ctx.filter = `saturate(${Math.max(0, 1 - desaturate)}) brightness(${1 - desaturate * 0.22})`;
  ctx.imageSmoothingEnabled = false;   // the art is pixel art; keep its edges

  for (const layer of TRAIT_LAYERS) {
    if (hideRune && layer === 'Rune') continue;
    const value = traits[layer];
    if (!value) continue;
    const img = layerImage(layer, value);
    if (!img.ready) continue;
    const r = LAYER_RECTS[layer] || BOX;
    ctx.drawImage(img,
      -w / 2 + (r.x / BOX.w) * w, -h / 2 + (r.y / BOX.h) * h,
      (r.w / BOX.w) * w, (r.h / BOX.h) * h);
  }

  if (flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = flash * 0.55;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.filter = 'none';
  ctx.restore();
}

/** A placeholder silhouette, for the empty Second Form frame and for art that has not loaded. */
export function drawSilhouette(ctx, x, y, w) {
  const h = w * BOX.h / BOX.w;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(157,163,180,.35)';
  ctx.setLineDash([5, 5]); ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, h * 0.10, w * 0.34, h * 0.30, 0, 0, 7);
  ctx.moveTo(-w * 0.30, -h * 0.16); ctx.lineTo(-w * 0.40, -h * 0.40); ctx.lineTo(-w * 0.10, -h * 0.30);
  ctx.moveTo(w * 0.30, -h * 0.16); ctx.lineTo(w * 0.40, -h * 0.40); ctx.lineTo(w * 0.10, -h * 0.30);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** The floating rune dial: charge as an arc, and a glow when it is ready to spend. */
export function drawRune(ctx, family, colour, x, y, s, charge01, ready) {
  const hex = runeHex(colour);
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(11,13,20,.72)';
  ctx.beginPath(); ctx.arc(0, 0, s * 0.50, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = s * 0.10;
  ctx.beginPath(); ctx.arc(0, 0, s * 0.42, 0, 7); ctx.stroke();
  ctx.strokeStyle = hex; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, s * 0.42, -Math.PI / 2, -Math.PI / 2 + Math.max(0.001, charge01) * Math.PI * 2); ctx.stroke();
  if (ready) { ctx.shadowColor = hex; ctx.shadowBlur = s * 0.4; }
  ctx.fillStyle = hex;
  ctx.font = `700 ${s * 0.34}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((family || '?').charAt(0), 0, s * 0.02);
  ctx.restore();
}
