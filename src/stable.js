'use strict';
// The player's stable: who is alive, who is pregnant, who grew up, who is gone. Persisted to one
// JSON file with the same atomic-write pattern as GameStore and the order book, so Adventure Mode
// adds no native dependency and no database.
//
// This module is the only stateful thing in Adventure Mode. Everything it decides is computed by
// the three pure modules and simply recorded here:
//
//   src/genetics.js   what a pairing produces, and what it costs to pair relatives
//   src/fertility.js  whether an Alpha has rested (read off the chain, not stored here)
//   src/lifecycle.js  growing up, living slots, the season clock
//
// BREEDING IS COMMITTED AND REVEALED, exactly as duels are. The server publishes
// `serverSeedHash` when a pairing opens and the seed itself when the descendant is born, so a
// player can rerun genetics.breed() and confirm the animal they were given is the animal the seed
// produced. Without that, "the server decides what you bred" is an unfalsifiable claim, and this
// is a game whose entire premise is that breeding is worth doing.
//
// --- one mechanic the spec implies but never defines --------------------------------------------
//
// §6 says a player "can keep only a limited number of descendants alive at once" and that "going
// deep therefore means choosing what not to keep". Something therefore has to leave the stable
// mid-season. But §7 is absolute that descendants die of age at season end and NEVER from neglect,
// a lost fight, or a missed login.
//
// So release() is not death. A released descendant leaves your six slots, stops being breedable,
// and keeps its permanent page — it is still on the season roster, still in the Hall of Fame if it
// earned that. §7's "nothing is deleted, ever" holds. This was measured to be load-bearing rather
// than cosmetic: with six slots and no way out, a season stops at generation 1 (spec §7bis).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const G = require('./genetics');
const F = require('./fertility');
const L = require('./lifecycle');
const { serverSeedHash } = require('./game');

class Stable {
  /**
   * @param {object}   opts
   * @param {string}   opts.dataDir      dir holding stable.json
   * @param {object}   opts.pool         gene pool from genetics.buildGenePool()
   * @param {Function} [opts.now]        () => unix SECONDS, injectable for tests
   * @param {Function} [opts.serverSeed] () => hex, injectable for tests
   * @param {object}   [opts.tuning]     { livingSlots, seasonDays, restSeconds, mutationRate }
   */
  constructor(opts = {}) {
    if (!opts.pool) throw new Error('Stable: opts.pool is required (genetics.buildGenePool)');
    this.file = path.join(opts.dataDir, 'stable.json');
    this.pool = opts.pool;
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
    this.serverSeedFn = opts.serverSeed || (() => crypto.randomBytes(32).toString('hex'));
    this.tuning = opts.tuning || {};
  }

