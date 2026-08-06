// The art layer: everything in the kit that draws.
//
// This file exists because the kit was being used as a colour swatch. It ships 35 sprites as
// 16-character row arrays, 31 palettes, three renderers and five two-frame effects, and the design
// review is explicit about how to call them:
//
//   import { SPRITES, PALETTES, toCanvas } from './verginals-kit.js';
//   const c = toCanvas(SPRITES.fireBadge, PALETTES.fire, 4); // 64x64, crisp
//
// Nothing is a bitmap until you ask for one, so every sprite is drawn at an integer scale and never
// resampled. Keep it that way: a fractional scale puts grey between the pixels and the whole look
// goes with it.

import {
  PALETTE, PALETTES, SPRITES, EFFECTS, toCanvas,
} from './verginals-kit.js';

const P = PALETTE;

// Effects sit above the creature and below the UI, at the anchor the design review specifies:
// chest for the elemental hits and poison, feet for Earth, head for the potion. Expressed as a
// fraction of the creature box so it holds at any size.
const ANCHOR_Y = { head: 0.14, chest: 0.42, feet: 0.74 };

// A player who has asked their system for less motion gets the last frame and no loop. The effect
// still reads, it just does not move.
const stillPlease = () => window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One sprite, as a canvas. `paletteKey` names an entry in the kit's PALETTES.
 *
 * Scale is an integer count of screen pixels per sprite pixel, so a 16x16 sprite at scale 3 is 48px.
 */
export function sprite(name, paletteKey, scale = 3) {
  const rows = SPRITES[name];
  const pal = PALETTES[paletteKey];
  if (!rows || !pal) return null;
  const c = toCanvas(rows, pal, Math.max(1, Math.round(scale)));
  c.style.cssText = 'image-rendering:pixelated;display:block;flex:none';
  return c;
}

/** The element badge that belongs on a creature, a move button, or a result line. */
export function elementBadge(element, scale = 3) {
  const map = { fire: ['fireBadge', 'fire'], earth: ['earthBadge', 'earth'], water: ['waterBadge', 'water'] };
  const pick = map[String(element || '').toLowerCase()];
  return pick ? sprite(pick[0], pick[1], scale) : null;
}

/** The move glyph, which is a different drawing from the badge: the badge names, the move acts. */
export function moveIcon(element, scale = 3) {
  const map = { fire: ['fireMove', 'fireMove'], earth: ['earthMove', 'earthMove'], water: ['waterMove', 'waterMove'] };
  const pick = map[String(element || '').toLowerCase()];
  return pick ? sprite(pick[0], pick[1], scale) : null;
}

/** The four attentions, each with its own drawing. Same size, because none of them is the best one. */
export function attentionIcon(kind, scale = 3) {
  const map = { spar: 'sparP', drill: 'drillP', feed: 'feedP', play: 'playP' };
  return map[kind] ? sprite(kind, map[kind], scale) : null;
}

/**
 * The egg, at the stage the gestation has reached. 0 is freshly conceived, 2 is about to hatch.
 *
 * This is the answer to a wait being something to watch rather than something to endure: a player
 * who comes back to a further-along egg has been shown that time passed, without a countdown.
 */
export function egg(progress, scale = 4) {
  const stage = progress >= 0.66 ? 'egg2' : progress >= 0.33 ? 'egg1' : 'egg0';
  return sprite(stage, 'eggP', scale);
}

/**
 * Play one of the kit's five effects over a host element, which must be positioned.
 *
 * Two frames, 240ms, layered over a static creature: the creature does not animate, the hit does.
 * That is deliberate in the design review, and it is also why there are no per-body variants to
 * maintain. Returns a stop() so a looping effect (poison) can be cleared when the round ends.
 */
export function playEffect(host, effectName, opts = {}) {
  const fx = EFFECTS[effectName];
  if (!fx) return () => {};
  const scale = opts.scale || 3;
  const frames = fx.frames.map((f) => toCanvas(SPRITES[f], PALETTES[fx.palette], scale)).filter(Boolean);
  if (!frames.length) return () => {};

  const layer = document.createElement('div');
  const y = ANCHOR_Y[fx.anchor] === undefined ? ANCHOR_Y.chest : ANCHOR_Y[fx.anchor];
  layer.style.cssText = 'position:absolute;left:50%;transform:translate(-50%,-50%);pointer-events:none;'
    + `top:${Math.round(y * 100)}%;z-index:2`;
  for (const f of frames) {
    f.style.cssText = 'image-rendering:pixelated;display:none;position:relative';
  }
  frames.forEach((f) => layer.append(f));
  host.append(layer);

  let i = 0;
  let timer = null;
  const show = (n) => frames.forEach((f, k) => { f.style.display = k === n ? 'block' : 'none'; });
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  };

  if (stillPlease()) {
    show(frames.length - 1);
    if (!fx.loop) setTimeout(stop, fx.ms * 3);
    return stop;
  }

  show(0);
  timer = setInterval(() => { i = (i + 1) % frames.length; show(i); }, fx.ms);
  // A one-shot runs both frames twice and leaves; poison loops until the caller stops it.
  if (!fx.loop) setTimeout(stop, fx.ms * frames.length * 2);
  return stop;
}

