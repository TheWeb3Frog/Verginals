// The habitat: a creature that lives on the screen instead of sitting in a list.
//
// Everything the player can do here already existed as a rule. ADVENTURE-MODE-v0 §5.1 gives a
// juvenile three attentions a day and four kinds to spend them on (spar, drill, feed, play), and it
// says attention "makes it grow FASTER and decides WHAT IT BECOMES". Until now that was a number on
// a card. Here it is the animal's behaviour: a creature raised on spar paces and bounces, one raised
// on feed naps, one raised on play chases the ball. Same rules, finally visible.
//
// Three things this file will not do, because they belong elsewhere:
//
//   IT DECIDES NOTHING. Every act calls back out to the caller, which owns the API. The three-a-day
//   cap, the shared growth cap and passive growth stay in src/lifecycle.js. A refusal from the
//   server is choreographed as the creature turning away, never reimplemented as a check here.
//
//   IT COMPOSITES NOTHING. The creature comes from creatureSprite() in adventure-art.js, because
//   the trait layer order is easy to get wrong and there must be exactly one copy of it.
//
//   IT REPAINTS NOTHING. Movement is `transform` on the one wrapper element, so the five stacked
//   trait images are never touched by the animation loop.

import { PALETTE, PALETTES, SPRITES, toCanvas } from './verginals-kit.js';
import { creatureSprite, playEffect, effectFor } from './adventure-art.js';

const P = PALETTE;

// --- the glyphs the kit does not have ----------------------------------------------------------
//
// The kit ships 35 sprites and every one of them is a badge, a move, a result or an effect. None of
// them is the small thing that pops over an animal's head to say how it feels. These are authored in
// the kit's own format (16x16 rows of palette keys, K outline, F fill, W highlight) so they draw
// through the same toCanvas and could be moved into the kit later without a rewrite.

const EMOTES = {
  heart: [
    '................', '................', '..KKK.....KKK...', '.KFFFK...KFFFK..',
    'KFLLFFK.KFFFFFK.', 'KFLFFFFKKFFFFFFK', 'KFFFFFFFFFFFFFFK', '.KFFFFFFFFFFFFK.',
    '..KFFFFFFFFFFK..', '...KFFFFFFFFK...', '....KFFFFFFK....', '.....KFFFFK.....',
    '......KFFK......', '.......KK.......', '................', '................',
  ],
  zzz: [
    '................', '...........KKK..', '............K...', '...........KKK..',
    '................', '......KKKK......', '........K.......', '.......K........',
    '......KKKK......', '................', '.KKKKK..........', '....K...........',
    '...K............', '..K.............', '.KKKKK..........', '................',
  ],
  note: [
    '................', '.........KKKK...', '.........KFFFK..', '.........KFFFK..',
    '........KFFKKK..', '........KFK.....', '........KFK.....', '........KFK.....',
    '........KFK.....', '........KFK.....', '.....KKKKFK.....', '....KFFFFFK.....',
    '....KFFFFK......', '....KFFFK.......', '.....KKK........', '................',
  ],
  sweat: [
    '................', '................', '................', '.......KK.......',
    '......KFFK......', '......KFFK......', '.....KFFFFK.....', '.....KFWFFK.....',
    '....KFFWFFFK....', '....KFFFFFFK....', '....KFFFFFFK....', '.....KFFFFK.....',
    '......KKKK......', '................', '................', '................',
  ],
  star: [
    '................', '.......KK.......', '......KFFK......', '......KFFK......',
    '.....KFFFFK.....', '.KKKKKFFFFKKKKK.', '.KFFFFFWWFFFFFK.', '..KFFFFWWFFFFK..',
    '...KFFFFFFFFK...', '....KFFFFFFK....', '....KFFFFFFK....', '...KFFK..KFFK...',
    '..KFFK....KFFK..', '..KKK......KKK..', '................', '................',
  ],
  question: [
    '................', '.....KKKKKK.....', '....KFFFFFFK....', '...KFFKKKKFFK...',
    '...KFFK..KFFK...', '...KKK...KFFK...', '........KFFK....', '.......KFFK.....',
    '......KFFK......', '......KFFK......', '......KKKK......', '................',
    '......KKKK......', '......KFFK......', '......KKKK......', '................',
  ],
};