  load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.state = null;
    }
    if (!this.state) {
      this.state = {
        season: { id: 1, startedAt: this.now() },
        players: {},   // address -> { creatures: {id -> record}, released: [], pending: {} }
        seq: 0,
      };
      this._save();
    }
    return this;
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  _id(prefix) {
    this.state.seq += 1;
    return `${prefix}_${this.state.seq}_${this.now().toString(36)}`;
  }

  _player(address) {
    if (!this.state.players[address]) {
      this.state.players[address] = { creatures: {}, released: [], pending: {} };
    }
    return this.state.players[address];
  }

  /** Living descendants only — Alphas are owned on chain, never stored here. */
  _living(address) {
    return Object.values(this._player(address).creatures).filter((c) => !c.released);
  }

  /** The pedigree this player's relatedness maths runs on. Alphas are unrelated founders. */
  _pedigree(address) {
    const ped = {};
    const p = this._player(address);
    for (const c of Object.values(p.creatures)) ped[c.id] = { mother: c.mother, father: c.father };
    return ped;
  }

  // --- reading ---------------------------------------------------------------------------------

  /** Everything the daily-home screen needs, in one call. */
  roster(address) {
    const now = this.now();
    const living = this._living(address).map((c) => ({
      ...L.status(c.j, now),
      sex: c.sex,
      generation: c.generation,
      mother: c.mother,
      father: c.father,
      mutations: c.mutations,
      traits: G.phenotype(c.genome, this.pool, c.id),
      // Per-locus zygosity, because the pip bar's shape channel is the one piece of genetics the
      // UI cannot derive from the visible traits: a creature showing a common face looks identical
      // whether it carries a second copy of it or a hidden rarity. Sending 'hom'/'het' rather than
      // the allele pair keeps a player's carriers out of an opponent-readable payload.
      zygosity: Object.fromEntries(G.LOCI.map((l) => [l, G.zygosity(c.genome, l)])),
    }));
    this._save();
    return {
      season: L.seasonClock(this.state.season.startedAt, now, this.tuning),
      slots: L.slots(living, this.tuning),
      living,
      released: this._player(address).released.length,
      orbs: this._player(address).orbs || 0,
    };
  }

  /**
   * The pairing preview: everything the player weighs BEFORE confirming, in the shape §3.4 asks
   * for — one relation, one percentage. Never mutates anything.
   *
   * @param {object} mother { id, genome, carrier? }  carrier only for Alphas
   * @param {object} father same
   */
  preview(address, mother, father) {
    const now = this.now();
    const rel = G.pairingReport(this._pedigree(address), mother.id, father.id);
    const rest = (mother.carrier || father.carrier)
      ? F.canPair(
        { id: mother.id, carrier: mother.carrier || { time: 0, confirmations: 99 } },
        { id: father.id, carrier: father.carrier || { time: 0, confirmations: 99 } },
        now,
        this.tuning,
      )
      : { ok: true, blocked: [] };
    const slots = L.slots(this._living(address), this.tuning);

    const blockers = [];
    if (!rest.ok) for (const b of rest.blocked) blockers.push({ kind: 'resting', side: b.side, id: b.id, until: b.state.readyAt });
    if (slots.full) blockers.push({ kind: 'slots', used: slots.used, cap: slots.cap });
    if (mother.genome.sex !== 'F' || father.genome.sex !== 'M') blockers.push({ kind: 'sex' });

    return {
      ok: blockers.length === 0,
      blockers,
      relation: rel.relation,
      viability: rel.viability,
      penaltyPct: rel.penaltyPct,
      coefficient: rel.coefficient,
      slots,
      // The one line the confirm button sits under.
      warning: rel.penaltyPct > 0 ? `${rel.relation}. Offspring viability −${rel.penaltyPct}%.` : null,
    };
  }

  // --- breeding --------------------------------------------------------------------------------

  /**
   * Open a pairing: commits a seed and returns its hash. Nothing is decided yet, and the server
   * cannot change its mind afterwards without the hash failing.
   */
  openPairing(address, mother, father) {
    const pv = this.preview(address, mother, father);
    if (!pv.ok) return { ok: false, blockers: pv.blockers };

    const seed = this.serverSeedFn();
    const id = this._id('pair');
    this._player(address).pending[id] = {
      id, seed, motherId: mother.id, fatherId: father.id, openedAt: this.now(), viability: pv.viability,
    };
    this._save();
    return { ok: true, pairingId: id, serverSeedHash: serverSeedHash(seed), viability: pv.viability };
  }

  /**
   * Resolve a committed pairing. Reveals the seed so the player can recompute the descendant.
   *
   * The viability roll happens here and it is the one place a pairing can simply not take. That is
   * the entire cost of inbreeding: not a weaker fighter (§4.2 forbids that), just a pairing that
   * did not produce anything, and two days of the Alpha's rest spent for nothing.
   */
  resolvePairing(address, pairingId, mother, father) {
    const p = this._player(address);
    const pending = p.pending[pairingId];
    if (!pending) return { ok: false, reason: 'unknown pairing' };
    delete p.pending[pairingId];

    const now = this.now();
    // One draw from the revealed seed decides viability, so the roll is verifiable too.
    const roll = require('./game').rngFromSeed(`viability:${pending.seed}`)();
    if (roll >= pending.viability) {
      this._save();
      return { ok: true, conceived: false, seed: pending.seed, viability: pending.viability, roll };
    }

    const id = this._id('d');
    const kid = G.breed(mother.genome, father.genome, pending.seed, { pool: this.pool, id, ...this.tuning });
    const generation = 1 + Math.max(
      p.creatures[mother.id] ? p.creatures[mother.id].generation : 0,
      p.creatures[father.id] ? p.creatures[father.id].generation : 0,
    );
    p.creatures[id] = {
      id,
      genome: kid,
      sex: kid.sex,
      mother: mother.id,
      father: father.id,
      generation,
      mutations: kid.mutations,
      conceivedAt: now,
      j: L.newJuvenile(id, now, this.tuning),
      released: false,
      record: { fights: 0, wins: 0 },
    };
    this._save();
    return {
      ok: true, conceived: true, id, seed: pending.seed, generation,
      mutations: kid.mutations, bornAt: p.creatures[id].j.bornAt,
    };
  }

  // --- raising ---------------------------------------------------------------------------------

  attend(address, id, kind) {
    const c = this._player(address).creatures[id];
    if (!c || c.released) return { ok: false, reason: 'no such creature' };
    const r = L.attend(c.j, kind, this.now());
    this._save();
    return r;
  }

  recordFight(address, id, won) {
    const c = this._player(address).creatures[id];
    if (!c || c.released) return { ok: false, reason: 'no such creature' };
    const r = L.recordFight(c.j, this.now());
    c.record.fights += 1;
    if (won) c.record.wins += 1;
    this._save();
    return r;
  }

  /**
   * Step out of the stable — §6's "choosing what not to keep". Not a death and not a deletion: the
   * creature keeps its page, its record and its place on the season roster.
   */
  release(address, id) {
    const c = this._player(address).creatures[id];
    if (!c || c.released) return { ok: false, reason: 'no such creature' };
    c.released = true;
    c.releasedAt = this.now();
    this._player(address).released.push(id);
    this._save();
    return { ok: true, id, slots: L.slots(this._living(address), this.tuning) };
  }

  // --- season end ------------------------------------------------------------------------------

  /**
   * Every descendant dies, together, of age (§7). Returns each player's roster for the single
   * inscription per player per season that §7.1 specifies — released creatures included, because
   * they lived.
   */
  /**
   * The two ladders (§2.1), scored over one player's season.
   *
   * Combat measures the Arena record; Genetics measures the rarity of what was bred, scored by the
   * engine that already runs in production. The second exists because a player who breeds something
   * extraordinary but cannot fight would otherwise lose a month of work — and the breeder archetype
   * is real.
   *
   * @param {Function} rarityOf (attributes) -> number, injected so this module never imports the
   *   rarity engine and stays testable without the collection.
   */
  ladders(address, rarityOf) {
    const all = Object.values(this._player(address).creatures);
    const combat = all
      .map((c) => ({ id: c.id, wins: c.record.wins, fights: c.record.fights }))
      .sort((a, b) => b.wins - a.wins || a.fights - b.fights);
    const genetics = all
      .map((c) => ({ id: c.id, score: rarityOf(G.toAttributes(c.genome, this.pool, c.id)) }))
      .sort((a, b) => b.score - a.score);
    return { combat, genetics };
  }

  /**
   * Grant DNA Orbs. Top 10% of each ladder (§2.1) — a percentage rather than a fixed number, so a
   * small community still has winners and it scales on its own if the game grows. At least one, or
   * a season with nine players would award nothing at all.
   *
   * An Orb is not a trophy. It is the save file for a month of breeding work, and the only thing
   * besides an Alpha that crosses a season boundary — which is what makes it the most desirable
   * object in the game while being worth nothing in money.
   */
  grantOrbs(address, rarityOf, opts = {}) {
    const share = opts.share === undefined ? 0.1 : opts.share;
    const l = this.ladders(address, rarityOf);
    const take = (rows) => rows.slice(0, Math.max(1, Math.ceil(rows.length * share))).map((r) => r.id);
    const winners = new Set([...take(l.combat), ...take(l.genetics)]);
    const p = this._player(address);
    // One Orb per player per season however many ladders they topped: the Orb carries ONE bloodline
    // (§2), so a second would not mean anything to spend.
    p.orbs = (p.orbs || 0) + (winners.size ? 1 : 0);
    return { orbs: p.orbs, eligible: [...winners], ladders: l };
  }

  /**
   * Spend the Orb: clone one bloodline into the season now running (§2).
   *
   * The genome carries; the individual does not. The clone is born a juvenile with no attentions, no
   * record and no temperament, because §5.1 is what makes the Orb interesting — two identical
   * genomes raised differently are different creatures, so winning does not hand you last month's
   * animal back, it hands you another go at it.
   */
  spendOrb(address, savedId) {
    const p = this._player(address);
    if (!p.orbs) return { ok: false, reason: 'you have no DNA Orb' };
    const saved = (p.saved || []).find((s) => s.id === savedId);
    if (!saved) return { ok: false, reason: 'that bloodline is not on your saved roster' };
    if (L.slots(this._living(address), this.tuning).full) return { ok: false, reason: 'no free living slot' };

    const now = this.now();
    const id = this._id('d');
    p.orbs -= 1;
    p.saved = [];  // one Orb, one bloodline, no undo
    p.creatures[id] = {
      id,
      genome: { ...saved.genome, id, alpha: false },
      sex: saved.genome.sex,
      // The clone is its own founder: its parents died with the season, so nothing in this season's
      // pedigree relates it to anything. That is deliberate — a carried bloodline is fresh blood
      // for everyone else, which is the §3.4 remedy arriving from somewhere.
      mother: null,
      father: null,
      generation: 0,
      mutations: [],
      conceivedAt: now - (this.tuning.gestationDays === undefined ? L.GESTATION_DAYS : this.tuning.gestationDays) * L.DAY,
      j: L.newJuvenile(id, now - (this.tuning.gestationDays === undefined ? L.GESTATION_DAYS : this.tuning.gestationDays) * L.DAY, this.tuning),
      released: false,
      record: { fights: 0, wins: 0 },
      clonedFrom: savedId,
    };
    this._save();
    return { ok: true, id, orbs: p.orbs };
  }

  endSeason() {
    const rosters = {};
    for (const [address, p] of Object.entries(this.state.players)) {
      const all = Object.values(p.creatures);
      const byId = new Map(all.map((c) => [c.id, c]));
      // Joined by id, not by index: seasonEnd() is free to filter or reorder its roster without
      // silently attaching one creature's generation to another's record.
      rosters[address] = L.seasonEnd(all.map((c) => ({
        id: c.id, alpha: false, genes: c.genome.genes, sex: c.sex,
        mother: c.mother, father: c.father, record: c.record, attentions: c.j.attentions,
      }))).roster.map((r) => ({
        ...r,
        generation: byId.get(r.id).generation,
        released: byId.get(r.id).released,
      }));
      // Kept so an Orb has something to spend on. Everything else about the season is gone.
      p.saved = rosters[address].map((r) => ({
        id: r.id,
        genome: byId.get(r.id).genome,
        record: r.record,
        generation: byId.get(r.id).generation,
      }));
      p.creatures = {};
      p.released = [];
      p.pending = {};
      p.duels = {};
    }
    this.state.season = { id: this.state.season.id + 1, startedAt: this.now() };
    this._save();
    return { season: this.state.season, rosters };
  }
}

module.exports = { Stable };
