'use strict';
// The vivarium: an event queue, not a tick loop.
//
// The whole point of this file is that a five day absence and a five day presence produce the same
// world. Time is an integer count of minutes; every entity knows the minute of its next event; the
// queue pops in order. Reconnecting after 120 hours costs the same work as reconnecting after 121,
// and the result cannot be changed by touching the system clock, because every draw is seeded on
// (vivarium id, tick, entity id) rather than on Math.random.
//
// It is also the reason the player gets a logbook instead of a catch-up animation. Resolving the
// absence produces the events, in order, with timestamps; The Log is just that list rendered.
//
// BEDROCK IS NOT OPTIONAL. Left alone long enough this simulation kills everything, and a player
// who reconnects to sterile dirt does not reconnect twice. Seeds survive in the substrate, the last
// two Nubbins enter torpor rather than starve, and Roe waits in the silt. Recovery costs about six
// hours of play, which is a punishment. Extinction is not a punishment, it is an exit.

const MIN = 1;
const HOUR = 60;

const SPECIES = {
  Clover:   { mature: 20,  greensEvery: 30,  aquatic: false },
  Carrot:   { mature: 60,  greensEvery: 30,  aquatic: false },
  Duckweed: { mature: 40,  greensEvery: 0,   aquatic: true, oxygen: 2, algaeSlow: 0.5 },
  Catnip:   { mature: 180, catnipEvery: 360, aquatic: false },
};

const NUBBIN = { mealEvery: 30, dropEvery: 60, birthEvery: 12 * HOUR, starveAfter: 90 };
const GLIM   = { mealEvery: 60, roeEvery: 24 * HOUR, birthEvery: 12 * HOUR, starveAfter: 3 * HOUR };

const NITRATE_PER_DROPPING = 2;
// Irrigation is the burst, but it cannot be the ONLY path. A Glim starves in three hours and the
// basin only overflows when the player pours, so with irrigation alone the fish die every single
// cycle no matter how well the vivarium is run: the doc's own equilibrium arithmetic quietly
// assumed droppings converted continuously. They seep, slowly, at a quarter of the rate and only
// while the substrate is damp. Irrigation is still worth pouring for, it delivers the rest at once.
const SEEP_EVERY = 60;
const SEEP_PER_DROPPING = 0.5;
const NITRATE_PER_ALGAE = 4;
const ALGAE_EVERY = 60;
const EVAPORATE_EVERY = 30;
const HUMIDITY_DECAY_EVERY = 10;
const WILT_AFTER = 3 * HOUR;
const HUMIDITY_FLOOR = 30;

const FLOOD_THRESHOLD = 40;      // water poured in one action
const TORPOR_FLOOR = 3;          // Nubbins below this stop eating instead of dying
const ROE_HATCH_ALGAE = 4;
const REPLAY_CAP_DAYS = 30;

// --- deterministic draws --------------------------------------------------------------------