// Colours come from the kit's PALETTE rather than fresh hex, so an emote sits in the same world as
// everything else on the screen.
const EMOTE_PAL = {
  heart: { K: P.ink, F: P.prismA, L: '#FF89B4', W: P.paper },
  zzz: { K: P.fog, F: P.fog, W: P.paper },
  note: { K: P.ink, F: P.prismD, L: P.veilLight },
  sweat: { K: P.ink, F: P.foam, W: P.paper },
  star: { K: P.ink, F: P.gold, W: P.goldLight },
  question: { K: P.ink, F: P.fog, W: P.paper },
};

// --- the four props ----------------------------------------------------------------------------
//
// The kit already draws feed, play, spar and drill. They were built as button glyphs, but they read
// as objects at this size, so the habitat furnishes itself out of the designer's own work rather
// than inventing a second visual language for the same four ideas.

const ACTS = [
  { kind: 'feed', sprite: 'feed', pal: 'feedP', at: 0.12, verb: 'is eating', emote: 'heart' },
  { kind: 'play', sprite: 'play', pal: 'playP', at: 0.38, verb: 'is playing', emote: 'note' },
  { kind: 'spar', sprite: 'spar', pal: 'sparP', at: 0.64, verb: 'is sparring', emote: 'star' },
  { kind: 'drill', sprite: 'drill', pal: 'drillP', at: 0.88, verb: 'is drilling', emote: 'sweat' },
];

// --- behaviour ---------------------------------------------------------------------------------

const IDLE_STATES = ['idle', 'wander', 'sniff', 'nap', 'ball', 'practise'];

/**
 * How a creature spends its time, biased by how it was raised.
 *
 * This is the whole point of the screen. §5.1 says attention decides what a juvenile becomes, and
 * these weights are that sentence made observable: the same creature, raised two different ways,
 * behaves differently before it has fought anything or shown a single statistic.
 */
function weightsFor(attentions = {}) {
  const a = {
    spar: attentions.spar || 0, drill: attentions.drill || 0,
    feed: attentions.feed || 0, play: attentions.play || 0,
  };
  const total = a.spar + a.drill + a.feed + a.play;
  // An unraised juvenile is curious and does a bit of everything.
  const base = { idle: 3, wander: 3, sniff: 2, nap: 1, ball: 2, practise: 1 };
  if (total === 0) return base;
  const share = (k) => a[k] / total;
  return {
    idle: base.idle,
    wander: base.wander + share('spar') * 5,
    sniff: base.sniff + share('feed') * 2,
    nap: base.nap + share('feed') * 6,
    ball: base.ball + share('play') * 7,
    practise: base.practise + share('drill') * 7,
  };
}

function pickWeighted(weights, rnd = Math.random) {
  const keys = Object.keys(weights);
  let total = 0;
  for (const k of keys) total += Math.max(0, weights[k]);
  let r = rnd() * total;
  for (const k of keys) {
    r -= Math.max(0, weights[k]);
    if (r <= 0) return k;
  }
  return keys[0];
}

const DURATION = {
  idle: [1200, 2600], wander: [1400, 3000], sniff: [900, 1600],
  nap: [3000, 7000], ball: [1800, 3400], practise: [1400, 2600],
};

const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

const stillPlease = () => window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- the scene ---------------------------------------------------------------------------------

/**
 * Build a habitat.
 *
 * @param {Object} opts
 * @param {Object} opts.traits       the creature's trait layers, for creatureSprite()
 * @param {string} opts.element      tints the ground and picks the hit effect
 * @param {number} opts.growth       0..growthToAdult, drives how big it is
 * @param {number} opts.growthToAdult
 * @param {Object} opts.attentions   { spar, drill, feed, play } counts so far
 * @param {Function} opts.onAct      (kind) => Promise, the caller owns the API call
 * @param {number} [opts.height]
 * @returns {{ el, act, update, visit, dismiss, destroy }}
 */
