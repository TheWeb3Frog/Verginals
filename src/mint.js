'use strict';
// Alpha Verginals mint controller: provably-fair, sold-out-eventually random drop.
//
// This module is PURE (no RPC, no HTTP): it loads a fixed collection from disk, assigns
// collection numbers to minters in a committed-in-advance random order, and tracks
// reserved / minted state persistently. The Verge payment + inscription flow (server.js)
// plugs in on top: it reserves a number, quotes a payment for that image, and, once the
// reveal tx is broadcast, confirms the mint. Unpaid reservations are released back to the
// pool by the server (which alone can see whether a deposit was funded).
//
// PROVABLE FAIRNESS (commit-reveal):
//   * At first launch we draw a secret 32-byte seed and persist it (data/mint.secret, secret).
//   * We publish commitment = SHA256(seed_bytes) up front. It cannot be forged after the fact.
//   * The assignment order is a Fisher-Yates permutation of [1..supply] derived deterministically
//     from the seed (formula below). Minters are served numbers in this order (skipping any already
//     minted / actively reserved), so nobody, including the operator, can pick which image a given
//     mint gets without also fixing the whole order in advance and being caught at reveal.
//   * At the end (sold out, or operator reveal) we publish the seed. Anyone recomputes the
//     permutation, checks SHA256(seed) == commitment, and verifies every mint matched the order.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cbor = require('./cbor');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const sha256hex = (buf) => sha256(buf).toString('hex');

// --- documented deterministic PRNG + shuffle (verifiable by third parties) ------------------
//
// Keystream = concatenation of SHA256(`${seedHex}:${counter}`) for counter = 0,1,2,…, consumed
// 4 bytes at a time as big-endian uint32. Indices are drawn with rejection sampling to avoid
// modulo bias. The permutation is a standard Fisher-Yates over [1..n] using that stream.

function makeStream(seedHex) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let idx = 0;
  return () => {
    if (idx + 4 > pool.length) {
      pool = sha256(Buffer.from(`${seedHex}:${counter++}`, 'utf8'));
      idx = 0;
    }
    const v = pool.readUInt32BE(idx);
    idx += 4;
    return v;
  };
}

// Unbiased integer in [0, m) via rejection sampling on a uint32 stream.
function nextBelow(next, m) {
  const limit = Math.floor(0x1_0000_0000 / m) * m;
  let v;
  do {
    v = next();
  } while (v >= limit);
  return v % m;
}