function draw(id, tick, entityId, salt = '') {
  let h = 0x811c9dc5;
  const s = `${id}|${tick}|${entityId}|${salt}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 8) / 0x1000000;
}

// --- construction ---------------------------------------------------------------------------

function createVivarium(id, { tiles = 16, basinCap = 100, now = 0 } = {}) {
  return {
    id, tiles, basinCap,
    basin: { water: 0, nitrate: 0, algae: 0 },
    plants: [], nubbins: [], glims: [],
    greens: 0, droppings: 0, roe: 0, catnip: 0,
    humidity: 50,
    seedBank: {},
    cistern: null,
    lastTick: now,
    nextId: 1,
    log: [],
  };
}

const freeTiles = (v) => v.tiles - v.plants.filter((p) => p.alive && !SPECIES[p.species].aquatic).length;

function plant(v, species, at = v.lastTick) {
  if (!SPECIES[species]) return null;
  if (!SPECIES[species].aquatic && freeTiles(v) <= 0) return null;
  const p = {
    id: `p${v.nextId++}`, species, stage: 'seed',
    maturesAt: at + SPECIES[species].mature,
    nextYield: null, dryFor: 0, alive: true,
  };
  v.plants.push(p);
  return p;
}

function addNubbin(v, at = v.lastTick) {
  const n = { id: `n${v.nextId++}`, nextMeal: at + NUBBIN.mealEvery, nextDrop: at + NUBBIN.dropEvery,
              nextBirth: at + NUBBIN.birthEvery, hungrySince: null, torpid: false, alive: true };
  v.nubbins.push(n); return n;
}

function addGlim(v, at = v.lastTick) {
  const g = { id: `g${v.nextId++}`, nextMeal: at + GLIM.mealEvery, nextRoe: at + GLIM.roeEvery,
              nextBirth: at + GLIM.birthEvery, hungrySince: null, alive: true };
  v.glims.push(g); return g;
}

// --- player actions -------------------------------------------------------------------------

/**
 * Pour water.
 *
 * Two effects, deliberately split. Watering damps the substrate straight away, in proportion to
 * what you poured; only crossing the overflow lip washes the droppings into the basin as nitrate.
 * They were one effect at first and that was a trap: the lip sits at 80 units and pouring more than
 * 40 at once floods, so a player who did the obvious thing and emptied their flask got nothing at
 * all, twice, and then watched their plants wilt. Damp is cheap, nitrogen needs the flood tide.
 */
function pour(v, units, at = v.lastTick) {
  const events = [];
  const flooded = units > FLOOD_THRESHOLD;
  v.basin.water = Math.min(v.basinCap, v.basin.water + units);
  v.humidity = Math.min(100, v.humidity + units);
  for (const p of v.plants) p.dryFor = 0;
  events.push({ tick: at, type: 'poured', units, humidity: v.humidity });

  if (flooded) {
    const drowned = v.nubbins.filter((n) => n.alive).slice(0, 2);
    for (const n of drowned) { n.alive = false; events.push({ tick: at, type: 'drowned', id: n.id }); }
    v.basin.nitrate = Math.floor(v.basin.nitrate / 2);
    for (const p of v.plants) if (p.stage === 'seed') { p.alive = false; events.push({ tick: at, type: 'washedOut', id: p.id }); }
    events.push({ tick: at, type: 'flood' });
  }
  if (v.basin.water >= v.basinCap * 0.8) events.push(...irrigate(v, at));
  v.log.push(...events);
  return events;
}

function irrigate(v, at) {
  const events = [{ tick: at, type: 'irrigation' }];
  v.humidity = 100;
  for (const p of v.plants) p.dryFor = 0;
  if (v.droppings > 0) {
    const n = v.droppings * NITRATE_PER_DROPPING;
    v.basin.nitrate += n;
    events.push({ tick: at, type: 'nitrate', amount: n, from: v.droppings });
    v.droppings = 0;
  }
  return events;
}

// --- resolution -----------------------------------------------------------------------------

function nextEventOf(e, kind) {
  if (!e.alive) return Infinity;
  if (kind === 'plant') {
    if (e.stage === 'seed') return e.maturesAt;
    return e.nextYield === null ? Infinity : e.nextYield;
  }
  if (kind === 'nubbin') return Math.min(e.torpid ? Infinity : e.nextMeal, e.nextDrop, e.nextBirth);
  return Math.min(e.nextMeal, e.nextRoe, e.nextBirth);
}

/**
 * Advance the world to `nowTick`. Returns the log of everything that happened, in order, which is
 * exactly what The Log renders. O(events), not O(minutes x entities).
 */
function resolve(v, nowTick) {
  const events = [];
  const capped = Math.min(nowTick, v.lastTick + REPLAY_CAP_DAYS * 24 * HOUR);
  if (capped < nowTick) events.push({ tick: v.lastTick, type: 'dormancy', days: Math.floor((nowTick - capped) / (24 * HOUR)) });

  // World clocks, which do not belong to any entity.
  let nextEvap = v.lastTick + EVAPORATE_EVERY;
  let nextSeep = v.lastTick + SEEP_EVERY;
  let nextDry = v.lastTick + HUMIDITY_DECAY_EVERY;
  let nextAlgae = v.lastTick + ALGAE_EVERY;

  let guard = 0;
  while (guard++ < 200000) {
    let t = Infinity, pick = null;
    const consider = (tick, fn) => { if (tick < t) { t = tick; pick = fn; } };

    consider(nextEvap, () => { stepEvaporation(v, t, events); nextEvap = t + EVAPORATE_EVERY; });
    consider(nextDry,  () => { stepHumidity(v, t, events);   nextDry  = t + HUMIDITY_DECAY_EVERY; });
    consider(nextAlgae,() => { stepAlgae(v, t, events);      nextAlgae = t + ALGAE_EVERY; });
    consider(nextSeep, () => { stepSeep(v, t, events);       nextSeep = t + SEEP_EVERY; });
    for (const p of v.plants) consider(nextEventOf(p, 'plant'),  () => stepPlant(v, p, t, events));
    for (const n of v.nubbins) consider(nextEventOf(n, 'nubbin'), () => stepNubbin(v, n, t, events));
    for (const g of v.glims)   consider(nextEventOf(g, 'glim'),   () => stepGlim(v, g, t, events));

    if (!pick || t > capped) break;
    pick();
  }

  v.lastTick = nowTick;
  v.plants = v.plants.filter((p) => p.alive);
  bedrock(v, nowTick, events);
  v.log.push(...events);
  return events;
}

function stepEvaporation(v, t, events) {
  const dose = v.cistern && v.cistern.water > 0 ? Math.min(v.cistern.dosePerTick, v.cistern.water) : 0;
  if (dose) { v.cistern.water -= dose; v.basin.water = Math.min(v.basinCap, v.basin.water + dose); }
  const before = v.basin.water;
  v.basin.water = Math.max(0, v.basin.water - 1);
  if (before > 0 && v.basin.water === 0) events.push({ tick: t, type: 'basinDry' });
}

function stepHumidity(v, t, events) {
  v.humidity = Math.max(0, v.humidity - 1);
  if (v.humidity >= HUMIDITY_FLOOR) return;
  for (const p of v.plants) {
    if (!p.alive || SPECIES[p.species].aquatic) continue;
    p.dryFor += HUMIDITY_DECAY_EVERY;
    if (p.dryFor >= WILT_AFTER) {
      p.alive = false;
      v.seedBank[p.species] = Math.max(2, (v.seedBank[p.species] || 0) + 1);
      events.push({ tick: t, type: 'wilted', id: p.id, species: p.species });
    }
  }
}

function stepSeep(v, t, events) {
  if (v.droppings <= 0 || v.humidity < HUMIDITY_FLOOR) return;
  const n = Math.floor(v.droppings * SEEP_PER_DROPPING);
  if (n < 1) return;
  const spent = Math.ceil(n / NITRATE_PER_DROPPING);
  v.droppings -= spent;
  v.basin.nitrate += n;
  events.push({ tick: t, type: 'seep', amount: n });
}

function stepAlgae(v, t, events) {
  if (v.basin.water <= 0) return;
  const slow = v.plants.some((p) => p.alive && p.species === 'Duckweed' && p.stage === 'mature');
  const want = slow ? 1 : 2;
  let grew = 0;
  while (grew < want && v.basin.nitrate >= NITRATE_PER_ALGAE) { v.basin.nitrate -= NITRATE_PER_ALGAE; v.basin.algae += 1; grew++; }
  if (grew) events.push({ tick: t, type: 'algae', amount: grew });
  if (v.roe > 0 && v.basin.algae >= ROE_HATCH_ALGAE) {
    v.roe -= 1; addGlim(v, t);
    events.push({ tick: t, type: 'hatched', from: 'silt' });
  }
}

function stepPlant(v, p, t, events) {
  const sp = SPECIES[p.species];
  if (p.stage === 'seed') {
    p.stage = 'mature';
    p.nextYield = sp.greensEvery ? t + sp.greensEvery : (sp.catnipEvery ? t + sp.catnipEvery : null);
    events.push({ tick: t, type: 'matured', id: p.id, species: p.species });
    return;
  }
  if (sp.greensEvery) { v.greens += 1; p.nextYield = t + sp.greensEvery; events.push({ tick: t, type: 'greens', id: p.id }); }
  else if (sp.catnipEvery) { v.catnip += 1; p.nextYield = t + sp.catnipEvery; events.push({ tick: t, type: 'catnip', id: p.id }); }
}

function stepNubbin(v, n, t, events) {
  if (!n.torpid && t >= n.nextMeal) {
    if (v.greens > 0) {
      v.greens -= 1; n.hungrySince = null; n.nextMeal = t + NUBBIN.mealEvery;
      events.push({ tick: t, type: 'ate', id: n.id, what: 'greens' });
    } else {
      if (n.hungrySince === null) n.hungrySince = t;
      n.nextMeal = t + 10;
      if (t - n.hungrySince >= NUBBIN.starveAfter) {
        const alive = v.nubbins.filter((x) => x.alive).length;
        if (alive <= TORPOR_FLOOR - 1) { n.torpid = true; events.push({ tick: t, type: 'torpor', id: n.id }); }
        else { n.alive = false; events.push({ tick: t, type: 'starved', id: n.id, species: 'Nubbin' }); return; }
      }
    }
  }
  if (t >= n.nextDrop) { if (!n.torpid) { v.droppings += 1; events.push({ tick: t, type: 'dropping', id: n.id }); } n.nextDrop = t + NUBBIN.dropEvery; }
  if (t >= n.nextBirth) {
    n.nextBirth = t + NUBBIN.birthEvery;
    if (!n.torpid && n.hungrySince === null) { addNubbin(v, t); events.push({ tick: t, type: 'born', species: 'Nubbin' }); }
  }
}

function stepGlim(v, g, t, events) {
  if (t >= g.nextMeal) {
    if (v.basin.algae > 0) {
      v.basin.algae -= 1; g.hungrySince = null; g.nextMeal = t + GLIM.mealEvery;
      events.push({ tick: t, type: 'ate', id: g.id, what: 'algae' });
    } else {
      if (g.hungrySince === null) g.hungrySince = t;
      g.nextMeal = t + 15;
      if (t - g.hungrySince >= GLIM.starveAfter) {
        g.alive = false;
        // A corpse is nitrogen. This is what turns a fish die-off into an algae bloom twelve hours
        // later, and then into a second die-off. Nobody wrote the oscillation; it is the rules.
        v.basin.nitrate += 6;
        events.push({ tick: t, type: 'asphyxiated', id: g.id });
        return;
      }
    }
  }
  if (t >= g.nextRoe) { v.roe += 1; g.nextRoe = t + GLIM.roeEvery; events.push({ tick: t, type: 'roe', id: g.id }); }
  if (t >= g.nextBirth) {
    g.nextBirth = t + GLIM.birthEvery;
    if (g.hungrySince === null && v.basin.algae > 0) { addGlim(v, t); addGlim(v, t); events.push({ tick: t, type: 'born', species: 'Glim', count: 2 }); }
  }
}

/** The floor. Never lets the world reach a state a player cannot restart from. */
function bedrock(v, t, events) {
  v.nubbins = v.nubbins.filter((n) => n.alive);
  v.glims = v.glims.filter((g) => g.alive);
  for (const p of v.plants) if (!p.alive) v.seedBank[p.species] = Math.max(2, v.seedBank[p.species] || 0);
  for (const sp of Object.keys(v.seedBank)) v.seedBank[sp] = Math.max(2, v.seedBank[sp]);
  if (v.nubbins.length === 0 && v.roe === 0 && Object.keys(v.seedBank).length === 0) return;
  if (v.nubbins.length && v.nubbins.length < TORPOR_FLOOR) {
    for (const n of v.nubbins) if (!n.torpid) { n.torpid = true; events.push({ tick: t, type: 'torpor', id: n.id }); }
  }
}

/** Everything the player is shown at a glance, plus the one number that says how it is going. */
function snapshot(v) {
  const mature = v.plants.filter((p) => p.alive && p.stage === 'mature').length;
  const nubbins = v.nubbins.length, glims = v.glims.length;
  return {
    tiles: v.tiles, freeTiles: freeTiles(v), mature, nubbins, glims,
    water: v.basin.water, nitrate: v.basin.nitrate, algae: v.basin.algae,
    greens: v.greens, droppings: v.droppings, roe: v.roe, catnip: v.catnip,
    humidity: v.humidity,
    // The three verified ratios: one mature plant per Nubbin, two Nubbins per Glim.
    balance: { plantsPerNubbin: nubbins ? mature / nubbins : null, nubbinsPerGlim: glims ? nubbins / glims : null },
  };
}

module.exports = {
  HOUR, SPECIES, NUBBIN, GLIM, FLOOD_THRESHOLD, TORPOR_FLOOR, REPLAY_CAP_DAYS, SEEP_EVERY,
  createVivarium, plant, addNubbin, addGlim, pour, irrigate, resolve, snapshot, freeTiles, draw,
};
