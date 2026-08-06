'use strict';
// Adventure Mode controller: the layer between HTTP and the game core.
//
// Everything it needs from the outside is injected, so the whole surface is testable without a
// node, a wallet or a socket:
//
//   ownerOf(address, carrierKey)  -> { number } | { error }   live Alpha ownership
//   carrierTime(carrierKey)       -> { time, confirmations }  nTime of the tx holding the carrier
//   itemFor(number)               -> collection metadata item
//
// server.js should require THIS FILE LAZILY, inside the flag check:
//
//     if (ADVENTURE_ENABLED) { const { Adventure } = require('./adventure'); ... }
//
// The Arena's own modules are required at the top of server.js unconditionally, which is why a VPS
// missing one of them crash-loops on MODULE_NOT_FOUND even with the feature switched off. Adventure
// Mode pulls in five more files (adventure, stable, genetics, fertility, lifecycle); requiring them
// eagerly would widen that trap fivefold for a feature that is off by default.
//
// The controller owns two things the pure modules deliberately do not:
//   - PROOF OF OWNERSHIP. An Alpha is owned on chain, never in stable.json, so every breeding call
//     re-verifies it. A stale roster can never be spent as breeding stock.
//   - THE CARRIER'S CLOCK. Fertility is a fact about a UTXO (§1.1), so it is read per request and
//     never cached into our own state, where it could drift from the chain.

const { Stable } = require('./stable');
const { deriveFighter } = require('./game');
const G = require('./genetics');
const F = require('./fertility');

// The score every descendant enters the Arena with. See fighterFor(): it matches the bot's, so the
// rarity nudge between them is zero and genetics can never buy a coin flip (§4.2).
const NEUTRAL_RARITY = 100;

class Adventure {
  /**
   * @param {object}   opts
   * @param {string}   opts.dataDir
   * @param {Array}    opts.items          the collection metadata (3333 Alphas)
   * @param {Function} opts.ownerOf        async (address, carrierKey) -> {number}|{error}
   * @param {Function} opts.carrierTime    async (carrierKey) -> {time, confirmations}
   * @param {Function} [opts.now]          () => unix seconds
   * @param {object}   [opts.tuning]
   */
  constructor(opts = {}) {
    for (const k of ['dataDir', 'items', 'ownerOf', 'carrierTime', 'holdingsOf']) {
      if (!opts[k]) throw new Error(`Adventure: opts.${k} is required`);
    }
    this.holdingsOf = opts.holdingsOf;
    this.items = opts.items;
    this.pool = G.buildGenePool(opts.items);
    this.byNumber = new Map(opts.items.map((i) => [i.number, i]));
    this.ownerOf = opts.ownerOf;
    this.carrierTime = opts.carrierTime;
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
    this.tuning = opts.tuning || {};
    this.stable = new Stable({
      dataDir: opts.dataDir, pool: this.pool, now: this.now, tuning: this.tuning,
    }).load();
  }

  /**
   * Resolve one breeding parent. An Alpha is given as a carrier outpoint and verified on chain; a
   * descendant is given as an id and read from the stable.
   *
   * Returns { error } rather than throwing: every failure here is something a player did, not a
   * bug — they sold the Alpha, they mistyped an id, the carrier moved.
   */
  async parent(address, ref) {
    if (ref.carrierKey) {
      const owned = await this.ownerOf(address, ref.carrierKey);
      if (owned.error) return { error: owned.error };
      const item = this.byNumber.get(owned.number);
      if (!item) return { error: 'that Verginal is not in the Alpha collection' };
      const carrier = await this.carrierTime(ref.carrierKey);
      if (!carrier || !Number.isFinite(carrier.time)) return { error: 'could not read that carrier from the chain' };
      return {
        id: `alpha:${owned.number}`,
        genome: G.genomeFromItem(item, this.pool),
        carrier,
        alpha: true,
        number: owned.number,
      };
    }
    const c = this.stable.state.players[address] && this.stable.state.players[address].creatures[ref.id];
    if (!c || c.released) return { error: 'no such creature in your stable' };
    // §8 leaves open whether descendants also rest. They do not, for now: applying the two-day rest
    // to them as well would halve within-season depth, and the spec's own leaning is "Alphas only".
    return { id: c.id, genome: c.genome, carrier: null, alpha: false };
  }