/** Which effect a round should play, from the element and whether a charge was spent. */
export function effectFor(element) {
  return { fire: 'fireHit', earth: 'earthHit', water: 'waterHit' }[String(element || '').toLowerCase()] || null;
}

// --- the arenas -------------------------------------------------------------------------------

// Chroma is held under 8% on every surface. The element is told through silhouette and structure,
// never through hue: a saturated backdrop would fight the creature standing on it, and the creature
// is the thing a player is trying to read. The only saturated pixels in the Fire arena are its two
// ember blocks, and they are the only thing that moves.
const ARENAS = {
  fire: {
    sky: '#211D1C', floor: '#2A2523', stripe: '#332D2A', sill: '#3A322E',
    prop: 'brazier', accent: P.ember,
  },
  earth: {
    sky: '#1D211B', floor: '#252A22', stripe: '#2D3329', sill: '#333A2E',
    prop: 'boulder', accent: null,
  },
  water: {
    sky: '#1B1E21', floor: '#22262A', stripe: '#2A2F35', sill: '#2E343A',
    prop: 'column', accent: null,
    // The one structural difference between the three: this floor lightens away from the viewer
    // instead of darkening, which reads as a still surface rather than packed ground.
    lighten: true,
  },
};

/**
 * A fight backdrop. Built from divs rather than a sprite because it has to stretch to whatever
 * width the panel is, and because the ember pulse is two colours rather than two frames.
 */
export function arena(element, height = 150) {
  const a = ARENAS[String(element || '').toLowerCase()] || ARENAS.fire;
  const box = document.createElement('div');
  box.style.cssText = `position:relative;height:${height}px;overflow:hidden;background:${a.sky};`
    + `border:1px solid ${P.slab}`;

  // The horizon sill: a raised lip the props stand on, so the creature has a floor rather than a
  // colour behind it.
  const sill = document.createElement('div');
  sill.style.cssText = `position:absolute;left:0;right:0;bottom:${Math.round(height * 0.34)}px;`
    + `height:4px;background:${a.sill}`;
  box.append(sill);

  const floor = document.createElement('div');
  floor.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:${Math.round(height * 0.34)}px;`
    + `background:${a.floor}`;
  // Four stripes of receding ground. Lightening reads as water, darkening as earth and stone.
  for (let i = 0; i < 4; i++) {
    const s = document.createElement('div');
    const t = i / 4;
    s.style.cssText = `position:absolute;left:0;right:0;top:${Math.round(t * 100)}%;height:${100 / 4}%;`
      + `background:${a.stripe};opacity:${(a.lighten ? 0.25 + t * 0.5 : 0.75 - t * 0.5).toFixed(2)}`;
    floor.append(s);
  }
  box.append(floor);

  for (const side of [0.14, 0.86]) box.append(prop(a, side, height));
  return box;
}

/** One piece of arena furniture. Mass and silhouette carry the element, not colour. */
function prop(a, x, height) {
  const base = Math.round(height * 0.34);
  const w = Math.round(height * 0.12);
  const p = document.createElement('div');
  p.style.cssText = `position:absolute;bottom:${base}px;left:${Math.round(x * 100)}%;transform:translateX(-50%)`;

  if (a.prop === 'brazier') {
    const stand = document.createElement('div');
    stand.style.cssText = `width:${w}px;height:${Math.round(height * 0.22)}px;background:${a.sill}`;
    const bowl = document.createElement('div');
    bowl.style.cssText = `width:${w + 6}px;height:6px;background:${a.sill};margin-left:-3px`;
    // The two ember blocks: the only saturated pixels in the whole arena, on a 2-step loop.
    const coal = document.createElement('div');
    coal.style.cssText = `width:${w}px;height:5px;background:${a.accent};margin-bottom:1px`;
    if (!stillPlease()) {
      let on = true;
      setInterval(() => { on = !on; coal.style.opacity = on ? '1' : '0.45'; }, 480);
    }
    p.append(coal, bowl, stand);
    return p;
  }
  if (a.prop === 'boulder') {
    // Stacked mass, widest at the bottom. Earth reads from the weight, not the green.
    for (const [bw, bh] of [[w * 0.6, 8], [w, 10], [w * 1.4, 12]]) {
      const b = document.createElement('div');
      b.style.cssText = `width:${Math.round(bw)}px;height:${bh}px;background:${a.sill};margin:0 auto 1px`;
      p.append(b);
    }
    return p;
  }
  // Water: three slim columns, still and vertical.
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:3px;align-items:flex-end';
  for (const h of [0.2, 0.28, 0.16]) {
    const c = document.createElement('div');
    c.style.cssText = `width:4px;height:${Math.round(height * h)}px;background:${a.sill}`;
    row.append(c);
  }
  p.append(row);
  return p;
}
