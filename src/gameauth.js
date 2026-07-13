'use strict';
// Verginals Arena authentication: a challenge/response handshake plus short-lived session tokens.
// No custody, no passwords. The player proves control of an address by signing a one-time challenge
// string in their wallet (verified by src/message.js); we then hand back an HMAC session token that
// carries the address, so later game calls do not re-sign every time.
//
// Everything here is pure/in-memory and injectable (now, nonce) so it tests without a clock or a
// server. The signing itself lives in the wallet; this module never sees a private key.

const crypto = require('crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;   // a challenge must be answered within 5 minutes
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // a session lasts 12 hours

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class GameAuth {
  /**
   * @param {object} [opts]
   * @param {string} opts.secret   server secret for HMAC (keep out of the repo; from systemd env)
   * @param {Function} [opts.now]  () => ms, injectable for tests
   * @param {Function} [opts.nonce] () => string, injectable for tests
   */
  constructor(opts = {}) {
    this.secret = opts.secret || crypto.randomBytes(32).toString('hex');
    this.now = opts.now || (() => Date.now());
    this.nonceFn = opts.nonce || (() => crypto.randomBytes(16).toString('hex'));
    this.challenges = new Map(); // nonce -> { address, expiry, used }
  }

  /** Drop expired challenges so the map cannot grow without bound. */
  _prune() {
    const t = this.now();
    for (const [nonce, c] of this.challenges) if (c.expiry <= t) this.challenges.delete(nonce);
  }

  /** Mint a one-time challenge string for an address. The wallet signs the returned `challenge`. */
  issueChallenge(address) {
    if (!address) throw new Error('address required');
    this._prune();
    const nonce = this.nonceFn();
    const expiry = this.now() + CHALLENGE_TTL_MS;
    this.challenges.set(nonce, { address, expiry, used: false });
    return { nonce, expiry, challenge: `verginals-arena:${address}:${nonce}:${expiry}` };
  }

  /**
   * Reconstruct the challenge string an address must have signed, and mark the nonce spent. Returns
   * the exact string to hand to verifyMessage, or throws if the nonce is unknown/expired/reused or
   * bound to a different address. Single-use: a nonce verifies at most once.
   */
  consumeChallenge(address, nonce) {
    this._prune();
    const c = this.challenges.get(nonce);
    if (!c) throw new Error('unknown or expired challenge');
    if (c.used) throw new Error('challenge already used');
    if (c.address !== address) throw new Error('challenge address mismatch');
    if (c.expiry <= this.now()) throw new Error('challenge expired');
    c.used = true;
    return `verginals-arena:${address}:${nonce}:${c.expiry}`;
  }

  /** Issue a session token for an address (call only after the signature verified). */
  issueToken(address, ttlMs = TOKEN_TTL_MS) {
    const issued = this.now();
    const expiry = issued + ttlMs;
    const body = `${address}.${issued}.${expiry}`;
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest();
    return `${b64url(body)}.${b64url(mac)}`;
  }

  /** Verify a session token; returns the address it authenticates, or null. */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const bodyB64 = token.slice(0, dot);
    const macB64 = token.slice(dot + 1);
    let body;
    try { body = Buffer.from(bodyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
    const expected = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    // Constant-time compare on equal-length buffers.
    const a = Buffer.from(macB64);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parts = body.split('.');
    if (parts.length !== 3) return null;
    const [address, , expiry] = parts;
    if (Number(expiry) <= this.now()) return null;
    return address;
  }
}

module.exports = { GameAuth, CHALLENGE_TTL_MS, TOKEN_TTL_MS };