  /** GET /adventure/stable */
  roster(address) {
    return this.stable.roster(address);
  }

  /**
   * GET /adventure/alphas — the breeding stock the player can actually pick from.
   *
   * Sorted so the ones that can breed right now come first and the resting ones sort by how soon
   * they will be ready: a player with a dozen Alphas should not have to hunt for the usable pair.
   *
   * Fertility costs one chain read per Alpha, so the list is capped. Someone holding more than the
   * cap has enough breeding stock that the tail is not what is stopping them.
   */
  async alphas(address, opts = {}) {
    const cap = opts.limit || 60;
    const held = (await this.holdingsOf(address)) || [];
    const rows = await Promise.all(held.slice(0, cap).map(async (h) => {
      const item = this.byNumber.get(h.number);
      if (!item) return null;
      const genome = G.genomeFromItem(item, this.pool);
      const carrier = await this.carrierTime(h.carrierKey);
      // A carrier the chain will not answer for is shown as unusable rather than hidden: silently
      // dropping an Alpha the player can see in their wallet reads as the game losing it.
      const state = carrier && Number.isFinite(carrier.time)
        ? F.fertility(carrier, this.now(), this.tuning)
        : { fertile: false, remaining: 0, readyAt: 0, reason: 'unreadable' };
      return {
        id: `alpha:${h.number}`,
        number: h.number,
        carrierKey: h.carrierKey,
        sex: genome.sex,
        traits: G.phenotype(genome, this.pool, `alpha:${h.number}`),
        fertile: state.fertile,
        readyAt: state.readyAt,
        label: state.reason === 'unreadable' ? 'Carrier unreadable right now' : F.describe(state),
      };
    }));
    const alphas = rows.filter(Boolean).sort((a, b) => (b.fertile - a.fertile) || (a.readyAt - b.readyAt));
    return {
      alphas,
      truncated: held.length > cap,
      females: alphas.filter((a) => a.sex === 'F').length,
      males: alphas.filter((a) => a.sex === 'M').length,
    };
  }

  /** POST /adventure/preview — what the pairing screen shows before the confirm button. */
  async preview(address, motherRef, fatherRef) {
    const m = await this.parent(address, motherRef);
    if (m.error) return { error: m.error };
    const f = await this.parent(address, fatherRef);
    if (f.error) return { error: f.error };
    if (m.id === f.id) return { error: 'a creature cannot breed with itself' };
    const pv = this.stable.preview(address, m, f);
    return {
      ...pv,
      mother: this._side(m),
      father: this._side(f),
    };
  }

  _side(p) {
    const out = { id: p.id, sex: p.genome.sex, alpha: p.alpha };
    if (p.carrier) {
      const state = F.fertility(p.carrier, this.now(), this.tuning);
      out.fertility = { ...state, label: F.describe(state) };
    }
    return out;
  }

  /** POST /adventure/pair — commits a seed, returns its hash. Nothing is decided yet. */
  async openPairing(address, motherRef, fatherRef) {
    const m = await this.parent(address, motherRef);
    if (m.error) return { error: m.error };
    const f = await this.parent(address, fatherRef);
    if (f.error) return { error: f.error };
    if (m.id === f.id) return { error: 'a creature cannot breed with itself' };
    const r = this.stable.openPairing(address, m, f);
    if (!r.ok) return { error: 'that pairing is not available', blockers: r.blockers };
    // Remember which parents this commitment was for, so the reveal cannot be resolved against a
    // different pair to fish for a better descendant.
    this.stable.state.players[address].pending[r.pairingId].refs = { motherRef, fatherRef };
    this.stable._save();
    return r;
  }

