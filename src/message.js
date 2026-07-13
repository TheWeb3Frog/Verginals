'use strict';
// Server-side verification of Verge signed messages (the Bitcoin "magic hash" scheme the wallet's
// signMessage produces). We use it to authenticate a player: they sign our challenge string in the
// wallet, and we recover the signing address from the signature and check it matches the address
// they claim. No private key is ever involved on the server.
//
// The hash must be byte-identical to extension/lib/verge.js magicHash(), or nothing verifies:
//   dsha256( varstr(utf8("\x18Verge Signed Message:\n")) || varstr(utf8(message)) )
// and the signature is base64 of [header][r32][s32] with header = 27 + recoveryId + (compressed?4:0).

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');

const MSG_PREFIX = '\x18Verge Signed Message:\n';

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}
const varstr = (buf) => Buffer.concat([varint(buf.length), buf]);

/** dsha256(varstr(prefix) || varstr(message)) - the exact hash the wallet signs. */
function magicHash(message) {
  const pre = varstr(Buffer.from(MSG_PREFIX, 'utf8'));
  const msg = varstr(Buffer.from(String(message), 'utf8'));
  return bitcoin.crypto.hash256(Buffer.concat([pre, msg]));
}

/**
 * Recover the P2PKH address that signed `message`, or null if the signature is malformed.
 * @param {string} message
 * @param {string} sigB64  base64 of [header][r32][s32]
 * @param {object} network bitcoinjs network (from src/networks.js via pickNetwork)
 */
function recoverAddress(message, sigB64, network) {
  let raw;
  try { raw = Buffer.from(String(sigB64), 'base64'); } catch { return null; }
  if (raw.length !== 65) return null;
  const header = raw[0];
  if (header < 27 || header > 34) return null;
  const compressed = header >= 31;
  const recoveryId = (header - 27) & 3;
  const signature = raw.subarray(1); // 64 bytes r||s
  const hash = magicHash(message);
  let pubkey;
  try {
    pubkey = ecc.recover(hash, signature, recoveryId, compressed);
  } catch { return null; }
  if (!pubkey) return null;
  try {
    return bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubkey), network }).address;
  } catch { return null; }
}

/**
 * True if `sigB64` is a valid Verge signed-message signature of `message` by `address`.
 * Constant-work address compare (both are short strings, timing is not a concern here).
 */
function verifyMessage(address, message, sigB64, network) {
  if (!address || !message || !sigB64) return false;
  const recovered = recoverAddress(message, sigB64, network);
  return !!recovered && recovered === address;
}

module.exports = { magicHash, recoverAddress, verifyMessage, MSG_PREFIX };
