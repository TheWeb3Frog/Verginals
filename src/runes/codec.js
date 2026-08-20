'use strict';
// Verge Runes: the OP_RETURN wire format (RUNES-SPEC-v0 §4).
//
// Pure: no chain, no state, no I/O. Encoding and decoding are exact inverses, and decoding never
// throws on hostile input -> it returns null, because a malformed message must be IGNORED, not
// treated as an error that could destroy a balance (spec §4.4).
//
// Layout:  magic(2) | version(1) | body, total <= 83 bytes
// The body is a flat LEB128 varint stream, so absent fields cost nothing.

const MAGIC = Buffer.from([0x56, 0x41]); // "VA"
const VERSION = 0;
const MAX_PAYLOAD = 83; // the node's datacarriersize
const HEADER = MAGIC.length + 1;

const OP_MINT = 1;
const OP_CHECKPOINT = 2;

// --- what names a rune -------------------------------------------------------------------------
//
// A rune is identified by WHERE IT WAS ETCHED: the block height and the position of the etching
// transaction inside that block. Those two numbers are carried as two separate varints and are never
// combined arithmetically.
//
// This used to be packed as `height * 1000 + txIndex` into one varint, which is wrong and was found
// by review before anything was etched: a block holding 1000 transactions makes the 1000th
// transaction of block N collide with the first of block N+1. Two different runes then share one
// reference, the second etching overwrites the first, and their balances merge. A bigger multiplier
// only moves the cliff, so there is no constant worth choosing here -- the pair must stay a pair.
//
// In memory, in JSON and in a checkpoint leaf, a reference is the canonical string "<height>:<txIndex>".
// It is an opaque identity: parse it, never do arithmetic on it.

/** The canonical identity of a rune etched at (height, txIndex). */
function refOf(height, txIndex) {
  if (!Number.isInteger(height) || height < 0) throw new Error('rune height must be a non-negative integer');
  if (!Number.isInteger(txIndex) || txIndex < 0) throw new Error('rune txIndex must be a non-negative integer');
  return `${height}:${txIndex}`;
}

/** Read a canonical reference back into its two numbers, or null if it is not one. */
function parseRef(ref) {
  const m = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(String(ref));
  if (!m) return null;
  const height = Number(m[1]);
  const txIndex = Number(m[2]);
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(txIndex)) return null;
  return { height, txIndex };
}

/**
 * Order two references: by height, then by position in the block. This is the sort the checkpoint
 * tree depends on, so it has to be a total order over well-formed references and it must never fall
 * back on string comparison ("100:1" sorts before "99:2" lexicographically, which is wrong).
 * Unparseable references sort last, among themselves by their raw text, so the order stays total.
 */
function compareRefs(a, b) {
  const x = parseRef(a);
  const y = parseRef(b);
  if (!x || !y) {
    if (!x && !y) return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
    return x ? -1 : 1;
  }
  return x.height - y.height || x.txIndex - y.txIndex;
}

// The first varint of an edict stream is the height of the lowest-referenced rune, and it shares the
// first body byte with the control opcodes. Heights below this would decode as a mint or a
// checkpoint, so they are refused at encode time. Nothing is lost: no rune can be etched in the
// first three blocks of a chain.
/**
 * The block Verge Runes starts counting from. An etching below this height is not a rune, however
 * well formed it is.
 *
 * It is not only a date. It is the INDEXER'S START BLOCK, so nobody can pre-etch a name before the
 * rules were announced, and any implementation can skip 9.4M blocks of history before it begins.
 */
const ACTIVATION_HEIGHT = 9420420;

/**
 * How many blocks must sit on top of an etching before its rune can be moved by an edict.
 *
 * A rune is named by WHERE it was etched, the pair (height, txIndex). A reorg re-mines the etching
 * somewhere else, so its name CHANGES, and a different etching can inherit the old one. Measured on
 * mainnet over 56,572 blocks: two reorgs, both one block deep, both resolved inside thirty seconds.
 * Six blocks is 3.4 minutes at the observed 34 s pace, six times the deepest thing seen.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT. Only EDICTS are held back. A young rune's balance still
 * rides the default assignment on an ordinary spend, deliberately: refusing it there would BURN a
 * premine on a routine wallet transaction, which is far worse than waiting three minutes. What the
 * rule stops is being SOLD a rune whose name is not settled yet, because a sale moves it by edict.
 */
