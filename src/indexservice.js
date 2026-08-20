'use strict';
// One scan, two ledgers.
//
// Verginals and Verge Runes are not two chains. A rune etching IS an inscription (RUNES-SPEC-v0 §1):
// the same P2SH reveal, parsed by the same envelope code, distinguished only by its content type. So
// running two indexers over the same blocks meant fetching every block twice, parsing every reveal
// twice, and resolving every input value twice.
//
// Sharing the fetch is the small reason. These are the real ones:
//
//   A coin's safety needs BOTH answers at once. A wallet may only spend a coin for its value when it
//   carries no inscription AND no rune (see coinselect.js, which exists to stop exactly that loss).
//   Two services drift to different heights by construction, so a coin can read as clean because one
//   of them has not caught up, and the token on it is spent to a miner. One service has one height
//   and therefore one answer.
//
//   A rune's parent claim can finally be CHECKED. An etching may name a parent inscription, and
//   nothing verified it: any rune could claim to belong to any collection. The inscription indexer
//   has always verified its own parent claims by requiring the transaction to spend the parent, and
//   now the rune side can borrow that set instead of taking the claim on faith.
//
//   Mint prices come free. Resolving a transaction's fee costs one lookup per input, which is why
//   §7.3 makes txindex a requirement. Those very numbers are already resolved for every block to
//   place inscriptions by offset, so the rune side now reads them instead of asking again.
//
// What is NOT shared is the rules. Two state machines go in, two come out, and neither knows the
// other exists. runes/indexer.js stays a pure function of (state, tx) because the conformance harness
// and the second implementation depend on that; this file is a driver, not a referee.

const { Indexer, CHECKPOINT_INTERVAL } = require('./indexer');
const { xvgToUnits } = require('./rpc');
const { BlockTrail, findFork, TRAIL_DEPTH } = require('./reorg');
const { RuneState, applyTx } = require('./runes/indexer');
const { toIndexerTx, detectEtching } = require('./runes/scanner');

// How often a full copy of the state is kept so a reorg can be repaired by rewinding instead of
// rebuilding. Matched to the inscription digest interval so the two land on the same heights.
const SNAPSHOT_INTERVAL = CHECKPOINT_INTERVAL;
const SNAPSHOTS_KEPT = 2;

// A repaired scan may land on another fork if the chain is still settling. Each pass rewinds
// further, so a small bound is enough; past it, something is wrong that retrying will not fix.
const MAX_REPAIRS = 3;

class ReorgTooDeep extends Error {
  constructor(height) {
    super(`the chain reorganised further back than ${height}, which is deeper than this index can `
      + 'repair itself. Delete the state file and rebuild.');
    this.name = 'ReorgTooDeep';
    this.height = height;
  }
}

class IndexService {
  /**
   * @param {Object} p
   * @param {Object} p.chain        VergeChain
   * @param {number} p.from         first height to index inscriptions from
   * @param {number} [p.runesFrom]  first height to index runes from (defaults to `from`)
   * @param {boolean} [p.runes]     index runes at all
   */
  constructor({ chain, from, runesFrom = null, runes = true, trailDepth = TRAIL_DEPTH,
    snapshotInterval = SNAPSHOT_INTERVAL, onSnapshot = null, runeOpts = null } = {}) {
    this.chain = chain;
    this.from = from;
    // The rune rules that a different chain needs different numbers for: the activation height and
    // the maturity delay. Left null the mainnet values apply, which is the safe direction to forget
    // in. Regtest cannot reach block 9,420,420 and would otherwise index nothing at all.
    this.runeOpts = runeOpts || undefined;
    // Called each time a snapshot is taken, which is the natural moment to write to disk: a cold
    // scan of the whole chain takes minutes and a kill part way through should not throw it away.
    this.onSnapshot = onSnapshot;
    this.runesFrom = runesFrom == null ? from : runesFrom;
    this.indexRunes = runes;
    this.snapshotInterval = snapshotInterval;

    this.inscriptions = new Indexer();
    this.runes = new RuneState();
    this.trail = new BlockTrail(trailDepth);
    this.scannedThrough = from - 1;
    this.snapshots = [];       // [{ height, state }] oldest first
    this.reorgs = 0;           // how many were repaired, for the status endpoint
    this._scanning = null;
  }

  // --- applying one block -------------------------------------------------------------------

