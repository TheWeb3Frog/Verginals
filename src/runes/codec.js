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

// --- varints ---------------------------------------------------------------------------------
// LEB128, unsigned. Values are plain JS numbers and must stay within the safe integer range: an
// amount is atomic units and Verge's whole supply fits comfortably inside 2^53.

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

/** Read one varint. Returns null on truncation or on a value too large to represent exactly. */
function readVarint(buf, offset) {
  let value = 0;
  let shift = 1;
  for (let i = offset; i < buf.length; i++) {
    const byte = buf[i];
    value += (byte & 0x7f) * shift;
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
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
// Edicts carry ABSOLUTE rune references once decoded; the delta encoding of spec §4.1 is an
// on-the-wire detail and never leaks into the state machine.

// An edict stream and the control messages share the first body byte, so the smallest rune
// references are reserved: the first varint of an edict stream is the lowest absolute reference,
// and it must not collide with an opcode. Real references are blockHeight.txIndex packed, so they
// are always far above this floor; the check exists so a hand-built message cannot be mis-decoded
// as a mint or a checkpoint.
const MIN_RUNE_REF = 3;

/** Encode a transfer message. Edicts are sorted by runeRef, then delta-encoded. */
function encodeEdicts(edicts) {
  if (!Array.isArray(edicts) || edicts.length === 0) throw new Error('at least one edict is required');
  const sorted = edicts.slice().sort((a, b) => a.runeRef - b.runeRef);
  if (sorted[0].runeRef < MIN_RUNE_REF) {
    throw new Error(`rune references below ${MIN_RUNE_REF} are reserved (they would decode as a control message)`);
  }
  const parts = [];
  let prev = 0;
  sorted.forEach((e, i) => {
    if (!Number.isInteger(e.runeRef) || e.runeRef < 0) throw new Error('runeRef must be a non-negative integer');
    if (!Number.isInteger(e.output) || e.output < 0) throw new Error('output must be a non-negative integer');
    const delta = e.runeRef - prev;
    prev = e.runeRef;
    const last = i === sorted.length - 1 ? 1 : 0;
    parts.push(encodeVarint(delta), encodeVarint(e.amount), encodeVarint(e.output), encodeVarint(last));
  });
  return frame(Buffer.concat(parts));
}

function encodeMint(runeRef, proofIndex = null) {
  const parts = [encodeVarint(OP_MINT), encodeVarint(runeRef)];
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

  // The control messages are identified by a leading opcode; anything else is an edict stream.
  // The first varint of an edict stream is the lowest absolute rune reference, which is why
  // references below MIN_RUNE_REF are reserved and refused at encode time.
  if (body[0] === OP_MINT) return decodeMint(body);
  if (body[0] === OP_CHECKPOINT) return decodeCheckpoint(body);
  return decodeEdicts(body);
}

function decodeMint(body) {
  const a = readVarint(body, 1);
  if (!a) return null;
  let proofIndex = null;
  if (a.next < body.length) {
    const p = readVarint(body, a.next);
    if (!p || p.next !== body.length) return null; // trailing junk: ignore the whole message
    proofIndex = p.value;
  }
  return { type: 'mint', runeRef: a.value, proofIndex };
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
  let ref = 0;
  while (off < body.length) {
    const d = readVarint(body, off); if (!d) return null;
    const amt = readVarint(body, d.next); if (!amt) return null;
    const out = readVarint(body, amt.next); if (!out) return null;
    const flags = readVarint(body, out.next); if (!flags) return null;
    if (flags.value > 1) return null; // reserved bits must be zero
    ref += d.value;
    edicts.push({ runeRef: ref, amount: amt.value, output: out.value });
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
  MAGIC, VERSION, MAX_PAYLOAD, OP_MINT, OP_CHECKPOINT, MIN_RUNE_REF,
  encodeVarint, readVarint,
  encodeEdicts, encodeMint, encodeCheckpoint, decode, fits,
};
