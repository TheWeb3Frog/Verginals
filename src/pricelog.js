'use strict';
// A price history, so a market can say what it has DONE and not only what it is asking now.
//
// The site had no answer to "is this going up", because nothing anywhere remembered yesterday. A
// floor is a reading of one instant: on its own it cannot be compared to anything, and a
// marketplace that cannot show a change is a marketplace that looks abandoned even while it trades.
//
// Two decisions shape the whole file.
//
// It is keyed by an OPAQUE STRING, not by "the Alpha collection". A market here is anything with a
// price that moves: "collection:alpha", "collection:<launchpad slug>", "coin:<height>:<txIndex>".
// A new collection or a new coin needs no change in here at all, which is the point.
//
// And it stores a point only when the price CHANGES. A reading every five minutes for a year is a
// hundred thousand numbers saying the same thing; the last point at or before a moment answers the
// question just as well. What that alone cannot tell you is whether a flat line means a stable
// market or a log that only started this morning, so the first time a key is ever seen is kept
// separately, and every window shorter than the log is refused rather than answered from a
// beginning that does not exist.

const fs = require('fs');

const DAY = 86400;
const KEEP_SEC = 45 * DAY;    // long enough for a 30d window to always have a floor behind it
const MAX_POINTS = 4000;      // per key, a hard stop on a market that flickers

/** Seconds, whatever unit the caller kept. A millisecond stamp reads as the year 58,000. */
const secs = (t) => (Number(t) > 1e11 ? Math.round(Number(t) / 1000) : Number(t)) || 0;

class PriceLog {
  /**
   * @param {object} opts
   * @param {string} opts.file    where the log lives (one JSON file, atomic write)
   * @param {function} [opts.now] () => unix seconds
   * @param {number} [opts.keep]  seconds of history to keep
   */
  constructor({ file, now, keep }) {
    this.file = file;
    this.now = now || (() => Math.floor(Date.now() / 1000));
    this.keep = keep || KEEP_SEC;
    // key -> { from: <first ever seen>, pts: [[ts, units|null], ...] } ; null means "nothing listed"
    this.state = { v: 1, series: {} };
    this.dirty = false;
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s && s.series && typeof s.series === 'object') this.state = { v: 1, series: s.series };
    } catch (_) { /* a missing or unreadable log starts empty, which is the honest state */ }
    return this;
  }

  save() {
    if (!this.dirty) return false;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    return true;
  }

  /**
   * Note what a market costs now. `priceUnits` may be null, which is a real reading: it means
   * nothing is for sale, and it is NOT the same fact as a price of zero.
   *
   * Writes nothing when the price is unchanged, so a market nobody touches costs one point for
   * ever rather than one point per sweep.
   */
  record(key, priceUnits) {
    if (typeof key !== 'string' || !key) throw new Error('a price log key must be a non-empty string');
    const v = priceUnits == null ? null : Number(priceUnits);
    if (v != null && !(Number.isFinite(v) && v >= 0)) throw new Error('a price must be a number or null');
    const t = this.now();
    let s = this.state.series[key];
    if (!s) { s = { from: t, pts: [] }; this.state.series[key] = s; }
    const last = s.pts[s.pts.length - 1];
    if (last && last[1] === v) return false;
    s.pts.push([t, v]);
    if (s.pts.length > MAX_POINTS) s.pts.splice(0, s.pts.length - MAX_POINTS);
    this._prune(s, t);
    this.dirty = true;
    return true;
  }

  /**
   * Drop points that are older than the window, EXCEPT the last one before it: that point is what
   * answers a lookup at the far edge, and throwing it away would turn a long stable market into a
   * market with no history.
   */
  _prune(s, t) {
    const cutoff = t - this.keep;
    let keepFrom = 0;
    for (let i = 0; i < s.pts.length; i++) {
      if (s.pts[i][0] <= cutoff) keepFrom = i; else break;
    }
    if (keepFrom > 0) s.pts.splice(0, keepFrom);
  }

  /** The price at a moment: the last reading at or before it, or undefined if the log starts later. */
  at(key, ts) {
    const s = this.state.series[key];
    if (!s || !s.pts.length) return undefined;
    const t = secs(ts);
    let found;
    for (const p of s.pts) { if (p[0] <= t) found = p[1]; else break; }
    return found;
  }

  /** The most recent reading, or undefined if this market has never been seen. */
  latest(key) {
    const s = this.state.series[key];
    if (!s || !s.pts.length) return undefined;
    return s.pts[s.pts.length - 1][1];
  }

  /** When this key was first ever recorded, or null. */
  since(key) {
    const s = this.state.series[key];
    return s ? s.from : null;
  }

  /**
   * The change over a window, or null when it cannot honestly be stated.
   *
   * Null, not zero, in every one of these: the log is younger than the window asked for; nothing
   * was for sale at one end of it; or the old price was zero, which no percentage can be taken
   * against. A market with no answer must show no answer, because "0.00%" is a claim.
   */
  changeOver(key, seconds) {
    const s = this.state.series[key];
    if (!s || !s.pts.length) return null;
    const now = this.now();
    if (s.from > now - seconds) return null;
    const to = this.latest(key);
    const from = this.at(key, now - seconds);
    if (from == null || to == null) return null;
    if (!(from > 0)) return null;
    return { from, to, pct: ((to - from) / from) * 100, window: seconds };
  }

  /** Every key held, for maintenance and tests. */
  keys() { return Object.keys(this.state.series); }

  /** Forget a market entirely (a collection that was withdrawn, a coin that was a mistake). */
  forget(key) {
    if (!this.state.series[key]) return false;
    delete this.state.series[key];
    this.dirty = true;
    return true;
  }
}

/** The key for a collection's floor. `slug` null is the Alpha collection. */
const collectionKey = (slug) => 'collection:' + (slug || 'alpha');
/** The key for a coin's best ask, per whole coin. */
const coinKey = (runeRef) => 'coin:' + runeRef;

module.exports = { PriceLog, collectionKey, coinKey, secs, DAY };
