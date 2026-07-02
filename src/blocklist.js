'use strict';
// --- serve-blocklist ---------------------------------------------------------------------
// Inscriptions on Verge are permanent and immutable: nobody, including us, can remove data
// from the chain. What we CAN control is whether *our own* infrastructure serves or displays a
// given item. This module lets the operator flag content (by reveal txid, by content hash, or by
// Alpha-Verginals collection number) so the HTTP layer refuses to proxy it, returning
// 451 "Unavailable For Legal Reasons". This mirrors how the Ordinals `ord` explorer and
// marketplaces like UniSat moderate: the bytes stay on-chain, but the operator stops hosting them.
//
// The blocklist lives in a plain JSON file (default: <DATA_DIR>/blocklist.json) so it can be
// updated in seconds, e.g. on a valid CSAM report or DMCA notice, with no code change and no
// restart. The file is re-read automatically whenever its mtime changes.
//
// Schema (all fields optional):
//   {
//     "txids":      ["<64-hex reveal txid>", ...],   // block a specific inscription
//     "hashes":     ["<64-hex sha256 of content>", ...], // block content wherever it appears
//     "collection": [12, 345, ...],                  // block Alpha-Verginals image numbers
//     "notes":      { "<id>": "why it was blocked" } // optional, for the operator's own records
//   }

const fs = require('fs');

const HEX64 = /^[a-f0-9]{64}$/;

class Blocklist {
  constructor(file) {
    this.file = file;
    this._mtime = 0;
    this._txids = new Set();
    this._hashes = new Set();
    this._numbers = new Set();
    this.reload(); // initial load (tolerant of a missing file)
  }

  /** Re-read the file only when it has changed on disk (cheap stat on each check). */
  _refreshIfChanged() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch (_) {
      // File absent → treat as an empty blocklist, but keep whatever we last had if it vanished.
      if (this._mtime !== 0) { this._mtime = 0; this._txids.clear(); this._hashes.clear(); this._numbers.clear(); }
      return;
    }
    const m = st.mtimeMs;
    if (m !== this._mtime) { this._mtime = m; this.reload(); }
  }

  reload() {
    const txids = new Set();
    const hashes = new Set();
    const numbers = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of raw.txids || []) { const v = String(t).toLowerCase().trim(); if (HEX64.test(v)) txids.add(v); }
      for (const h of raw.hashes || []) { const v = String(h).toLowerCase().trim(); if (HEX64.test(v)) hashes.add(v); }
      for (const n of raw.collection || []) { const v = Number(n); if (Number.isInteger(v)) numbers.add(v); }
    } catch (_) {
      // Missing or malformed file → empty blocklist. Never let a bad file crash content serving.
    }
    this._txids = txids;
    this._hashes = hashes;
    this._numbers = numbers;
  }

  isTxidBlocked(txid) {
    this._refreshIfChanged();
    return this._txids.size > 0 && this._txids.has(String(txid).toLowerCase());
  }

  isHashBlocked(hashHex) {
    this._refreshIfChanged();
    return this._hashes.size > 0 && this._hashes.has(String(hashHex).toLowerCase());
  }

  isNumberBlocked(n) {
    this._refreshIfChanged();
    return this._numbers.size > 0 && this._numbers.has(Number(n));
  }
}

module.exports = { Blocklist };