  /**
   * Feed one decoded block to both state machines.
   *
   * Transactions are interleaved rather than run as two passes, because a parent claim is verified
   * against the inscriptions the transaction SPENDS, and a reveal earlier in the same block can be
   * the parent of a transfer later in it. Reading that set has to happen before the inscription
   * indexer consumes those locations.
   */
  applyBlock(block) {
    const height = block.height;
    const raw = block.raw || { tx: [] };
    const withRunes = this.indexRunes && height >= this.runesFrom;

    for (let i = 0; i < block.txs.length; i++) {
      const decoded = block.txs[i];
      const rawTx = raw.tx[i];

      let extra = null;
      if (withRunes && rawTx) {
        const etching = detectEtching(rawTx);
        extra = { time: block.time };
        if (etching) {
          // §10.2, borrowed from the inscription layer: a parent is only a parent if this
          // transaction spends it. An unverifiable claim is dropped rather than made fatal, so the
          // rune still etches, it just does not get to say whose collection it is in.
          if (etching.parent && !this.spentInscriptions(rawTx).has(etching.parent)) {
            etching.parent = null;
          }
          extra.etching = etching;
        }
        const fee = this.feeOf(rawTx, block.prevValues);
        if (fee !== null) extra.fee = fee;
      }

      this.inscriptions.processTx(decoded, height);
      if (extra) applyTx(this.runes, toIndexerTx(rawTx, height, i, extra), this.runeOpts);
    }

    // Mirrors Indexer.processBlock, which this method replaces: the digest is taken AFTER the block
    // is fully applied, so a checkpoint at H means "the state once block H is in".
    if (height % CHECKPOINT_INTERVAL === 0) {
      this.inscriptions.checkpoints.set(height, this.inscriptions.digest());
    }

    this.trail.record(height, block.hash);
    this.scannedThrough = height;
    if (this.snapshotInterval > 0 && height % this.snapshotInterval === 0) this.snapshot();
  }

  /** The inscriptions this transaction's inputs carry, before it is applied. */
  spentInscriptions(rawTx) {
    const ids = new Set();
    for (const vin of rawTx.vin || []) {
      if (vin.coinbase !== undefined) continue;
      const at = this.inscriptions.locations.get(`${vin.txid}:${vin.vout}`);
      if (at) for (const { id } of at) ids.add(id);
    }
    return ids;
  }

  /**
   * The fee this transaction paid, from values the block fetch already resolved.
   *
   * Returns null when any input value is missing, and callers must leave `fee` unset in that case:
   * a priced mint whose fee cannot be established has to be refused, never assumed paid (§2.2).
   */
  feeOf(rawTx, prevValues) {
    if (!prevValues) return null;
    let inTotal = 0;
    for (const vin of rawTx.vin || []) {
      if (vin.coinbase !== undefined) return null;  // a coinbase pays no fee and mints nothing
      const v = prevValues.get(`${vin.txid}:${vin.vout}`);
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      inTotal += v;
    }
    const outTotal = (rawTx.vout || []).reduce((s, o) => s + xvgToUnits(o.value), 0);
    const fee = inTotal - outTotal;
    return fee >= 0 ? fee : null;
  }

  // --- following the tip --------------------------------------------------------------------