const ETCH_MATURITY = 6;

const MIN_RUNE_HEIGHT = 3;

// --- varints ---------------------------------------------------------------------------------
// LEB128, unsigned. Values are plain JS numbers and must stay within the safe integer range.
//
// Note that an atomic unit of XVG is NOT safe to assume fits: Verge's supply is about 16.5 billion
// XVG, which is 1.65e16 atomic units, above the 9.007e15 safe-integer ceiling. Rune amounts are a
// separate accounting from XVG and an etcher choosing a supply above the ceiling is refused by the
// builder, but nothing here should be read as a claim about XVG amounts.

function encodeVarint(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('varint must be a non-negative integer');
  if (n > Number.MAX_SAFE_INTEGER) throw new Error('varint exceeds the safe integer range');
  const out = [];
  let v = n;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

/**
 * Read one varint. Returns null on truncation, on a value too large to represent exactly, and on a
 * NON-MINIMAL encoding.
 *
 * Minimality matters because two byte strings that mean the same thing are two different messages
 * with one meaning: the transaction they sit in has two valid forms, and a second implementation
 * that normalises differently reads a different message. LEB128 is minimal exactly when it does not
 * end in a redundant 0x00 continuation, so that is the whole check.
 */
function readVarint(buf, offset) {
  let value = 0;
  let shift = 1;
  for (let i = offset; i < buf.length; i++) {
    const byte = buf[i];
    value += (byte & 0x7f) * shift;
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if ((byte & 0x80) === 0) {
      if (i > offset && byte === 0x00) return null; // padded: not the shortest encoding of this value
      return { value, next: i + 1 };
    }
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) return null; // absurdly long encoding
  }
  return null; // ran off the end
}

// --- messages --------------------------------------------------------------------------------
//
// A decoded message is one of:
//   { type: 'edicts',     edicts: [{ runeRef, amount, output }] }
//   { type: 'mint',       runeRef, proofIndex|null }
//   { type: 'checkpoint', height, root: Buffer(32) }
//
// Edicts carry ABSOLUTE rune references once decoded; the delta encoding below is an on-the-wire
// detail and never leaks into the state machine.

/**
 * Encode a transfer message.
 *
 * Edicts are sorted by (height, txIndex) and the HEIGHT is delta-encoded against the previous edict;
 * the position within the block is written out in full, because it is small and delta-encoding it
 * across a height change would mean signed varints for nothing.
 */
function encodeEdicts(edicts) {
  if (!Array.isArray(edicts) || edicts.length === 0) throw new Error('at least one edict is required');
  const withRef = edicts.map((e) => {
    const ref = parseRef(e.runeRef);
    if (!ref) throw new Error(`runeRef must be "<height>:<txIndex>", got ${JSON.stringify(e.runeRef)}`);
    if (!Number.isInteger(e.output) || e.output < 0) throw new Error('output must be a non-negative integer');
    return { ...ref, amount: e.amount, output: e.output };
  });
  withRef.sort((a, b) => a.height - b.height || a.txIndex - b.txIndex);
  if (withRef[0].height < MIN_RUNE_HEIGHT) {
    throw new Error(`rune heights below ${MIN_RUNE_HEIGHT} are reserved (they would decode as a control message)`);
  }

  const parts = [];
  let prevHeight = 0;
  withRef.forEach((e, i) => {
    const last = i === withRef.length - 1 ? 1 : 0;
    parts.push(encodeVarint(e.height - prevHeight), encodeVarint(e.txIndex),
      encodeVarint(e.amount), encodeVarint(e.output), encodeVarint(last));
    prevHeight = e.height;
  });
  return frame(Buffer.concat(parts));
}

