'use strict';
// Verge Runes: verifiable state checkpoints (RUNES-SPEC-v0 §8).
//
// The unfixable-looking weakness of every metaprotocol is that balances are decided by an indexer,
// and you have to trust it. Runes and BRC-20 offer nothing here. This module is the answer:
//
//   - an indexer commits to its ENTIRE balance set as one 32-byte merkle root, published on-chain;
//   - a wallet proves its own balance against that root with a short proof, without running an
//     indexer and without trusting the one it asked;
//   - because publishing is permissionless, several indexers publish at the same height, and any
//     divergence is immediately public, provable, and attributable.
//
// This does not make the protocol trustless in the consensus sense: an indexer can still be wrong.
// What changes is that being wrong becomes DETECTABLE instead of invisible.
//
// Pure: no chain, no disk. Leaves come straight from RuneState.entries(), which is sorted, so two
// honest indexers at the same height necessarily produce the same root.

const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// Leaves and interior nodes are hashed under different tags. Without that separation, anything that
// hashes like an interior node can be presented as a leaf and a proof one step short of the root
// still verifies. Here the two preimages already differ in length (an interior node is exactly 64
// bytes and a leaf is more, because an outpoint alone is 66 characters), so the attack was blocked
// by an accident of formatting rather than by design. Tagging makes it a property.
const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);

// A third tag, for what a rune reference MEANS. The tree used to commit to balances alone, so a
// verified proof told a wallet "outpoint X holds 500 of 50000:0" and nothing else: the ticker, the
// divisibility and the supply behind that reference still came from the indexer's word alone, which
// is the exact trust the checkpoint exists to remove. A wallet that cannot prove the reference is
// GRUMPY has not proven it holds any GRUMPY.
const RUNE_TAG = Buffer.from([0x02]);

/** Leaf = SHA256(tag || outpoint || runeRef || amount), over a canonical text encoding. */
function balanceLeaf({ outpoint, runeRef, amount }) {
  return sha256(Buffer.concat([LEAF_TAG, Buffer.from(`${outpoint}|${runeRef}|${amount}`, 'utf8')]));
}

/** Leaf = SHA256(tag || runeRef || ticker || divisibility || supply || spacers). */
function runeLeaf({ runeRef, ticker, divisibility, supply, spacers }) {
  return sha256(Buffer.concat([RUNE_TAG,
    Buffer.from(`${runeRef}|${ticker}|${divisibility}|${supply}|${spacers || 0}`, 'utf8')]));
}

/** Which kind of leaf an entry is. A balance entry names an outpoint; a rune definition never does. */
function leafHash(entry) {
  return entry && entry.outpoint !== undefined ? balanceLeaf(entry) : runeLeaf(entry);
}

/**
 * Everything a checkpoint commits to, in one canonical order: every balance, then every rune
 * definition. Both halves come out of RuneState already sorted, so two honest indexers at the same
 * height necessarily build the same list.
 */
function allEntries(state) {
  return [...state.entries(), ...(state.runeEntries ? state.runeEntries() : [])];
}

/** Hash two nodes in a fixed order, so a proof never has to carry left/right flags. */
function parentHash(a, b) {
  return Buffer.compare(a, b) <= 0
    ? sha256(Buffer.concat([NODE_TAG, a, b]))
    : sha256(Buffer.concat([NODE_TAG, b, a]));
}

/**
 * Merkle root over every balance in the state.
 * An empty state has the zero root, which is a valid commitment to "nothing exists yet".
 */
function buildTree(entries) {
  const leaves = entries.map(leafHash);
  if (leaves.length === 0) return { root: Buffer.alloc(32), levels: [[]] };
  const levels = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      // An odd node is carried up unchanged rather than duplicated: duplicating a node lets the same
      // proof authenticate two different trees (the CVE-2012-2459 shape), so we avoid it entirely.
      next.push(i + 1 < level.length ? parentHash(level[i], level[i + 1]) : level[i]);
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels };
}

/** The root committing to a whole RuneState: its balances and its rune definitions. */
function stateRoot(state) {
  return buildTree(allEntries(state)).root;
}

/**
 * Proof that one balance is part of the committed set.
 * @returns {{ entry, path: Buffer[] }|null} null when the entry is not in the state
 */
function proveBalance(state, outpoint, runeRef) {
  return proveAt(state, (e) => e.outpoint === outpoint && e.runeRef === runeRef);
}

/**
 * Proof of what a rune reference means: its ticker, divisibility and supply. A wallet needs this
 * alongside the balance proof, or it has verified a number without verifying what the number counts.
 */
function proveRune(state, runeRef) {
  return proveAt(state, (e) => e.outpoint === undefined && e.runeRef === runeRef);
}

function proveAt(state, match) {
  const entries = allEntries(state);
  const idx = entries.findIndex(match);
  if (idx < 0) return null;
  const { levels } = buildTree(entries);
  const path = [];
  let i = idx;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sibling = i % 2 === 0 ? level[i + 1] : level[i - 1];
    if (sibling) path.push(sibling); // no sibling = the carried-up odd node, nothing to add
    i = Math.floor(i / 2);
  }
  return { entry: entries[idx], path };
}

/**
 * Verify a balance against a published root. This is the whole point: a light wallet runs THIS, not
 * an indexer, and needs nothing but the root it read from the chain.
 */
function verifyBalance(entry, path, root) {
  if (!Buffer.isBuffer(root) || root.length !== 32) return false;
  if (!entry || !Array.isArray(path)) return false;
  let node = leafHash(entry);
  for (const sib of path) {
    if (!Buffer.isBuffer(sib) || sib.length !== 32) return false;
    node = parentHash(node, sib);
  }
  return node.equals(root);
}

/**
 * Compare what two indexers published for the same height.
 * Returns { agree, height, roots } so a wallet or a watcher can raise an alarm on divergence.
 */
function compareCheckpoints(a, b) {
  const agree = a.height === b.height && Buffer.isBuffer(a.root) && Buffer.isBuffer(b.root) && a.root.equals(b.root);
  return { agree, height: a.height, roots: [a.root, b.root] };
}

module.exports = {
  leafHash, balanceLeaf, runeLeaf, parentHash, buildTree, allEntries,
  stateRoot, proveBalance, proveRune, verifyBalance, compareCheckpoints,
};
