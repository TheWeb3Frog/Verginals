'use strict';
// Minimal CBOR (RFC 8949) codec for inscription metadata (ord tag 5).
//
// ord stores the optional metadata field as CBOR, and explorers/marketplaces decode it to
// display per-item traits. We only need a small, dependency-free subset: text strings,
// non-negative integers, arrays, and string-keyed maps. Map keys are emitted in the order the
// caller provides, so encoding is deterministic for a fixed input (two encoders that see the
// same object produce identical bytes).

// Encode a CBOR head byte (major type + argument) for a length/value n.
function head(major, n) {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) return Buffer.from([m | 25, n >> 8, n & 0xff]);
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = m | 26;
    b.writeUInt32BE(n >>> 0, 1);
    return b;
  }
  // 64-bit argument, split into hi/lo 32-bit words (safe for integers up to 2^53).
  const b = Buffer.alloc(9);
  b[0] = m | 27;
  b.writeUInt32BE(Math.floor(n / 0x100000000), 1);
  b.writeUInt32BE(n >>> 0, 5);
  return b;
}

/** Encode a JS value (string | non-negative int | array | plain object) to CBOR bytes. */
function encode(value) {
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`cbor: only non-negative integers are supported (got ${value})`);
    }
    return head(0, value);
  }
  if (Array.isArray(value)) {
    const parts = [head(4, value.length)];
    for (const el of value) parts.push(encode(el));
    return Buffer.concat(parts);
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const parts = [head(5, keys.length)];
    for (const k of keys) {
      parts.push(encode(String(k)));
      parts.push(encode(value[k]));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported value type ${value === null ? 'null' : typeof value}`);
}

// Read the argument (length/value) of the item at offset. Returns [n, nextOffset].
function readArg(buf, off) {
  const ai = buf[off] & 0x1f;
  off += 1;
  if (ai < 24) return [ai, off];
  if (ai === 24) return [buf[off], off + 1];
  if (ai === 25) return [buf.readUInt16BE(off), off + 2];
  if (ai === 26) return [buf.readUInt32BE(off), off + 4];
  if (ai === 27) return [buf.readUInt32BE(off) * 0x100000000 + buf.readUInt32BE(off + 4), off + 8];
  throw new Error(`cbor: unsupported additional info ${ai}`);
}

// Read one CBOR item at offset. Returns [value, nextOffset].
function readItem(buf, off) {
  const major = buf[off] >> 5;
  if (major === 0) return readArg(buf, off); // unsigned int: the argument IS the value
  if (major === 3) {
    const [n, o] = readArg(buf, off);
    return [buf.subarray(o, o + n).toString('utf8'), o + n];
  }
  if (major === 4) {
    let [n, o] = readArg(buf, off);
    const arr = [];
    for (let i = 0; i < n; i++) {
      const [v, o2] = readItem(buf, o);
      arr.push(v);
      o = o2;
    }
    return [arr, o];
  }
  if (major === 5) {
    let [n, o] = readArg(buf, off);
    const obj = {};
    for (let i = 0; i < n; i++) {
      const [k, o2] = readItem(buf, o);
      const [v, o3] = readItem(buf, o2);
      obj[k] = v;
      o = o3;
    }
    return [obj, o];
  }
  throw new Error(`cbor: unsupported major type ${major}`);
}

/** Decode CBOR bytes back to a JS value. Throws on trailing bytes. */
function decode(buf) {
  const [value, off] = readItem(buf, 0);
  if (off !== buf.length) throw new Error(`cbor: ${buf.length - off} trailing byte(s)`);
  return value;
}

module.exports = { encode, decode };
