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
const { RuneState, applyTx, runeRefOf } = require('./runes/indexer');
const { ActionLedger } = require('./airdrop');
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
    snapshotInterval = SNAPSHOT_INTERVAL, onSnapshot = null, runeOpts = null,
    alphaParent = null } = {}) {
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
    // Which parent inscription makes a reveal an Alpha rather than somebody's own inscription. Null
    // is not a failure: with no collection configured every reveal is simply an inscription, which
    // is the right answer for a server that is not running the Alpha mint.
    this.alphaParent = alphaParent || null;
    // WHERE THE COLLECTION'S PARENT CARRIER IS NOW, as a utxo rather than as an inscription.
    //
    // The obvious way to recognise an Alpha mint is the verified tag-3 parent the inscription
    // indexer already computes, and that is what this used to read. It reported nothing, because
    // the root inscription was BURNED on chain at height 9,304,347, on the third mint ever.
    //
    // The mint re-emits its parent carrier at a constant 3 XVG, but an inscription sits at an
    // OFFSET inside its output, and that offset creeps forward by the fee every time the carrier
    // is carried forward: 0, then 800,000, then 1,800,000, then past the end of a 3,000,000
    // output, at which point the ordinal rules say it was paid to the miner. Every Alpha minted
    // since then claims a parent that no longer exists, and no claim can ever verify again.
    //
    // THE UTXO CHAIN SURVIVED ALL OF THAT. The operator still spends one carrier and re-emits it
    // unchanged to the same address on every mint, and nobody else can spend it. So the tip is
    // followed as an outpoint here, and an Alpha is a reveal that claims the root AND spends the
    // tip. The second half is what makes it unforgeable: the claim on its own is a string anybody
    // can write into one cheap inscription.
    this.alphaTip = null; // { outpoint, address, value }
    // Who etched each coin: runeRef -> the address its reveal landed on. Read off the same
    // inscription record the drop already uses, so it costs nothing extra and cannot disagree
    // with it. It is what proves somebody may set that coin's picture.
    this.etchers = new Map();
    // A third reading of the same blocks, kept beside the two state machines rather than inside
    // either. Neither of them has any business knowing what a community drop is, and runes/indexer.js
    // in particular has to stay a pure function of (state, tx) for the conformance harness.
    this.actions = new ActionLedger();
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

      // Read before, so what this transaction changed can be told from what was already there.
      const numberBefore = this.inscriptions.nextNumber;
      const mintsBefore = extra ? this.mintCount() : 0;
      const spendsAlphaTip = !!(this.alphaTip
        && (decoded.ins || []).some((v) => `${v.txid}:${v.vout}` === this.alphaTip.outpoint));

      this.inscriptions.processTx(decoded, height);
      if (extra) applyTx(this.runes, toIndexerTx(rawTx, height, i, extra), this.runeOpts);

      this.noteActions(decoded.txid, height, i, decoded.outs || [], {
        revealed: this.inscriptions.nextNumber > numberBefore,
        etched: !!(extra && extra.etching),
        minted: extra ? this.mintCount() > mintsBefore : false,
        spendsAlphaTip,
      });
      this.followAlphaTip(decoded, spendsAlphaTip);
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

  /**
   * Record what this transaction earned its sender towards the community drop.
   *
   * Called AFTER both state machines have run, and it re-derives nothing: whether an etch took the
   * ticker, whether a mint was allowed, and where an inscription landed are all questions the two
   * of them have already answered, and asking them again here is how two implementations of one
   * rule drift apart. So this reads their conclusions.
   *
   * A transaction earns at most one action. An etching IS an inscription reveal and an Alpha mint is
   * too, so without this the same transaction would be counted twice and a wallet with one etch
   * would out-earn a wallet that had inscribed and minted separately.
   */
  noteActions(txid, height, txIndex, outs, { revealed, etched, minted, spendsAlphaTip }) {
    if (revealed) {
      const rec = this.inscriptions.inscriptions.get(`${txid}i0`);
      const to = rec && rec.ownerAddress;
      // An etching only counts once the rune indexer has accepted it. A malformed payload, an
      // unlocked ticker or a height below activation all leave the reveal a plain inscription, and
      // that is what it should be paid as.
      const took = etched && this.runes.runes.has(runeRefOf(height, txIndex));
      if (took && to) this.etchers.set(runeRefOf(height, txIndex), to);
      // Both halves are required. The CLAIM says this reveal means to be an Alpha; SPENDING THE TIP
      // says the operator's mint is what produced it. Either alone is wrong: a claim is a string
      // anybody can write, and the tip is spent by transactions that reveal nothing.
      const claimsRoot = !!(rec && this.alphaParent && (rec.parents || []).includes(this.alphaParent));
      if (took) this.actions.record(to, 'etch', height);
      else if (claimsRoot && spendsAlphaTip) this.actions.record(to, 'alpha', height);
      else this.actions.record(to, 'inscribe', height);
    }
    // A mint is not a reveal, so there is no inscription to read the address off. The coins
    // themselves say where they went: whichever output the rune indexer credited.
    if (minted) this.actions.record(this.creditedTo(txid, outs), 'coin', height);
  }

  /**
   * Keep up with the collection's parent carrier.
   *
   * Seeded from the root's own reveal, then moved on every transaction that spends it. The
   * successor is the output paying the SAME ADDRESS the SAME VALUE, which is the mint's documented
   * invariant (re-emitted unchanged in value to the same operator address, so the tip never
   * depletes) and the only part of it still true after the root inscription burned.
   *
   * Searched from the END, because the carry-forward is appended after the buyer's outputs and a
   * buyer who happened to be the operator would otherwise capture the tip.
   */
  followAlphaTip(tx, spent) {
    if (!this.alphaParent) return;

    if (!this.alphaTip) {
      // Only the root's own reveal can start the chain, so it is matched by id rather than by
      // looking for an operator address nobody has told us.
      if (!this.alphaParent.startsWith(`${tx.txid}i`)) return;
      const rec = this.inscriptions.inscriptions.get(this.alphaParent);
      if (!rec || !rec.location || rec.location === 'burned') return;
      const vout = Number(rec.location.slice(rec.location.lastIndexOf(':') + 1));
      const o = (tx.outs || [])[vout];
      if (o) this.alphaTip = { outpoint: rec.location, address: o.address || null, value: o.value };
      return;
    }

    if (!spent) return;
    const outs = tx.outs || [];
    let at = -1;
    for (let i = outs.length - 1; i >= 0; i--) {
      if (outs[i].address === this.alphaTip.address && outs[i].value === this.alphaTip.value) { at = i; break; }
    }
    // No successor means the operator spent the carrier without re-emitting it. The chain is over,
    // and saying so beats following whatever output happened to be nearby: from here nothing can be
    // shown to be an Alpha, which is the honest answer rather than a wrong one.
    this.alphaTip = at < 0 ? null
      : { outpoint: `${tx.txid}:${at}`, address: this.alphaTip.address, value: this.alphaTip.value };
  }

  /** Every mint the rune index has accepted, across every coin. */
  mintCount() {
    let n = 0;
    for (const r of this.runes.runes.values()) n += r.mintCount || 0;
    return n;
  }

  /**
   * The address of the lowest output of this transaction that came out of it holding a rune.
   *
   * Walks the transaction's own outputs rather than the balance map, which holds every unspent
   * rune outpoint on the chain: scanning that per mint would make the cost of indexing a block
   * depend on how much of the supply is in circulation.
   */
  creditedTo(txid, outs) {
    for (let vout = 0; vout < outs.length; vout++) {
      if (!this.runes.balances.has(`${txid}:${vout}`)) continue;
      return outs[vout].address || null;
    }
    return null;
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
      // Rewound with everything else. An action ledger that survived a reorg would keep crediting
      // an etch that got re-mined out of existence, and the address would stay eligible for ever on
      // the strength of a transaction no longer in the chain.
      actions: this.actions.toJSON(),
      alphaTip: this.alphaTip,
      etchers: [...this.etchers.entries()],
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
    this.actions = ActionLedger.fromJSON(obj.actions || []);
    this.alphaTip = obj.alphaTip ? Object.assign({}, obj.alphaTip) : null;
    this.etchers = new Map(obj.etchers || []);
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
      actors: this.actions.actors.size,
      reorgsRepaired: this.reorgs,
      trailDepth: this.trail.depth,
      snapshots: this.snapshots.map((s) => s.height),
    };
  }
}

module.exports = { IndexService, ReorgTooDeep, SNAPSHOT_INTERVAL, SNAPSHOTS_KEPT };
