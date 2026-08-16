'use strict';
// Knowing when the chain changed its mind.
//
// Every indexer here derives its state by walking blocks forward, and none of them could tell that a
// block they had already counted was gone. `fetchDecodedBlock(h)` asks the node for the hash at a
// height and reads that block; if the chain reorganises, the node answers with a DIFFERENT block at
// the same height and the scan carries on without noticing. Inscriptions end up recorded at
// locations they never moved to, and rune balances end up on outpoints that no longer exist.
//
// The fix is to stop trusting heights and start following the chain of hashes, which is what makes a
// chain a chain. This module is the record of which block we actually counted at each height, and
// the walk back to the last one that still agrees with the node.
//
// Pure: no RPC of its own, no disk. `findFork` takes the chain as an argument so it can be tested
// against a fake one.

// How far back we keep hashes, and therefore the deepest reorg that can be repaired without a full
// rebuild. At 30-second blocks this is a bit over an hour and a half of chain. Anything deeper is a
// serious event that a human should look at, so it fails loudly rather than quietly rebuilding.
const TRAIL_DEPTH = 200;

class BlockTrail {
  constructor(depth = TRAIL_DEPTH) {
    this.depth = depth;
    this.hashes = new Map(); // height -> block hash
  }

  /** Remember the block we counted at this height, and forget ones too old to matter. */
  record(height, hash) {
    if (!hash) return;
    this.hashes.set(height, hash);
    const floor = height - this.depth;
    for (const h of this.hashes.keys()) if (h < floor) this.hashes.delete(h);
  }

  hashAt(height) {
    return this.hashes.get(height) || null;
  }

  /** The oldest height still on record, or null when nothing is. */
  oldest() {
    let min = null;
    for (const h of this.hashes.keys()) if (min === null || h < min) min = h;
    return min;
  }

  /**
   * Does the block at `height` build on the one we counted before it?
   *
   * True when there is nothing to check: the first block of a scan has no predecessor on record, and
   * refusing to proceed there would mean never starting.
   */
  continues(height, prevHash) {
    const known = this.hashAt(height - 1);
    if (!known) return true;
    return known === prevHash;
  }

  toJSON() {
    return { depth: this.depth, hashes: [...this.hashes.entries()] };
  }

  static from(obj) {
    const t = new BlockTrail(obj && obj.depth ? obj.depth : TRAIL_DEPTH);
    for (const [h, hash] of (obj && obj.hashes) || []) t.hashes.set(Number(h), hash);
    return t;
  }
}

/**
 * Walk back to the last height where our record and the node still agree.
 *
 * Called once a block has failed `continues`, so a fork is known to exist and the only question is
 * how deep. Every height we hold is checked against the node in turn; the first agreement is the
 * last good block, and everything above it has to be thrown away and read again.
 *
 * @param {BlockTrail} trail
 * @param {Object} chain   { getBlockHash(height) }
 * @param {number} from    the height whose parent disagreed
 * @returns {Promise<number|null>} the last agreeing height, or null when the fork is deeper than
 *                                 the trail and the state cannot be repaired from it
 */
async function findFork(trail, chain, from) {
  const floor = trail.oldest();
  if (floor === null) return null;
  for (let h = from - 1; h >= floor; h--) {
    const ours = trail.hashAt(h);
    if (!ours) continue;
    let theirs;
    try { theirs = await chain.getBlockHash(h); } catch { return null; }
    if (ours === theirs) return h;
  }
  return null; // the disagreement goes back further than we can see
}

module.exports = { BlockTrail, findFork, TRAIL_DEPTH };