  /** Catch up to the tip, repairing a reorg if the chain moved under us. Single-flight. */
  async sync() {
    if (this._scanning) return this._scanning;
    this._scanning = (async () => {
      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        // Where we are standing is checked before extending it. A reorg does not have to make the
        // chain longer: if blocks are replaced at heights already counted, the tip number is
        // unchanged or lower, the loop below fetches nothing, and a scan that only inspected NEW
        // blocks would never look at the ones that changed.
        if (await this.tipMoved()) { await this.repair(this.scannedThrough + 1); continue; }

        const tip = await this.chain.getBlockCount();
        let forked = false;
        for (let h = this.scannedThrough + 1; h <= tip; h++) {
          const block = await this.chain.fetchDecodedBlock(h);
          if (!this.trail.continues(h, block.prevHash)) { await this.repair(h); forked = true; break; }
          this.applyBlock(block);
        }
        if (!forked) return tip;
      }
      throw new ReorgTooDeep(this.scannedThrough);
    })();
    try { return await this._scanning; } finally { this._scanning = null; }
  }

  /** Is the block we last counted still the one the node has at that height? */
  async tipMoved() {
    const ours = this.trail.hashAt(this.scannedThrough);
    if (!ours) return false;
    try {
      return (await this.chain.getBlockHash(this.scannedThrough)) !== ours;
    } catch {
      return true; // the node has no block at that height any more: the chain got shorter
    }
  }

  /**
   * The chain forked. Walk back to the last block we and the node agree on, rewind to a snapshot at
   * or before it, and let the next scan read the new blocks.
   *
   * Rewinding to a snapshot rather than undoing block by block is deliberate. An undo journal has to
   * be right about every piece of state, and there are several here (inscription locations, owner
   * addresses, rune balances, mint counters, allowlist entitlements); getting one wrong corrupts the
   * index silently. A snapshot cannot be partly right. Bitcoin Core keeps undo data because
   * re-reading blocks means re-validating signatures, which is expensive; nothing here validates
   * anything, so a rescan of a few hundred blocks is seconds and buys certainty.
   */
  async repair(at) {
    const fork = await findFork(this.trail, this.chain, at);
    if (fork === null) throw new ReorgTooDeep(this.trail.oldest() || this.from);
    const snap = [...this.snapshots].reverse().find((s) => s.height <= fork);
    if (!snap) throw new ReorgTooDeep(fork);
    this.restore(snap.state);
    this.reorgs += 1;
    return fork;
  }

  // --- state --------------------------------------------------------------------------------

  /**
   * Keep a copy of the whole state, to rewind to if the chain forks.
   *
   * Serialised and parsed rather than held by reference, and that is not paranoia: `toJSON` copies
   * the maps but the inscription RECORDS inside them are the same objects the indexer keeps
   * mutating, so a snapshot held by reference silently rewrites itself every time an inscription
   * moves. It would restore to a state that never existed, which is worse than not restoring at all.
   *
   * Going through JSON also means a snapshot and a state file are the same thing, so rewinding after
   * a reorg and resuming after a restart cannot drift apart.
   */
  snapshot() {
    this.snapshots.push({
      height: this.scannedThrough,
      state: JSON.parse(JSON.stringify(this.toJSON())),
    });
    while (this.snapshots.length > SNAPSHOTS_KEPT) this.snapshots.shift();
    if (this.onSnapshot) this.onSnapshot(this.scannedThrough);
  }

  toJSON() {
    return {
      version: 2,
      from: this.from,
      runesFrom: this.runesFrom,
      scannedThrough: this.scannedThrough,
      reorgs: this.reorgs,
      trail: this.trail.toJSON(),
      inscriptions: {
        nextNumber: this.inscriptions.nextNumber,
        inscriptions: [...this.inscriptions.inscriptions.entries()],
        locations: [...this.inscriptions.locations.entries()],
        checkpoints: [...this.inscriptions.checkpoints.entries()],
      },
      runes: this.runes.toJSON(),
    };
  }

  /** Replace live state with a saved one. Snapshots are deliberately NOT restored from a snapshot. */
  restore(obj) {
    this.scannedThrough = obj.scannedThrough;
    this.reorgs = obj.reorgs || this.reorgs;
    this.trail = BlockTrail.from(obj.trail);
    const i = obj.inscriptions || {};
    this.inscriptions.nextNumber = i.nextNumber || 0;
    this.inscriptions.inscriptions = new Map(i.inscriptions || []);
    this.inscriptions.locations = new Map(i.locations || []);
    this.inscriptions.checkpoints = new Map(i.checkpoints || []);
    this.runes = RuneState.fromJSON(obj.runes);
    return this;
  }

  /**
   * Load a saved state, or report why it cannot be used.
   *
   * A file written for a different start height is refused rather than adapted: inscription numbers
   * are handed out in scan order, so resuming across a changed `from` would renumber every
   * inscription that already exists.
   */
  load(obj) {
    if (!obj || obj.version !== 2) return { ok: false, reason: 'state file is from an older format' };
    if (obj.from !== this.from) {
      return { ok: false, reason: `state file was built from height ${obj.from}, running from ${this.from}` };
    }
    if (this.indexRunes && obj.runesFrom !== this.runesFrom) {
      return { ok: false, reason: `state file indexed runes from ${obj.runesFrom}, running from ${this.runesFrom}` };
    }
    this.restore(obj);
    return { ok: true };
  }

  status() {
    return {
      from: this.from,
      runesFrom: this.indexRunes ? this.runesFrom : null,
      scannedThrough: this.scannedThrough,
      inscriptions: this.inscriptions.inscriptions.size,
      runes: this.runes.runes.size,
      reorgsRepaired: this.reorgs,
      trailDepth: this.trail.depth,
      snapshots: this.snapshots.map((s) => s.height),
    };
  }
}

module.exports = { IndexService, ReorgTooDeep, SNAPSHOT_INTERVAL, SNAPSHOTS_KEPT };
