'use strict';
// Adventure Mode combat: three buttons, one deterministic reducer.
//
// Pure. No DB, no clock, no randomness beyond the seed the caller supplies, so a whole fight
// replays from (fighters, actions, seed) and anyone can recompute a result rather than believe it.
// That matters more here than it looks: the only thing worth claiming in this game is a rare cat,
// and a claim nobody can check is worth nothing.
//
// INITIATIVE MOVED, AND IT MATTERS. The first design gave initiative to the rarer Collar. Collar is
// the flattest locus in the collection, 249 down to 195, and it has no dominance at all, so that
// rule handed a permanent advantage (act first, and therefore impose your Background) to White, on
// a rarity gap of 1.28x. It also broke the game's own promise that a rare allele grants a rule and
// never an advantage. Initiative now goes to the Tuned collar, which already pays for itself: Tuned
// charges its Rune in two turns instead of four, and Mute takes +2 Armor in exchange. Ties fall to
// the lighter cat, then to the seeded flip. Two alleles override the whole chain, one upward
// (Shiny Eyes Happy) and one downward (Cow), and both are visible on the sprite.

const { LOCI, phenotype, canFlip, nameOf, rankOf } = require('./pool');
const { faceAt } = require('./faces');
const { bodyAt } = require('./bodies');
const { backgroundAt } = require('./backgrounds');
const RUNES = require('./runes');

// Water douses Fire, Fire scorches Earth, Earth swallows Water.
const BEATS = { Water: 'Fire', Fire: 'Earth', Earth: 'Water' };
const FAVOURABLE = 1.5, NEUTRAL = 1.0, UNFAVOURABLE = 0.75;

const MUTE_ARMOR = 2;

// A fight has a horizon, and it needs one. Damage has a floor of 1, several Faces and Bodies
// regenerate 3 per turn, and Oreo's layered reduction sits on top of its Armor: put those together
// and two ordinary cats can reach a state where neither can ever land the killing blow. Found by
// running two hundred random pairings, not by reading the table. Twenty turns is roughly four times
// the median fight, so it never interrupts a real one; when it fires, the healthier cat wins, which
// is the honest reading of what happened.
const TURN_LIMIT = 20;
const FLIP_FAIL_VIGOR = 50;      // below this a Flip fails one time in three
const FLIP_FAIL_CHANCE = 1 / 3;

// --- deterministic draws --------------------------------------------------------------------

