'use strict';
// --- promo controller --------------------------------------------------------------------
// Optional launch campaign: the first N Alpha Verginals mints are funded by the operator instead
// of the minter. This module is PURE (no RPC, no HTTP): it only tracks who has claimed a free
// mint and decides eligibility. The actual on-chain funding (send from the promo wallet to the
// job's deposit address) lives in server.js, next to the tx-building primitives, exactly like the
// mint controller stays pure while server.js drives the chain.
//
// State lives in a plain JSON file (default: <DATA_DIR>/promo.json) so a restart never re-gifts a
// slot. Each claim is recorded per job with the receiving address and a SALTED hash of the claimer
// IP (never the raw IP, so the file holds no personal data). A slot is consumed while a claim is
// "held" (deposit funded, mint in flight) and stays consumed once "confirmed". If a funded job is
// abandoned or its funding fails, the server releases the record and the slot returns to the pool.
//
// Eligibility gates (all must pass):
//   * the campaign is enabled and a promo key is loaded,
//   * used slots (held + confirmed) < limit,
//   * this receiving address is under the per-address cap,
//   * this IP (hashed) is under the per-IP cap.
//
// Turning the campaign off is just enabled=false (or used >= limit): status().active goes false
// and the site's promo badge disappears on its own, with no site edit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PromoController {
  constructor({ dataDir, enabled, hasKey, limit, maxPerAddr, maxPerIp, file }) {
    this.file = file || path.join(dataDir, 'promo.json');
    this.enabled = !!enabled;
    this.hasKey = !!hasKey;
    this.limit = Math.max(0, Number(limit) || 0);
    this.maxPerAddr = Math.max(1, Number(maxPerAddr) || 1);
    this.maxPerIp = Math.max(1, Number(maxPerIp) || 1);
    // { salt, jobs: { [jobId]: { addr, ipHash, at, status: 'held' | 'confirmed' } } }
    this.state = { salt: null, jobs: {} };
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state.jobs = raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : {};
      this.state.salt = typeof raw.salt === 'string' && raw.salt ? raw.salt : null;
    } catch (_) {
      /* no file yet: start empty */
    }
    if (!this.state.salt) {
      // A per-install salt so stored IP hashes cannot be reversed with a plain rainbow table.
      this.state.salt = crypto.randomBytes(16).toString('hex');
      this.save();
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  ipHash(ip) {
    return crypto
      .createHash('sha256')
      .update(this.state.salt + '|' + String(ip || ''))
      .digest('hex')
      .slice(0, 16);
  }

  // A slot is consumed by any live claim, whether still in flight or already confirmed.
  _live() {
    return Object.values(this.state.jobs).filter((j) => j.status === 'held' || j.status === 'confirmed');
  }
  usedCount() {
    return this._live().length;
  }
  confirmedCount() {
    return Object.values(this.state.jobs).filter((j) => j.status === 'confirmed').length;
  }
  remaining() {
    return Math.max(0, this.limit - this.usedCount());
  }
  active() {
    return this.enabled && this.hasKey && this.remaining() > 0;
  }
  isPromoJob(jobId) {
    return !!this.state.jobs[jobId];
  }

  _perAddr(addr) {
    return this._live().filter((j) => j.addr === addr).length;
  }
  _perIpHash(ipHash) {
    return this._live().filter((j) => j.ipHash === ipHash).length;
  }

  // Read-only pre-check. hold() re-checks the same gates before actually consuming a slot, so this
  // is safe to call for display / early exit without reserving anything.
  eligible(ip, to) {
    if (!this.active()) return false;
    if (this._perAddr(to) >= this.maxPerAddr) return false;
    if (this._perIpHash(this.ipHash(ip)) >= this.maxPerIp) return false;
    return true;
  }

  // Atomically consume a slot for jobId. Node is single-threaded, so re-checking the gates here and
  // recording in the same synchronous step cannot race. Returns true if the slot was reserved.
  hold(jobId, ip, to) {
    if (this.state.jobs[jobId]) return true; // idempotent
    if (!this.eligible(ip, to)) return false;
    this.state.jobs[jobId] = { addr: to, ipHash: this.ipHash(ip), at: Date.now(), status: 'held' };
    this.save();
    return true;
  }

  confirm(jobId) {
    const j = this.state.jobs[jobId];
    if (j) {
      j.status = 'confirmed';
      this.save();
    }
  }

  // Free a slot whose funding failed or whose job was abandoned before it minted.
  release(jobId) {
    if (this.state.jobs[jobId]) {
      delete this.state.jobs[jobId];
      this.save();
    }
  }

  status() {
    return {
      active: this.active(),
      remaining: this.remaining(),
      limit: this.limit,
      claimed: this.usedCount(),
      confirmed: this.confirmedCount(),
    };
  }
}

module.exports = { PromoController };