function encodeMint(runeRef, proofIndex = null) {
  const ref = parseRef(runeRef);
  if (!ref) throw new Error(`runeRef must be "<height>:<txIndex>", got ${JSON.stringify(runeRef)}`);
  const parts = [encodeVarint(OP_MINT), encodeVarint(ref.height), encodeVarint(ref.txIndex)];
  if (proofIndex !== null) parts.push(encodeVarint(proofIndex));
  return frame(Buffer.concat(parts));
}

function encodeCheckpoint(height, root) {
  if (!Buffer.isBuffer(root) || root.length !== 32) throw new Error('root must be 32 bytes');
  return frame(Buffer.concat([encodeVarint(OP_CHECKPOINT), encodeVarint(height), root]));
}

function frame(body) {
  const payload = Buffer.concat([MAGIC, Buffer.from([VERSION]), body]);
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`payload is ${payload.length} bytes, over the ${MAX_PAYLOAD}-byte OP_RETURN limit`);
  }
  return payload;
}

/**
 * Decode an OP_RETURN payload. Returns null for anything this version does not understand, which
 * the state machine treats as "no message present" rather than as an error (spec §4.4).
 */
function decode(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < HEADER || payload.length > MAX_PAYLOAD) return null;
  if (payload[0] !== MAGIC[0] || payload[1] !== MAGIC[1]) return null;
  if (payload[2] !== VERSION) return null;
  const body = payload.slice(HEADER);
  if (body.length === 0) return null;

  // The control messages are identified by a leading opcode; anything else is an edict stream, whose
  // first varint is the height of its lowest reference. That is why heights below MIN_RUNE_HEIGHT
  // are reserved and refused at encode time.
  if (body[0] === OP_MINT) return decodeMint(body);
  if (body[0] === OP_CHECKPOINT) return decodeCheckpoint(body);
  return decodeEdicts(body);
}

function decodeMint(body) {
  const h = readVarint(body, 1);
  if (!h) return null;
  const t = readVarint(body, h.next);
  if (!t) return null;
  let proofIndex = null;
  if (t.next < body.length) {
    const p = readVarint(body, t.next);
    if (!p || p.next !== body.length) return null; // trailing junk: ignore the whole message
    proofIndex = p.value;
  }
  return { type: 'mint', runeRef: refOf(h.value, t.value), proofIndex };
}

function decodeCheckpoint(body) {
  const h = readVarint(body, 1);
  if (!h) return null;
  const root = body.slice(h.next);
  if (root.length !== 32) return null;
  return { type: 'checkpoint', height: h.value, root };
}

function decodeEdicts(body) {
  const edicts = [];
  let off = 0;
  let height = 0;
  while (off < body.length) {
    const dh = readVarint(body, off); if (!dh) return null;
    const tx = readVarint(body, dh.next); if (!tx) return null;
    const amt = readVarint(body, tx.next); if (!amt) return null;
    const out = readVarint(body, amt.next); if (!out) return null;
    const flags = readVarint(body, out.next); if (!flags) return null;
    if (flags.value > 1) return null; // reserved bits must be zero
    height += dh.value;
    edicts.push({ runeRef: refOf(height, tx.value), amount: amt.value, output: out.value });
    off = flags.next;
    if (flags.value === 1) {
      if (off !== body.length) return null; // data after the terminator: ignore the whole message
      return { type: 'edicts', edicts };
    }
  }
  return null; // ran out of bytes without a terminator
}

/** How many edicts of this shape still fit inside the 83-byte limit. Used by wallets when batching. */
function fits(edicts) {
  try { encodeEdicts(edicts); return true; } catch { return false; }
}

module.exports = {
  MAGIC, VERSION, MAX_PAYLOAD, OP_MINT, OP_CHECKPOINT, MIN_RUNE_HEIGHT,
  ACTIVATION_HEIGHT, ETCH_MATURITY,
  refOf, parseRef, compareRefs,
  encodeVarint, readVarint,
  encodeEdicts, encodeMint, encodeCheckpoint, decode, fits,
};