// Fights are short and every draw must be reproducible from the seed alone, independent of how many
// draws came before, so each one hashes (seed, label) rather than advancing a stream. A replay that
// skips a branch therefore cannot desynchronise the ones after it.
function draw(seed, label) {
  let h = 0x811c9dc5;
  const s = `${seed}|${label}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 8) / 0x1000000;
}

// --- fighters -------------------------------------------------------------------------------

function formOf(ranks) {
  return {
    body: bodyAt(ranks.Body),
    face: faceAt(ranks.Face),
    background: backgroundAt(ranks.Background),
    collar: nameOf('Collar', ranks.Collar),
    rune: nameOf('Rune', ranks.Rune),
    house: nameOf('House', ranks.House),
  };
}

/**
 * Build a fighter from a genome. `vigor` scales maxHP only: it is not an allele, it never changes
 * what a lineage can carry, and it is the one knob difficulty is allowed to touch (§8.12).
 */
function createFighter({ id, name, genome, vigor = 100, catnip = 0 }) {
  const { first, second } = phenotype(genome, id);
  const f = formOf(first);
  const hpScale = vigor >= 100 ? 1 : Math.max(0.4, 0.6 + vigor / 250);
  const tuned = RUNES.isTuned(f.collar, f.rune);

  return {
    id, name, genome, vigor, catnip,
    firstRanks: first, secondRanks: second,
    ranks: { ...first },
    form: 'first',
    canFlip: canFlip(genome),
    hasFlipped: false,
    hpScale,
    maxHp: Math.round(f.body.hp * hpScale),
    hp: Math.round(f.body.hp * hpScale),
    baseForce: f.body.force,
    forceMod: 0,
    baseArmor: f.body.armor + (tuned ? 0 : MUTE_ARMOR),
    armorMod: 0,
    tuned,
    runeCharge: 0,
    ...f,
    fx: {},                 // live effects: burn, shield, riposte, armor, force stacks
    flags: {},              // per fight memory: hitLastTurn, missedLast, firstHitTaken, stood
    lastRuneFamily: null,
  };
}

/** Re-derive the body-dependent numbers after a Flip, keeping the damage already taken. */
function reform(fighter, ranks) {
  const f = formOf(ranks);
  const tuned = RUNES.isTuned(f.collar, f.rune);
  const lost = fighter.maxHp - fighter.hp;
  Object.assign(fighter, f, {
    ranks: { ...ranks },
    tuned,
    maxHp: Math.round(f.body.hp * fighter.hpScale),
    baseForce: f.body.force,
    baseArmor: f.body.armor + (tuned ? 0 : MUTE_ARMOR),
  });
  fighter.hp = Math.max(1, fighter.maxHp - lost);
  return fighter;
}

// --- effective stats ------------------------------------------------------------------------

const forceOf = (x) => Math.max(1, x.baseForce + x.forceMod);
const armorOf = (x) => Math.max(0, x.baseArmor + x.armorMod);

/** The Face a fighter fights with: sessalG D3 swaps them, and Spectrum can take one away. */
function activeFace(state, side) {
  const me = state.f[side], you = state.f[1 - side];
  if (state.arena.fx.imposerKeepsFace && state.arenaOwner !== side && !me.face.fx.arenaImmune) {
    return faceAt(rankOf('Face', 'Perplexed Small'));   // a blank face, not a missing one
  }
  const mirrored = me.face.fx.mirrorFaces || you.face.fx.mirrorFaces;
  const borrowed = me.flags.copiedFace;
  if (borrowed) return borrowed;
  return mirrored ? you.face : me.face;
}

function houseMultiplier(state, side) {
  const me = state.f[side], you = state.f[1 - side];
  if (activeFace(state, side).fx.prism) return FAVOURABLE;
  if (BEATS[me.house] === you.house) return FAVOURABLE;
  if (BEATS[you.house] === me.house) return UNFAVOURABLE;
  return NEUTRAL;
}

// --- initiative -----------------------------------------------------------------------------

/**
 * Who acts first, and therefore whose Background becomes the arena.
 *
 * Tuned first, because a collar in phase with its rune is the readable version of "in tune", and
 * because Tuned already trades away Mute's +2 Armor to get it. Then the lighter cat, which makes
 * Cow slow and Tiger fast without a word of explanation. Then the seeded flip, so the answer is
 * never undefined. Two alleles jump the queue outright, and Cow's Placid loses to nothing.
 */
function initiative(a, b, seed) {
  const aFirst = a.face.fx.alwaysFirst, bFirst = b.face.fx.alwaysFirst;
  const aNever = !!(a.body.rule && a.body.rule.fx.neverFirst);
  const bNever = !!(b.body.rule && b.body.rule.fx.neverFirst);

  if (aNever !== bNever) return { side: aNever ? 1 : 0, why: 'placid' };
  if (aFirst !== bFirst) return { side: aFirst ? 0 : 1, why: 'wide awake' };
  if (a.tuned !== b.tuned) return { side: a.tuned ? 0 : 1, why: 'tuned collar' };
  if (a.maxHp !== b.maxHp) return { side: a.maxHp < b.maxHp ? 0 : 1, why: 'lighter' };
  return { side: draw(seed, 'initiative') < 0.5 ? 0 : 1, why: 'coin' };
}

// --- the fight ------------------------------------------------------------------------------

function startFight({ a, b, seed }) {
  const init = initiative(a, b, seed);
  const owner = init.side;
  const state = {
    seed, f: [a, b], turn: 1, toAct: owner, over: false, winner: null,
    arenaOwner: owner,
    arena: a.background && owner === 0 ? a.background : b.background,
    log: [],
  };
  state.arena = state.f[owner].background;

  emit(state, 'start', { arena: state.arena.name, first: owner, why: init.why });

  // Faces that act before anyone chooses anything.
  for (const s of [0, 1]) {
    const face = activeFace(state, s);
    if (face.fx.skipTurn1) { state.f[s].flags.asleep = true; emit(state, 'asleep', { side: s }); }
    if (face.fx.bothMissFirst) {
      state.f[0].flags.forceMiss = true; state.f[1].flags.forceMiss = true;
      emit(state, 'bothMiss', { side: s });
    }
    if (state.f[s].body.rule && state.f[s].body.rule.fx.firstRuneFree) {
      state.f[s].runeCharge = 99; emit(state, 'runeReady', { side: s, free: true });
    }
  }
  return state;
}

function emit(state, type, data) { state.log.push({ turn: state.turn, type, ...data }); }

/** The horizon. The cat holding the larger share of its own HP walks away. */
function timeUp(state) {
  const [a, b] = state.f;
  const fa = a.hp / a.maxHp, fb = b.hp / b.maxHp;
  state.over = true;
  state.winner = fa === fb ? (draw(state.seed, 'timeout') < 0.5 ? 0 : 1) : (fa > fb ? 0 : 1);
  state.timedOut = true;
  emit(state, 'timeout', { winner: state.winner, hp: [fa, fb] });
  return state;
}

function runeCost(state, side) {
  const me = state.f[side], you = state.f[1 - side];
  let cost = RUNES.chargeTurns(me.tuned);
  cost -= activeFace(state, side).fx.runeChargeFaster || 0;
  cost += activeFace(state, 1 - side).fx.opponentRuneSlower || 0;
  return Math.max(1, cost);
}

/** One attack. Returns the damage actually applied. */
function strike(state, side, label) {
  const me = state.f[side], you = state.f[1 - side];
  const myFace = activeFace(state, side), yourFace = activeFace(state, 1 - side);
  const pounce = me.body.rule && me.body.rule.fx.unmissableOpener && !me.flags.opened;
  me.flags.opened = true;

  // Misses: the arena's, the forced opening one, and Big Laughing's contagion.
  let miss = false;
  if (!pounce) {
    if (me.flags.forceMiss) { miss = true; me.flags.forceMiss = false; }
    else if (me.flags.contagiousMiss) { miss = true; me.flags.contagiousMiss = false; }
    else if (state.arena.fx.missChance && !myFace.fx.arenaImmune
             && draw(state.seed, `miss:${side}:${state.turn}:${label}`) < state.arena.fx.missChance) miss = true;
  }
  if (miss) {
    emit(state, 'miss', { side });
    you.flags.missedAgainstMe = true;
    if (yourFace.fx.contagiousMiss) me.flags.contagiousMiss = true;
    return 0;
  }

  let force = forceOf(me);
  if (me.flags.awakeBonus) force += me.flags.awakeBonus;
  let bonus = myFace.fx.damageBonus || 0;
  if (myFace.fx.damageBonusIfHit && me.flags.hitLastTurn) bonus += myFace.fx.damageBonusIfHit;
  if (myFace.fx.damageAfterMiss && me.flags.opponentMissed) bonus += myFace.fx.damageAfterMiss;

  const ignoreArmor = myFace.fx.ignoreArmor;
  let raw = force + bonus - (ignoreArmor ? 0 : armorOf(you));

  // Oreo reads the first attack of each turn, which is what makes it an answer to Ride's Surge.
  const layered = you.body.rule && you.body.rule.fx.firstAttackPerTurnReduction;
  if (layered && !you.flags.tookOneThisTurn) raw -= layered;
  you.flags.tookOneThisTurn = true;

  let dmg = Math.max(1, raw) * houseMultiplier(state, side);

  if (state.arena.fx.damageVariance && !myFace.fx.arenaImmune) {
    const v = state.arena.fx.damageVariance;
    dmg *= 1 - v + 2 * v * draw(state.seed, `var:${side}:${state.turn}:${label}`);
  }
  dmg = Math.max(1, Math.round(dmg));

  // Shields, and the two Faces that go through them.
  if (you.fx.shield && !(pounce || myFace.fx.ignoreShield)) {
    you.fx.shield = false;
    emit(state, 'shielded', { side: 1 - side });
    return 0;
  }

  const applied = damage(state, 1 - side, dmg, 'hit');
  emit(state, 'hit', { side, amount: applied, mult: houseMultiplier(state, side) });

  // Everything that answers back.
  if (you.fx.riposte) { you.fx.riposte = false; damage(state, side, applied, 'riposte'); emit(state, 'riposte', { side: 1 - side, amount: applied }); }
  if (yourFace.fx.healOnDamage) heal(state, 1 - side, yourFace.fx.healOnDamage);
  if (you.body.rule && you.body.rule.fx.burnAttacker && !me.body.rule?.fx.immuneBurn && !myFace.fx.nothingSticks) {
    me.fx.burn = { ...you.body.rule.fx.burnAttacker };
    emit(state, 'burned', { side, source: 'body' });
  }
  if (you.body.rule && you.body.rule.fx.poisonAttacker && !myFace.fx.nothingSticks) {
    me.forceMod -= you.body.rule.fx.poisonAttacker;
    emit(state, 'poisoned', { side, force: -you.body.rule.fx.poisonAttacker });
  }
  if (!you.flags.grudged && yourFace.fx.grudge) {
    you.flags.grudged = true; me.forceMod -= yourFace.fx.grudge;
    emit(state, 'grudge', { side, force: -yourFace.fx.grudge });
  }
  return applied;
}

function damage(state, side, amount, cause) {
  const x = state.f[side];
  const face = activeFace(state, side);
  let dmg = amount;
  if (cause === 'hit') {
    dmg = Math.max(0, dmg - (face.fx.damageReduction || 0));
    if (face.fx.firstHitTaken && !x.flags.firstHitTaken) {
      x.flags.firstHitTaken = true;
      dmg = face.fx.firstHitTaken === 'negate' ? 0 : Math.ceil(dmg / 2);
    }
  }
  x.hp -= dmg;
  if (cause === 'hit') x.flags.hitThisTurn = true;

  if (x.hp <= 0) {
    // Zombie holds the door for two turns, and Devotion holds it once.
    if (state.arena.fx.noDeathBefore && state.turn < state.arena.fx.noDeathBefore && !face.fx.arenaImmune) {
      x.hp = 1; emit(state, 'undying', { side });
    } else if (face.fx.standAtOne && !x.flags.stood) {
      x.flags.stood = true; x.hp = 1; emit(state, 'stood', { side });
    } else {
      x.hp = 0; state.over = true; state.winner = 1 - side;
      emit(state, 'down', { side });
    }
  }
  return dmg;
}

function heal(state, side, amount) {
  const x = state.f[side];
  const before = x.hp;
  x.hp = Math.min(x.maxHp, x.hp + amount);
  if (x.hp !== before) emit(state, 'heal', { side, amount: x.hp - before });
}

function castRune(state, side) {
  const me = state.f[side], you = state.f[1 - side];
  const myFace = activeFace(state, side), yourFace = activeFace(state, 1 - side);

  let family = RUNES.familyOf(me.rune);
  if (yourFace.fx.staticRune && !myFace.fx.nothingSticks) {
    const fams = Object.keys(RUNES.FAMILIES);
    family = fams[Math.floor(draw(state.seed, `static:${side}:${state.turn}`) * fams.length)];
    emit(state, 'static', { side, became: family });
  }
  if (family === 'Runestone' && state.lastRune) family = state.lastRune;

  const fx = (RUNES.FAMILIES[family] || {}).fx || {};
  state.lastRune = family;
  me.runeCharge = 0;
  emit(state, 'rune', { side, family });

  if (fx.heal) heal(state, side, fx.heal);
  if (fx.shield) me.fx.shield = true;
  if (fx.riposte) me.fx.riposte = true;
  if (fx.armor) me.armorMod += fx.armor;
  if (fx.force) me.forceMod += fx.force;
  if (fx.burn && !(you.body.rule && you.body.rule.fx.immuneBurn) && !yourFace.fx.nothingSticks) {
    you.fx.burn = { ...fx.burn }; emit(state, 'burned', { side: 1 - side, source: 'rune' });
  }
  if (fx.extraAttack) { strike(state, side, 'surge1'); if (!state.over) strike(state, side, 'surge2'); }
  if (fx.doubleRewards) state.f[side].flags.doubleRewards = true;
}

function attemptFlip(state, side) {
  const me = state.f[side];
  if (!me.canFlip) { emit(state, 'flipLocked', { side }); return false; }
  if (me.hasFlipped) { emit(state, 'flipSpent', { side }); return false; }
  if (me.catnip < 1) { emit(state, 'flipNoCatnip', { side }); return false; }

  me.catnip -= 1;
  me.hasFlipped = true;
  if (me.vigor < FLIP_FAIL_VIGOR && draw(state.seed, `flip:${side}:${state.turn}`) < FLIP_FAIL_CHANCE) {
    emit(state, 'flipFailed', { side, vigor: me.vigor });
    return false;
  }
  const before = { house: me.house, body: me.body.name };
  reform(me, me.form === 'first' ? me.secondRanks : me.firstRanks);
  me.form = me.form === 'first' ? 'second' : 'first';
  emit(state, 'flip', { side, from: before, to: { house: me.house, body: me.body.name } });

  const you = state.f[1 - side];
  if (you.body.rule && you.body.rule.fx.healOnOpponentFlip) heal(state, 1 - side, you.body.rule.fx.healOnOpponentFlip);
  if (me.body.rule && me.body.rule.fx.doubleTurnAfterFlip) me.flags.extraTurn = true;
  return true;
}

/** Start-of-turn upkeep for the side about to act, then hand it the turn. */
function upkeep(state, side) {
  const x = state.f[side], face = activeFace(state, side);
  x.flags.tookOneThisTurn = false;

  if (x.flags.asleep) {
    x.flags.asleep = false;
    if (face.fx.forceAfterWaking) { x.flags.awakeBonus = face.fx.forceAfterWaking; emit(state, 'awake', { side, force: face.fx.forceAfterWaking }); }
    if (face.fx.copyFaceOnWaking) { x.flags.copiedFace = activeFace(state, 1 - side); emit(state, 'copiedFace', { side, face: x.flags.copiedFace.name }); }
    return false;   // the skipped turn
  }
  if (x.fx.burn) {
    if (face.fx.nothingSticks) { x.fx.burn = null; emit(state, 'shrugged', { side, what: 'burn' }); }
    else {
      damage(state, side, x.fx.burn.amount, 'burn');
      emit(state, 'burn', { side, amount: x.fx.burn.amount });
      if (--x.fx.burn.turns <= 0) x.fx.burn = null;
    }
  }
  if (face.fx.regen) heal(state, side, face.fx.regen);
  if (x.body.rule && x.body.rule.fx.regen) heal(state, side, x.body.rule.fx.regen);
  if (x.body.rule && x.body.rule.fx.forcePerTurn) {
    const cap = x.body.rule.fx.forceCap;
    if (x.forceMod < cap) { x.forceMod = Math.min(cap, x.forceMod + x.body.rule.fx.forcePerTurn); emit(state, 'grew', { side, force: x.forceMod }); }
  }
  if (x.body.rule && x.body.rule.fx.rerollStats) {
    const v = x.body.rule.fx.rerollStats, b = bodyAt(x.ranks.Body);
    const r = (k) => 1 - v + 2 * v * draw(state.seed, `lamp:${side}:${state.turn}:${k}`);
    x.maxHp = Math.max(1, Math.round(b.hp * x.hpScale * r('hp')));
    x.hp = Math.min(x.hp, x.maxHp);
    x.baseForce = Math.max(1, Math.round(b.force * r('f')));
    x.baseArmor = Math.max(0, Math.round(b.armor * r('a'))) + (x.tuned ? 0 : MUTE_ARMOR);
    emit(state, 'reroll', { side, hp: x.maxHp, force: x.baseForce, armor: x.baseArmor });
  }
  if (face.fx.arenaBecomesMineBelow && !x.flags.arenaTaken && x.hp / x.maxHp < face.fx.arenaBecomesMineBelow) {
    x.flags.arenaTaken = true;
    state.arena = x.background; state.arenaOwner = side;
    emit(state, 'arenaSeized', { side, arena: state.arena.name });
  }
  if (x.runeCharge < 99) x.runeCharge += 1;
  return true;
}

/**
 * Play one action for the side to act. `action` is 'CLAW' | 'RUNE' | 'FLIP'.
 * Returns the state; read `state.log` for everything that happened.
 */
function act(state, action) {
  if (state.over) return state;
  const side = state.toAct, me = state.f[side], you = state.f[1 - side];
  const mark = state.log.length;

  me.flags.opponentMissed = !!you.flags.missedAgainstMe;
  you.flags.missedAgainstMe = false;

  const awake = upkeep(state, side);
  if (awake && !state.over) {
    if (action === 'RUNE' && me.runeCharge >= runeCost(state, side)) castRune(state, side);
    else if (action === 'FLIP') {
      const free = me.body.rule && me.body.rule.fx.freeFlip;
      attemptFlip(state, side);
      if (free && !state.over) strike(state, side, 'freeflip');
    } else strike(state, side, 'claw');

    if (me.flags.extraTurn && !state.over) {
      me.flags.extraTurn = false;
      me.flags.tookOneThisTurn = false;
      strike(state, side, 'afterimage');
    }
  }

  me.flags.hitLastTurn = !!me.flags.hitThisTurn;
  me.flags.hitThisTurn = false;
  state.actions = (state.actions || 0) + 1;
  if (!state.over) {
    state.toAct = 1 - side;
    if (state.actions % 2 === 0) state.turn += 1;
    if (state.turn > TURN_LIMIT) timeUp(state);
  }
  return Object.assign(state, { justHappened: state.log.slice(mark) });
}

/** What the UI is allowed to show about the opponent, decided by the Glasses tribe. */
function visionOf(state, side) {
  const face = activeFace(state, side);
  if (face.fx.seeGenome) return 'genome';
  if (face.fx.seeSecondForm) return 'second';
  return 'none';
}

module.exports = {
  BEATS, FAVOURABLE, NEUTRAL, UNFAVOURABLE, MUTE_ARMOR, FLIP_FAIL_VIGOR, TURN_LIMIT,
  draw, createFighter, initiative, startFight, act, activeFace, houseMultiplier,
  forceOf, armorOf, runeCost, visionOf,
};