  /**
   * POST /adventure/pair/:id/resolve — reveals the seed and returns the descendant, or the honest
   * news that the pairing did not take.
   *
   * The parents are re-resolved and re-verified here: a player who sold an Alpha between committing
   * and revealing does not get to breed with it.
   */
  async resolvePairing(address, pairingId) {
    const p = this.stable.state.players[address];
    const pending = p && p.pending[pairingId];
    if (!pending) return { error: 'unknown pairing' };
    const m = await this.parent(address, pending.refs.motherRef);
    if (m.error) return { error: m.error };
    const f = await this.parent(address, pending.refs.fatherRef);
    if (f.error) return { error: f.error };
    if (m.id !== pending.motherId || f.id !== pending.fatherId) {
      return { error: 'those are not the parents this pairing was committed to' };
    }
    const r = this.stable.resolvePairing(address, pairingId, m, f);
    if (!r.ok) return { error: r.reason };
    if (!r.conceived) {
      return { conceived: false, seed: r.seed, viability: r.viability, message: 'The pairing did not take.' };
    }
    return {
      conceived: true,
      id: r.id,
      seed: r.seed,
      generation: r.generation,
      bornAt: r.bornAt,
      mutations: r.mutations,
      traits: G.phenotype(p.creatures[r.id].genome, this.pool, r.id),
    };
  }

  /** POST /adventure/creature/:id/attend */
  attend(address, id, kind) {
    if (!require('./lifecycle').ATTENTIONS.includes(kind)) return { error: 'unknown attention' };
    const r = this.stable.attend(address, id, kind);
    return r.ok ? r : { error: r.reason };
  }

  /** POST /adventure/creature/:id/release — §6, "choosing what not to keep". */
  release(address, id) {
    const r = this.stable.release(address, id);
    return r.ok ? r : { error: r.reason };
  }

  /** Called by the Arena when a bot fight finishes, so growth and record stay in one place. */
  recordFight(address, id, won) {
    const r = this.stable.recordFight(address, id, won);
    return r.ok === false ? { error: r.reason } : r;
  }

  /**
   * Turn a descendant into an Arena fighter.
   *
   * NEUTRAL_RARITY is the load-bearing line. game.js nudges the deciding coin flip toward the
   * higher rarity score, and handing a descendant its combos.js score would mean a well-bred
   * lineage literally wins more coin flips — the exact trap §4.2 forbids: "breeding changes how you
   * play, not how much you win", and "old lineages never become mathematically superior, so it does
   * not close to newcomers". A descendant therefore enters at the same score as the bot, so the
   * nudge between them is exactly zero.
   *
   * The rarity of what you bred is not discarded: it is the Genetics ladder (§2.1), scored by
   * combos.js at season end. It decides what you win, not whether you win.
   */
  fighterFor(address, id, opts = {}) {
    const c = this.stable.state.players[address] && this.stable.state.players[address].creatures[id];
    if (!c || c.released) return { error: 'no such creature in your stable' };
    const now = this.now();
    if (now < c.j.bornAt) return { error: 'it has not been born yet' };
    // Juveniles fight on purpose: bot mode is where a player learns a creature they have just bred
    // (§4.4), and it is one of the two ways a juvenile grows (§5.2).
    const attributes = G.toAttributes(c.genome, this.pool, c.id);
    const base = deriveFighter({ attributes }, { rarityScore: opts.neutralRarity || NEUTRAL_RARITY });
    return {
      fighter: { ...base, address, verginal: null, descendant: c.id },
      creature: c,
    };
  }

  /**
   * POST /adventure/creature/:id/fight — one bot duel, resolved by the Arena, then recorded here so
   * growth and the win record never live in two places.
   *
   * `play` is injected rather than imported so this module stays free of GameStore: the server
   * hands in a closure over its own store.
   */
  fight(address, id, loadout, play, clientSeed) {
    const f = this.fighterFor(address, id);
    if (f.error) return { error: f.error };
    let match;
    try { match = play(f.fighter, loadout); } catch (e) { return { error: e.message }; }
    const won = match && match.winner === address;
    const growth = this.recordFight(address, id, won);
    return {
      match,
      won: !!won,
      // Said plainly, because §5.2's whole point is that fighting is never capped and only the
      // first few of the day feed growth. A player who does not know which is which will assume
      // the fun was capped.
      counted: !!growth.counted,
      growth: growth.growth || 0,
      adult: !!growth.adult,
    };
  }
}

module.exports = { Adventure };