export function habitat(opts = {}) {
  const height = opts.height || 260;
  const still = stillPlease();

  const box = document.createElement('div');
  box.style.cssText = `position:relative;height:${height}px;overflow:hidden;`
    + `border:1px solid ${P.slab};border-radius:4px;background:${P.coal};`
    + 'user-select:none;touch-action:manipulation';

  const FLOOR = Math.round(height * 0.30);   // the same proportion the fight arenas use
  const ground = groundFor(opts.element);

  // sky
  const sky = document.createElement('div');
  sky.style.cssText = `position:absolute;inset:0;background:linear-gradient(${ground.sky},${P.coal})`;
  box.append(sky);

  // a few motes, so the air is not empty. Fixed positions: a random field that reshuffles on every
  // render reads as noise rather than as a place.
  for (const [mx, my, o] of [[0.14, 0.18, 0.5], [0.33, 0.09, 0.3], [0.58, 0.22, 0.45],
    [0.72, 0.12, 0.28], [0.88, 0.26, 0.4], [0.46, 0.3, 0.22]]) {
    const m = document.createElement('i');
    m.style.cssText = `position:absolute;left:${mx * 100}%;top:${my * 100}%;width:2px;height:2px;`
      + `background:${P.fog};opacity:${o}`;
    box.append(m);
  }

  const sill = document.createElement('div');
  sill.style.cssText = `position:absolute;left:0;right:0;bottom:${FLOOR}px;height:3px;background:${ground.sill}`;
  box.append(sill);

  const floor = document.createElement('div');
  floor.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:${FLOOR}px;background:${ground.floor}`;
  for (let i = 0; i < 4; i++) {
    const s = document.createElement('div');
    const t = i / 4;
    s.style.cssText = `position:absolute;left:0;right:0;top:${t * 100}%;height:25%;`
      + `background:${ground.stripe};opacity:${(0.7 - t * 0.45).toFixed(2)}`;
    floor.append(s);
  }
  box.append(floor);

  // props. The loop variable is `spec` and not `act`, which is the name of the function it calls.
  // A scene with `props: false` is a place two animals are introduced, not one where anything is
  // raised, so it gets a bare floor rather than four buttons that would only ever refuse.
  const propEls = {};
  for (const spec of (opts.props === false ? [] : ACTS)) {
    const holder = document.createElement('button');
    holder.type = 'button';
    holder.title = spec.kind;
    holder.setAttribute('aria-label', spec.kind);
    holder.style.cssText = `position:absolute;bottom:${FLOOR - 6}px;left:${spec.at * 100}%;`
      + 'transform:translateX(-50%);background:none;border:0;padding:0;cursor:pointer;line-height:0';
    const c = toCanvas(SPRITES[spec.sprite], PALETTES[spec.pal], 2);
    c.style.cssText = 'image-rendering:pixelated;display:block;opacity:0.9';
    holder.append(c);
    holder.addEventListener('click', () => act(spec.kind));
    box.append(holder);
    propEls[spec.kind] = holder;
  }

  // --- actors ----------------------------------------------------------------------------------

  function makeActor(traits, growth, growthToAdult, startX) {
    const size = Math.round(height * 0.42);
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;bottom:${FLOOR}px;left:0;transform-origin:50% 100%;`
      + 'will-change:transform';

    const shadow = document.createElement('div');
    shadow.style.cssText = `position:absolute;bottom:-3px;left:50%;width:${Math.round(size * 0.6)}px;`
      + `height:5px;margin-left:${-Math.round(size * 0.3)}px;border-radius:50%;background:${P.ink};opacity:0.45`;
    wrap.append(shadow);

    const art = creatureSprite(traits, size);
    art.style.position = 'relative';
    wrap.append(art);
    box.append(wrap);

    return {
      wrap, art, size,
      x: startX, target: startX, facing: 1,
      state: 'idle', t: 0, dur: 1500,
      bob: Math.random() * Math.PI * 2,
      scale: sizeFor(growth, growthToAdult),
      squash: 1, hop: 0, busy: false,
    };
  }

  /** Growth is the only thing that changes how big a juvenile is, so it is the only input here. */
  function sizeFor(growth, toAdult) {
    return lerp(0.62, 1, clamp01((growth || 0) / (toAdult || 6)));
  }

  const state = {
    traits: opts.traits || {},
    growth: opts.growth || 0,
    growthToAdult: opts.growthToAdult || 6,
    attentions: opts.attentions || {},
    element: opts.element,
  };

  const actor = makeActor(state.traits, state.growth, state.growthToAdult, 0.5);
  let guest = null;
  let weights = weightsFor(state.attentions);

  // --- placement -------------------------------------------------------------------------------

  // Cached, because reading clientWidth once per actor per frame forces a layout sixty times a
  // second for a number that only changes when the panel is resized.
  let boxWidth = 0;
  const measure = () => { boxWidth = box.clientWidth; };
  const ro = window.ResizeObserver ? new ResizeObserver(measure) : null;
  if (ro) ro.observe(box); else window.addEventListener('resize', measure);

  function place(a) {
    if (!boxWidth) measure();
    const usable = Math.max(1, boxWidth - a.size);
    const px = a.x * usable;
    const lift = a.hop + Math.sin(a.bob) * 1.5;
    a.wrap.style.transform = `translate3d(${px}px,${-lift}px,0)`
      + ` scale(${(a.scale * a.facing).toFixed(3)},${(a.scale * a.squash).toFixed(3)})`;
    a.wrap.style.zIndex = String(10 + Math.round(a.x * 10));
  }

  // --- behaviour -------------------------------------------------------------------------------

  function enter(a, name) {
    a.state = name;
    a.t = 0;
    a.dur = between(DURATION[name] || [1200, 2000]);
    if (name === 'wander') {
      a.target = clamp01(a.x + (Math.random() * 0.7 - 0.35));
      a.facing = a.target >= a.x ? 1 : -1;
    }
    if (name === 'ball') a.target = clamp01(0.38 + (Math.random() * 0.2 - 0.1));
    if (name === 'nap') emote(a, 'zzz', 2600);
    if (name === 'ball') emote(a, 'note', 1400);
  }

  function step(a, dt) {
    a.t += dt;
    a.bob += dt * 0.004;
    a.squash = 1;
    a.hop = 0;

    if (a.state === 'wander' || a.state === 'ball') {
      const speed = 0.00022 * dt * (a.state === 'ball' ? 1.7 : 1);
      const d = a.target - a.x;
      if (Math.abs(d) > 0.005) {
        a.x += Math.sign(d) * Math.min(speed, Math.abs(d));
        a.facing = d >= 0 ? 1 : -1;
        // A walk is a series of small hops rather than a slide, which is what sells weight.
        const phase = (a.t / 260) % 1;
        a.hop = Math.sin(phase * Math.PI) * 4;
        a.squash = 1 - Math.sin(phase * Math.PI) * 0.06;
      }
    } else if (a.state === 'nap') {
      a.squash = 0.92;
      a.hop = 0;
    } else if (a.state === 'sniff') {
      a.squash = 1 - Math.abs(Math.sin(a.t / 220)) * 0.08;
    } else if (a.state === 'practise') {
      // Two quick hops, a pause, two more. It reads as repetition, which is what drilling is.
      const cycle = (a.t % 900) / 900;
      if (cycle < 0.5) {
        a.hop = Math.abs(Math.sin(cycle * Math.PI * 4)) * 9;
        a.squash = 1 - a.hop / 90;
      }
      if (a.t % 900 < dt) a.facing = -a.facing;
    }

    if (!a.busy && a.t >= a.dur) enter(a, pickWeighted(a === actor ? weights : weightsFor({})));
  }

  // --- emotes ----------------------------------------------------------------------------------

  function emote(a, name, life = 1500) {
    if (!EMOTES[name]) return;
    const c = toCanvas(EMOTES[name], EMOTE_PAL[name], 2);
    c.style.cssText = 'position:absolute;image-rendering:pixelated;pointer-events:none;'
      + `left:50%;bottom:${a.size * 0.9}px;margin-left:-16px;opacity:0;`
      + 'transition:transform 420ms ease-out, opacity 420ms ease-out';
    a.wrap.append(c);
    requestAnimationFrame(() => {
      c.style.opacity = '1';
      c.style.transform = 'translateY(-14px)';
    });
    setTimeout(() => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(-26px)';
      setTimeout(() => c.remove(), 460);
    }, life);
  }

  // --- acts ------------------------------------------------------------------------------------

  const walkTo = (a, x) => new Promise((done) => {
    if (still) { a.x = x; place(a); return done(); }
    a.busy = true;
    a.state = 'wander';
    a.target = clamp01(x);
    a.t = 0;
    a.dur = Infinity;
    const check = () => {
      // `dead` matters: without it, destroying the habitat mid-walk leaves this polling forever.
      if (dead || Math.abs(a.target - a.x) <= 0.006) { a.busy = false; return done(); }
      requestAnimationFrame(check);
    };
    check();
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, still ? 0 : ms));

  let acting = false;

  /**
   * One attention, start to finish: walk over, perform, and react to whatever the server says. The
   * server is the only thing that decides whether it counted.
   */
  async function act(kind) {
    if (acting) return null;
    const spec = ACTS.find((a) => a.kind === kind);
    if (!spec) return null;
    acting = true;
    const prop = propEls[kind];
    if (prop) prop.style.filter = 'brightness(1.5)';
    try {
      await walkTo(actor, spec.at);
      actor.busy = true;
      actor.facing = 1;
      actor.state = 'sniff';
      actor.t = 0;
      actor.dur = Infinity;
      await wait(320);

      const result = await Promise.resolve(opts.onAct ? opts.onAct(kind) : null);
      const refused = result && result.ok === false;

      if (refused) {
        emote(actor, 'question', 1200);
        actor.facing = -1;
      } else {
        emote(actor, spec.emote, 1400);
        if (kind === 'spar') playEffect(actor.wrap, effectFor(state.element), { anchor: 'chest' });
        if (result && typeof result.growth === 'number') {
          state.growth = result.growth;
          actor.scale = sizeFor(state.growth, state.growthToAdult);
        }
        if (result && result.attentions) {
          state.attentions = result.attentions;
          weights = weightsFor(state.attentions);
        }
      }
      await wait(600);
      return result;
    } finally {
      if (prop) prop.style.filter = '';
      actor.busy = false;
      enter(actor, 'idle');
      acting = false;
    }
  }

  // --- a visitor -------------------------------------------------------------------------------

  /**
   * Breeding, as the player asked for it: the other creature walks in and the two play together
   * before anything is committed. Nothing here decides whether the pairing is allowed. The caller
   * has already shown the §3.4 relatedness percentage and holds the pair and resolve calls.
   */
  async function visit(mate) {
    if (guest) dismiss();
    guest = makeActor(mate.traits || {}, mate.growth || 6, state.growthToAdult, 1.15);
    guest.facing = -1;
    place(guest);
    // Close enough to read as together, far enough that neither hides the other. At a smaller gap
    // the front animal eats half the one behind it and the scene stops being about two creatures.
    await walkTo(guest, 0.68);
    await walkTo(actor, 0.36);
    guest.facing = -1;
    actor.facing = 1;
    guest.busy = true;
    actor.busy = true;
    emote(actor, 'heart', 1800);
    await wait(500);
    emote(guest, 'heart', 1800);
    // They circle: a short back and forth, close enough to read as together rather than adjacent.
    for (let i = 0; i < 3 && !still; i++) {
      actor.hop = 8; guest.hop = 0;
      await wait(240);
      actor.hop = 0; guest.hop = 8;
      await wait(240);
    }
    actor.hop = 0; guest.hop = 0;
    emote(actor, 'star', 1600);
    emote(guest, 'star', 1600);
    await wait(700);
    return true;
  }

  function dismiss() {
    if (!guest) return;
    guest.wrap.remove();
    guest = null;
    actor.busy = false;
    enter(actor, 'idle');
  }

  // --- the loop --------------------------------------------------------------------------------

  let raf = 0;
  let last = 0;
  let dead = false;

  /**
   * Advance the world by dt milliseconds. The animation loop is a thin driver over this, which is
   * what makes the behaviour testable: a headless run can step the creature a thousand frames and
   * assert it moved, without a compositor and without waiting in real time.
   */
  function tick(dt) {
    step(actor, dt);
    place(actor);
    if (guest) { step(guest, dt); place(guest); }
  }

  function frame(now) {
    if (dead) return;
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    if (!document.hidden) tick(dt);
    raf = requestAnimationFrame(frame);
  }

  if (still) {
    // A player who asked for less motion gets the creature standing in its habitat, and every act
    // resolves without the walk. Nothing is hidden from them, it simply does not move.
    place(actor);
  } else {
    enter(actor, 'idle');
    raf = requestAnimationFrame(frame);
  }

  const api = {
    el: box,
    act,
    visit,
    dismiss,
    tick,
    /** Read-only, for tests and for the caption under the scene. */
    get behaviour() { return actor.state; },
    get position() { return actor.x; },
    /** Re-read the creature after the caller has refreshed it from the server. */
    update(next = {}) {
      if (next.growth != null) {
        state.growth = next.growth;
        actor.scale = sizeFor(state.growth, state.growthToAdult);
      }
      if (next.attentions) {
        state.attentions = next.attentions;
        weights = weightsFor(state.attentions);
      }
      place(actor);
    },
    destroy() {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', measure);
      box.remove();
    },
  };
  return api;
}

/** The ground carries the element, the way the fight arenas do, so the two read as one world. */
function groundFor(element) {
  const e = String(element || '').toLowerCase();
  if (e === 'earth') return { sky: '#16200F', sill: P.moss, floor: P.loam, stripe: P.earth };
  if (e === 'water') return { sky: '#0D1A26', sill: P.foam, floor: P.deep, stripe: P.water };
  return { sky: '#241009', sill: P.ember, floor: '#3A1A10', stripe: P.fireDark };
}

export { EMOTES, ACTS, weightsFor };
