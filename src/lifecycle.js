'use strict';
// Growing up, living slots and the season clock. See spec/ADVENTURE-MODE-v0.md §1, §5, §6, §7.
//
// One rule governs everything in this file, and breaking it breaks the game:
//
//     "Absence never subtracts. Presence adds."  (§5)
//
// Creatures made people quit by needing them and suffering without them. Here a juvenile grows on
// its own; attention makes it grow FASTER and decides WHAT IT BECOMES. There is no decay, no
// hunger, no streak, and no state in this module can ever move backwards. If a future change wants
// to subtract something, it is the wrong change.
//
// Pure, like the rest of the game core: every function takes state and returns new state. No clock
// is read here — the caller supplies `now`, so a whole season can be simulated in a test.
//
// --- reconciling §5.1, §5.2 and §5.3 --------------------------------------------------------
//
// The spec states three numbers that only fit together one way:
//   §5.1  "A juvenile can absorb three attentions per day"
//   §5.2  "Three [bot fights] count toward growth per day"
//   §5.3  "growth 6 points, at most 3 per day"
//
// Read as two separate growth sources they allow 6 points a day and an adult overnight, which
// contradicts §5.3's own "maturation: 2 days at full attention". So: attentions and counted fights
// are two separate ACTION budgets — which is what the daily-home screen shows, "2 of 3 attentions
// left" beside "3 of 3 count today" — feeding ONE shared growth cap of 3 per day. A player who
// only nurses and a player who only fights both progress; nobody has to do both.

const GROWTH_TO_ADULT = 6;      // §5.3
const GROWTH_PER_DAY = 3;       // §5.3, the shared cap
const ATTENTIONS_PER_DAY = 3;   // §5.1
const COUNTED_FIGHTS_PER_DAY = 3; // §5.2

// What a juvenile gains for simply existing. It is what makes absence cost nothing: at zero
// attention a descendant still reaches adulthood in six days, against two at full attention. Set
// this to 0 and the game becomes a chore with a login streak.
const PASSIVE_GROWTH_PER_DAY = 1;

const GESTATION_DAYS = 2;       // §5.3
const LIVING_SLOTS = 6;         // §6, "tuning: start around 6"
const SEASON_DAYS = 30;         // §1

// The four attentions (§5.1). Each matures the juvenile by the same amount — they differ in where
// they steer it, never in how fast. A "best" attention would collapse the choice.
const ATTENTIONS = ['spar', 'drill', 'feed', 'play'];

const DAY = 86400;

/** Which day of the season a timestamp falls in, 1-based. */
function seasonDay(seasonStart, now) {
  return Math.floor((now - seasonStart) / DAY) + 1;
}

// --- juveniles ------------------------------------------------------------------------------

/**
 * A newborn. `conceivedAt` is when the breeding transaction confirmed; the creature is not born,
 * and cannot be attended to, until gestation is over.
 */
function newJuvenile(id, conceivedAt, opts = {}) {
  const gestation = (opts.gestationDays === undefined ? GESTATION_DAYS : opts.gestationDays) * DAY;
  return {
    id,
    conceivedAt,
    bornAt: conceivedAt + gestation,
    growth: 0,
    attentions: { spar: 0, drill: 0, feed: 0, play: 0 },
    countedFights: 0,
    // Per-day ledgers, keyed by absolute day number so nothing has to be reset by a cron job.
    spent: {},
    lastAccruedDay: null,
  };
}

const dayNumber = (t) => Math.floor(t / DAY);
function ledger(j, day) {
  if (!j.spent[day]) j.spent[day] = { growth: 0, attentions: 0, fights: 0 };
  return j.spent[day];
}

function isBorn(j, now) { return now >= j.bornAt; }
function isAdult(j) { return j.growth >= GROWTH_TO_ADULT; }

/**
 * Passive growth, applied lazily. Called before any action and by status(), so a player who leaves
 * for a week comes back to a creature that grew while they were gone — the mechanical expression
 * of "absence never subtracts".
 *
 * Days already credited by attention or fighting are not topped up: the cap is the cap. This walks
 * whole days only, so it is O(days) and cannot drift.
 */
function accrue(j, now) {
  if (!isBorn(j, now) || isAdult(j)) return j;
  const today = dayNumber(now);
  let d = j.lastAccruedDay === null ? dayNumber(j.bornAt) : j.lastAccruedDay + 1;
  for (; d <= today && !isAdult(j); d++) {
    const l = ledger(j, d);
    const room = Math.min(GROWTH_PER_DAY - l.growth, GROWTH_TO_ADULT - j.growth);
    const gain = Math.min(PASSIVE_GROWTH_PER_DAY, Math.max(0, room));
    l.growth += gain;
    j.growth += gain;
  }
  j.lastAccruedDay = Math.max(j.lastAccruedDay === null ? -Infinity : j.lastAccruedDay, today);
  if (!Number.isFinite(j.lastAccruedDay)) j.lastAccruedDay = today;
  return j;
}

/** What the nursery card shows: budgets left today, and how far off adulthood is. */
function status(j, now) {
  accrue(j, now);
  const l = ledger(j, dayNumber(now));
  return {
    id: j.id,
    born: isBorn(j, now),
    bornAt: j.bornAt,
    adult: isAdult(j),
    growth: j.growth,
    growthToAdult: GROWTH_TO_ADULT,
    attentionsLeft: Math.max(0, ATTENTIONS_PER_DAY - l.attentions),
    fightsCountedLeft: Math.max(0, COUNTED_FIGHTS_PER_DAY - l.fights),
    growthLeftToday: Math.max(0, GROWTH_PER_DAY - l.growth),
    temperament: temperament(j),
  };
}

