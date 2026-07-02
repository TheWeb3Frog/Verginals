// Verginals indexer core: deterministic inscription extraction + FIFO location tracking
// per spec/VERGINALS-SPEC-v0.md §5–§6. This module is node-agnostic and pure: feed it
// decoded blocks (with resolved prevout values) and it produces an identical result every
// time. The Verge RPC layer that decodes real blocks plugs in on top of this.
//
// Decoded transaction shape expected by processTx:
//   {
//     txid: string,
//     ins:  [{ txid, vout, value, inscriptionScript?: Buffer|null }],  // value = prevout value;
//                                                                      // inscriptionScript = the
//                                                                      // redeemScript revealed in
//                                                                      // the P2SH scriptSig
//     outs: [{ value }],
//   }

const crypto = require('crypto');
const { parseInscriptionScript, bufferToParentId } = require('./envelope');
const cbor = require('./cbor');

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const outpoint = (txid, vout) => `${txid}:${vout}`;

/**
 * Best-effort decode of tag-5 CBOR metadata buffers for display (e.g. per-item traits). Never
 * throws: metadata that is not valid CBOR is surfaced as { hex } so indexing stays total and
 * deterministic. The reproducibility digest (§6) does not include metadata, so this is display-only.
 */
function decodeMetadata(buffers) {
  return (buffers || []).map((buf) => {
    try {
      return cbor.decode(buf);
    } catch (_) {
      return { hex: Buffer.from(buf).toString('hex') };
    }
  });
}

class Indexer {
  constructor() {
    this.nextNumber = 0;
    // id -> { number, id, contentType, metadata, bodyHash, genesisHeight, location }
    this.inscriptions = new Map();
    // "txid:vout" -> [{ id, offset }]  (offset = unit offset within that output)
    this.locations = new Map();
  }

  /**
   * Extract a single inscription (v0: one per reveal tx) from a transaction's input
   * redeemScripts (revealed in the P2SH scriptSig), concatenating body across inputs in order.
   * Content-type/parent/metadata come from the first input that carries them. Returns null if no
   * envelope is present.
   */
  static extractReveal(tx) {
    let contentType = null;
    const parents = [];
    const metadata = [];
    const bodyChunks = [];
    let found = false;
    for (const inp of tx.ins) {
      if (!inp.inscriptionScript) continue;
      const parsed = parseInscriptionScript(inp.inscriptionScript);
      if (!parsed) continue;
      found = true;
      if (contentType === null && parsed.contentType) contentType = parsed.contentType;
      for (const p of parsed.parents || []) parents.push(p);
      for (const m of parsed.metadata) metadata.push(m);
      bodyChunks.push(parsed.body);
    }
    if (!found) return null;
    return { contentType, parents, metadata, body: Buffer.concat(bodyChunks) };
  }

  /** Map a global unit offset (across all outputs, in order) to { vout, offset } or null (→ fee). */
  static assignToOutput(globalOffset, outs) {
    let start = 0;
    for (let vout = 0; vout < outs.length; vout++) {
      const end = start + outs[vout].value;
      if (globalOffset < end) return { vout, offset: globalOffset - start };
      start = end;
    }
    return null; // offset beyond total output value ⇒ paid to fee ⇒ burned
  }

  processTx(tx, height) {
    // 1) Collect inscriptions carried by the inputs, with their global offset in this tx.
    const moving = []; // { id, globalOffset }
    let cumIn = 0;
    for (const inp of tx.ins) {
      const here = this.locations.get(outpoint(inp.txid, inp.vout));
      if (here) {
        for (const { id, offset } of here) moving.push({ id, globalOffset: cumIn + offset });
      }
      this.locations.delete(outpoint(inp.txid, inp.vout));
      cumIn += inp.value;
    }
    // Inscriptions carried by THIS tx's inputs (the pre-spend set). A tag-3 parent claim is
    // verified (spec §10.2) only if the claimed parent is among these.
    const inputInscriptionIds = new Set(moving.map((m) => m.id));

    // 2) A reveal creates a new inscription bound to the first unit of the outputs (offset 0).
    const reveal = Indexer.extractReveal(tx);
    if (reveal) {
      const id = `${tx.txid}i0`;
      const number = this.nextNumber++;
      const parents = (reveal.parents || [])
        .map((b) => {
          try {
            return bufferToParentId(b);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
      const verifiedParents = parents.filter((pid) => inputInscriptionIds.has(pid));
      this.inscriptions.set(id, {
        number,
        id,
        contentType: reveal.contentType ? reveal.contentType.toString('utf8') : null,
        metadata: decodeMetadata(reveal.metadata),
        parents, // every tag-3 claim, verified or not
        parent: verifiedParents[0] || null, // effective (verified) collection parent, or null
        children: [],
        bodyHash: sha256hex(reveal.body),
        bodySize: reveal.body.length,
        genesisHeight: height,
        location: null,
        ownerAddress: null, // current holder; updated each time the inscription moves
      });
      // Link verified children into their parent's record so collections are queryable.
      for (const pid of verifiedParents) {
        const prec = this.inscriptions.get(pid);
        if (prec) {
          if (!prec.children) prec.children = [];
          prec.children.push(id);
        }
      }
      moving.push({ id, globalOffset: 0 });
    }

    // 3) Assign every moving inscription to an output (or burn it), updating locations.
    //    Deterministic: sort by globalOffset, then by inscription number.
    moving.sort((a, b) => {
      if (a.globalOffset !== b.globalOffset) return a.globalOffset - b.globalOffset;
      return this.inscriptions.get(a.id).number - this.inscriptions.get(b.id).number;
    });
    for (const { id, globalOffset } of moving) {
      const dest = Indexer.assignToOutput(globalOffset, tx.outs);
      const rec = this.inscriptions.get(id);
      if (!dest) {
        rec.location = 'burned';
        rec.ownerAddress = null;
        continue;
      }
      const key = outpoint(tx.txid, dest.vout);
      rec.location = key;
      rec.ownerAddress = tx.outs[dest.vout].address || null;
      if (!this.locations.has(key)) this.locations.set(key, []);
      this.locations.get(key).push({ id, offset: dest.offset });
    }
  }

  /** Process a block: { height, txs: [...] } with txs in block order. */
  processBlock(block) {
    for (const tx of block.txs) this.processTx(tx, block.height);
  }

  /** Inscriptions sorted by number (stable canonical order). */
  list() {
    return [...this.inscriptions.values()].sort((a, b) => a.number - b.number);
  }

  /** Reproducibility digest: SHA256 over the canonical state of all inscriptions. */
  digest() {
    const canonical = this.list()
      .map((i) => `${i.number}|${i.id}|${i.contentType}|${i.bodyHash}|${i.location}`)
      .join('\n');
    return sha256hex(Buffer.from(canonical, 'utf8'));
  }
}

module.exports = { Indexer, decodeMetadata };
