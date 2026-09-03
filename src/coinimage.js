'use strict';
// A picture for a coin, held by this server.
//
// The protocol has no image field and deliberately so, which means whatever is shown beside a coin
// is somebody's convention. This is ours: the etcher uploads a small file, we keep it, we serve it.
// It is NOT on chain, and a page showing one should not imply that it is.
//
// EVERY RULE BELOW EXISTS BECAUSE AN UPLOAD ENDPOINT IS THE MOST ATTACKED THING A SITE HAS. The
// short version: nothing the caller sends is trusted for anything except the bytes themselves, and
// even those are only trusted after they have been read.
//
//   The FILENAME is never used. Not sanitised, not escaped: never used. The stored name is built
//   from the rune's own two integers, so no string a caller controls ever reaches the filesystem and
//   there is no traversal to defend against. A defence you do not need is a defence that cannot fail.
//
//   The CONTENT TYPE HEADER is never believed. The type is decided by reading the magic bytes,
//   because a caller who wants to store HTML will happily label it image/png.
//
//   SVG IS REFUSED OUTRIGHT, and this is the one that matters most. SVG is XML: it can carry
//   <script>, and an SVG served from our own origin is stored cross-site scripting against every
//   visitor, with the session of whoever opens the coin. There is no safe way to accept it here and
//   no reason to try, so it is not on the list.
//
//   DIMENSIONS ARE READ FROM THE HEADER and capped. A 40 KB PNG can declare 60,000 by 60,000 pixels,
//   and anything that later decodes it allocates fourteen gigabytes. Nothing here decodes an image,
//   which is the real defence, but the cap means nothing downstream can be made to either.

const path = require('path');
const codec = require('./runes/codec');

/**
 * Generous, because this is a server's disk and not a chain: the 68 KB ceiling an inscription lives
 * under does not apply to a file we simply keep. A hundred kilobytes across every coin that will
 * ever be etched is still nothing, and it is the difference between a logo and a thumbnail.
 *
 * The cap is still a cap. It bounds what one request can spend of the disk and of the time spent
 * reading it, and the dimension check below is what actually guards against a bomb.
 */
const MAX_BYTES = 100 * 1024;
/** Nothing sane needs more, and past it something is being attempted rather than uploaded. */
const MAX_SIDE = 1024;

// Sniffed, never taken from the request. Order matters only in that each test is exact.
const TYPES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 10 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
];

/** What these bytes actually are, or null. Reads the file; never asks the caller. */
function sniff(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  return TYPES.find((t) => { try { return t.test(bytes); } catch { return false; } }) || null;
}

/**
 * Width and height straight out of the header, without decoding anything.
 *
 * Returns null when they cannot be read, and a null is REFUSED by the caller rather than waved
 * through: a file whose header cannot be parsed is not a file we want to keep, whatever it is.
 */
function dimensions(bytes, mime) {
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: 8 byte signature, 4 length, 4 type, then w and h.
      if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/gif') return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const fmt = bytes.subarray(12, 16).toString('latin1');
      if (fmt === 'VP8X') return { w: (bytes.readUIntLE(24, 3) & 0xffffff) + 1, h: (bytes.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (fmt === 'VP8 ') return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = bytes.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      // Walk the segment markers to SOF, which is the only place the size is stated.
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        const len = bytes.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
  } catch { return null; }
  return null;
}

/**
 * Is this an acceptable coin image? Returns { ok, mime, ext, w, h } or { ok: false, why }.
 *
 * `why` is written for the person uploading, because the commonest cause of a refusal here is
 * somebody choosing a photograph rather than somebody attacking the site.
 */
function check(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, why: 'no file was sent' };
  if (bytes.length > MAX_BYTES) {
    return { ok: false, why: `that file is ${(bytes.length / 1024).toFixed(0)} KB and the limit is ${MAX_BYTES / 1024} KB. Try a smaller PNG, or the same one at 512 by 512.` };
  }
  const type = sniff(bytes);
  if (!type) {
    return { ok: false, why: 'that is not a PNG, JPEG, WEBP or GIF. SVG is not accepted, because an SVG can carry a script and this one would be served from our own domain.' };
  }
  const size = dimensions(bytes, type.mime);
  if (!size || !size.w || !size.h) return { ok: false, why: 'that file says it is an image but its header cannot be read' };
  if (size.w > MAX_SIDE || size.h > MAX_SIDE) {
    return { ok: false, why: `that image is ${size.w} by ${size.h} and the limit is ${MAX_SIDE} on a side` };
  }
  return { ok: true, mime: type.mime, ext: type.ext, w: size.w, h: size.h, bytes: bytes.length };
}

/**
 * Where a rune's image is kept.
 *
 * THE NAME IS BUILT FROM THE PARSED INTEGERS, never from the caller's text. parseRef returns null
 * for anything that is not two plain numbers, so a reference carrying a slash, a dot-dot, a null
 * byte or a unicode trick never reaches this line: it fails one step earlier as an unparseable
 * rune. That is why there is no sanitiser here and no need for one.
 */
function fileFor(dir, runeRef, ext) {
  const ref = codec.parseRef(runeRef);
  if (!ref) return null;
  if (!/^[a-z0-9]{1,5}$/.test(String(ext || ''))) return null;
  return path.join(dir, `${ref.height}-${ref.txIndex}.${ext}`);
}

/** The public url a page uses. Also derived from the integers, so it cannot carry anything. */
function urlFor(runeRef) {
  const ref = codec.parseRef(runeRef);
  return ref ? `/api/runes/image/${ref.height}-${ref.txIndex}` : null;
}

module.exports = { MAX_BYTES, MAX_SIDE, TYPES, sniff, dimensions, check, fileFor, urlFor };
