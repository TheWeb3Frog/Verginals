'use strict';
// Verge Assets: verifiable state checkpoints (ASSETS-SPEC-v0 §8).
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
// Pure: no chain, no disk. Leaves come straight from AssetState.entries(), which is sorted, so two
// honest indexers at the same height necessarily produce the same root.

const crypto = require('crypto');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/** Leaf = SHA256(outpoint || assetRef || amount), over a canonical text encoding of the triple. */
function leafHash({ outpoint, assetRef, amount }) {
  return sha256(Buffer.from(`${outpoint}|${assetRef}|${amount}`, 'utf8'));
}

/** Hash two nodes in a fixed order, so a proof never has to carry left/right flags. */
function parentHash(a, b) {
  return Buffer.compare(a, b) <= 0 ? sha256(Buffer.concat([a, b])) : sha256(Buffer.concat([b, a]));
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

/** The root committing to a whole AssetState. */
function stateRoot(state) {
  return buildTree([...state.entries()]).root;
}

/**
 * Proof that one balance is part of the committed set.
 * @returns {{ entry, path: Buffer[] }|null} null when the entry is not in the state
 */
function proveBalance(state, outpoint, assetRef) {
  const entries = [...state.entries()];
  const idx = entries.findIndex((e) => e.outpoint === outpoint && e.assetRef === assetRef);
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

module.exports = { leafHash, parentHash, buildTree, stateRoot, proveBalance, verifyBalance, compareCheckpoints };