/** Fisher-Yates permutation of [1..n] derived from a hex seed. order[k] = number for the k-th draw. */
function deriveOrder(seedHex, n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i + 1;
  const next = makeStream(seedHex);
  for (let i = n - 1; i > 0; i--) {
    const j = nextBelow(next, i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// --- controller -----------------------------------------------------------------------------

class MintController {
  /**
   * @param {object} opts
   * @param {string} opts.collectionDir  dir holding images/, designs.json, metadata.json, collection_manifest.json
   * @param {string} opts.dataDir        persistent dir for the secret seed + mint state (gitignored)
   */
  constructor({ collectionDir, dataDir }) {
    this.collectionDir = collectionDir;
    this.dataDir = dataDir;
    this.secretPath = path.join(dataDir, 'mint.secret');
    this.statePath = path.join(dataDir, 'mintState.json');
    this.byNumber = new Map(); // number -> { number, filename, name, house, attributes }
    this.order = [];
    this.seedHex = null;
    this.commitment = null;
    this.state = null; // { minted: {n:{revealTxid,owner,at}}, reserved: {n:{jobId,at}}, revealedSeed }
    this.manifest = null;
    this.loaded = false;
  }

  /** Load the collection + fairness seed + persisted state. Idempotent. Throws if the collection is bad. */
  load() {
    const designs = JSON.parse(fs.readFileSync(path.join(this.collectionDir, 'designs.json'), 'utf8'));
    const metadata = JSON.parse(fs.readFileSync(path.join(this.collectionDir, 'metadata.json'), 'utf8'));
    this.manifest = JSON.parse(fs.readFileSync(path.join(this.collectionDir, 'collection_manifest.json'), 'utf8'));

    const supply = Number(this.manifest.supply) || designs.length;
    if (designs.length !== supply || metadata.length !== supply) {
      throw new Error(`collection size mismatch: supply=${supply} designs=${designs.length} metadata=${metadata.length}`);
    }
    const metaByNum = new Map(metadata.map((m) => [m.number, m]));
    for (const d of designs) {
      const m = metaByNum.get(d.number);
      if (!m) throw new Error(`metadata missing for #${d.number}`);
      const img = path.join(this.collectionDir, 'images', d.filename);
      if (!fs.existsSync(img)) throw new Error(`image missing on disk: ${d.filename}`);
      this.byNumber.set(d.number, {
        number: d.number,
        filename: d.filename,
        name: m.name || d.name || `Verginals #${d.number}`,
        house: d.house || null,
        attributes: m.attributes || [],
      });
    }
    this.supply = supply;

    fs.mkdirSync(this.dataDir, { recursive: true });
    // Fairness seed: generate once, then never change (that's the whole point of the commitment).
    if (fs.existsSync(this.secretPath)) {
      this.seedHex = fs.readFileSync(this.secretPath, 'utf8').trim();
    } else {
      this.seedHex = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(this.secretPath, this.seedHex, { mode: 0o600 });
    }
    this.commitment = sha256hex(Buffer.from(this.seedHex, 'hex'));
    this.order = deriveOrder(this.seedHex, supply);

    this.state = this._loadState();
    this.loaded = true;
    return this;
  }

  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      s.minted = s.minted || {};
      s.reserved = s.reserved || {};
      return s;
    } catch (_) {
      return { minted: {}, reserved: {}, revealedSeed: null };
    }
  }

  _save() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.statePath); // atomic replace
  }

  mintedCount() {
    return Object.keys(this.state.minted).length;
  }
  reservedCount() {
    return Object.keys(this.state.reserved).length;
  }
  remaining() {
    return this.supply - this.mintedCount() - this.reservedCount();
  }
  soldOut() {
    return this.mintedCount() >= this.supply;
  }

  /** Full public metadata for one number (name, traits, image filename). */
  get(number) {
    return this.byNumber.get(Number(number)) || null;
  }

  /**
   * CBOR metadata (ord tag 5) inscribed alongside a number's image, so the item's traits live
   * on-chain and generic ord-compatible explorers can render them. Shape:
   *   { name, collection, attributes: [{ trait_type, value }, ...] }
   * Returns null if the number is unknown. This is embedded in the reveal at mint time and is
   * therefore permanent; it cannot be added to an inscription after the fact.
   */
  metadataCbor(number) {
    const e = this.get(number);
    if (!e) return null;
    return cbor.encode({
      name: e.name,
      collection: this.manifest.name,
      attributes: (e.attributes || []).map((a) => ({ trait_type: a.trait_type, value: a.value })),
    });
  }

  /** Absolute path to the image file for a number (server streams it for the reveal preview). */
  imagePath(number) {
    const e = this.get(number);
    return e ? path.join(this.collectionDir, 'images', e.filename) : null;
  }

  /**
   * Atomically reserve the next number in the committed order that isn't minted or actively reserved.
   * Returns the assignment (number + metadata) or null if the drop is sold out / fully reserved.
   */
  reserve(jobId) {
    for (const number of this.order) {
      if (this.state.minted[number] || this.state.reserved[number]) continue;
      this.state.reserved[number] = { jobId, at: Date.now() };
      this._save();
      return Object.assign({ commitment: this.commitment }, this.get(number));
    }
    return null;
  }

  /** Which number a job holds a reservation on (or null). */
  reservationOf(jobId) {
    for (const [number, r] of Object.entries(this.state.reserved)) {
      if (r.jobId === jobId) return Number(number);
    }
    return null;
  }

  /** Promote a reservation to a permanent mint (called once the reveal tx is broadcast). */
  confirmMinted(number, { revealTxid, owner }) {
    number = Number(number);
    delete this.state.reserved[number];
    this.state.minted[number] = { revealTxid: revealTxid || null, owner: owner || null, at: Date.now() };
    this._save();
  }

  /** Return a reserved number to the pool (called by the server for genuinely unpaid reservations). */
  release(number) {
    number = Number(number);
    if (this.state.reserved[number]) {
      delete this.state.reserved[number];
      this._save();
    }
  }

  /** List active reservations older than `maxAgeMs`; the server checks each for payment before releasing. */
  staleReservations(maxAgeMs) {
    const now = Date.now();
    return Object.entries(this.state.reserved)
      .filter(([, r]) => now - (r.at || 0) > maxAgeMs)
      .map(([number, r]) => ({ number: Number(number), jobId: r.jobId, at: r.at }));
  }

  /** Public drop status (safe to expose, never leaks the seed before reveal). */
  status() {
    return {
      name: this.manifest.name,
      symbol: this.manifest.symbol,
      supply: this.supply,
      minted: this.mintedCount(),
      reserved: this.reservedCount(),
      remaining: this.remaining(),
      soldOut: this.soldOut(),
      commitment: this.commitment,
      provenanceHash: this.manifest.provenance_hash || null,
      revealed: !!this.state.revealedSeed,
      seed: this.state.revealedSeed || null,
    };
  }

  /**
   * Reveal the fairness seed so anyone can verify the assignment order. Allowed once the drop is
   * sold out (or forced by the operator). Idempotent; returns the seed.
   */
  reveal({ force = false } = {}) {
    if (!force && !this.soldOut()) throw new Error('drop is not sold out yet');
    if (!this.state.revealedSeed) {
      this.state.revealedSeed = this.seedHex;
      this._save();
    }
    return this.seedHex;
  }
}

module.exports = { MintController, deriveOrder, makeStream, nextBelow, sha256hex };