/**
 * Spend one attention. Returns { ok, reason, growth } — a refusal is never an error, because every
 * refusal here is a budget the player has already used, not a mistake.
 *
 * The growth may be 0 when the daily cap is already full from fighting. The attention still counts
 * toward temperament: what the creature becomes is shaped by everything you did with it, even on a
 * day when it could not grow any further.
 */
function attend(j, kind, now) {
  if (!ATTENTIONS.includes(kind)) throw new Error(`attend: unknown attention "${kind}"`);
  accrue(j, now);
  if (!isBorn(j, now)) return { ok: false, reason: 'gestating', growth: 0 };
  if (isAdult(j)) return { ok: false, reason: 'adult', growth: 0 };

  const l = ledger(j, dayNumber(now));
  if (l.attentions >= ATTENTIONS_PER_DAY) return { ok: false, reason: 'no attentions left today', growth: 0 };

  l.attentions += 1;
  j.attentions[kind] += 1;
  const gain = Math.min(1, GROWTH_PER_DAY - l.growth, GROWTH_TO_ADULT - j.growth);
  l.growth += gain;
  j.growth += gain;
  return { ok: true, reason: null, growth: gain, adult: isAdult(j) };
}

/**
 * Record a bot fight. Fighting is never capped (§5.2: "Thirty bot fights an evening is fine, and
 * encouraged") — only the first few of the day feed growth, which is what stops maturation
 * collapsing into two minutes of clicking without ever capping the fun.
 */
function recordFight(j, now) {
  accrue(j, now);
  if (!isBorn(j, now) || isAdult(j)) return { ok: true, counted: false, growth: 0 };

  const l = ledger(j, dayNumber(now));
  if (l.fights >= COUNTED_FIGHTS_PER_DAY) return { ok: true, counted: false, growth: 0 };

  l.fights += 1;
  j.countedFights += 1;
  const gain = Math.min(1, GROWTH_PER_DAY - l.growth, GROWTH_TO_ADULT - j.growth);
  l.growth += gain;
  j.growth += gain;
  return { ok: true, counted: true, growth: gain, adult: isAdult(j) };
}

/**
 * How the individual turned out. Two identical genomes raised differently are different creatures
 * (§5.1) — this is what makes a DNA Orb preserve a bloodline without preserving the animal.
 *
 * Ties resolve to null rather than to an arbitrary winner: an evenly raised creature is genuinely
 * balanced, and saying so is more honest than picking whichever attention sorts first.
 */
function temperament(j) {
  const entries = Object.entries(j.attentions).sort((a, b) => b[1] - a[1]);
  const [top, count] = entries[0];
  if (count === 0) return { dominant: null, label: 'Untouched', counts: { ...j.attentions } };
  if (entries[1] && entries[1][1] === count) return { dominant: null, label: 'Balanced', counts: { ...j.attentions } };
  return { dominant: top, label: LABELS[top], counts: { ...j.attentions } };
}

const LABELS = { spar: 'Scrapper', drill: 'Specialist', feed: 'Powerhouse', play: 'Free spirit' };

// --- living slots (§6) ----------------------------------------------------------------------

/**
 * A limit is a decision, not a penalty (§6): the player chooses what not to keep. So this reports
 * the state and never evicts anything itself.
 */
function slots(living, opts = {}) {
  const cap = opts.livingSlots === undefined ? LIVING_SLOTS : opts.livingSlots;
  return { used: living.length, cap, free: Math.max(0, cap - living.length), full: living.length >= cap };
}

// --- the season (§1, §7) --------------------------------------------------------------------

/**
 * Descendants die of age, at season end, ALL TOGETHER (§7). Never from neglect, never from a lost
 * fight, never from failing to log in. Alphas are untouched, which is what makes them the only
 * permanent breeding stock and the reason to own one.
 */
function seasonEnd(stable, opts = {}) {
  const days = opts.seasonDays === undefined ? SEASON_DAYS : opts.seasonDays;
  const alphas = stable.filter((c) => c.alpha);
  const descendants = stable.filter((c) => !c.alpha);
  return {
    seasonDays: days,
    survivors: alphas,
    died: descendants,
    // Everything that lived goes to the roster inscription, one per player per season (§7.1).
    roster: descendants.map((c) => ({
      id: c.id, genes: c.genes, sex: c.sex,
      mother: c.mother, father: c.father,
      record: c.record || null,
      temperament: c.attentions ? temperament(c).label : null,
    })),
  };
}

/** Days remaining, for the countdown chip that fills in silence all month (design pass 3b). */
function seasonClock(seasonStart, now, opts = {}) {
  const days = opts.seasonDays === undefined ? SEASON_DAYS : opts.seasonDays;
  const day = Math.min(days, Math.max(1, seasonDay(seasonStart, now)));
  return { day, days, left: days - day, endsAt: seasonStart + days * DAY };
}

module.exports = {
  DAY,
  GROWTH_TO_ADULT,
  GROWTH_PER_DAY,
  ATTENTIONS_PER_DAY,
  COUNTED_FIGHTS_PER_DAY,
  PASSIVE_GROWTH_PER_DAY,
  GESTATION_DAYS,
  LIVING_SLOTS,
  SEASON_DAYS,
  ATTENTIONS,
  newJuvenile,
  isBorn,
  isAdult,
  accrue,
  status,
  attend,
  recordFight,
  temperament,
  slots,
  seasonEnd,
  seasonClock,
  seasonDay,
};
