// Client-side inscription detector: decides, WITHOUT any server, whether a given UTXO carries a
// Verginal (and which one). This removes the VPS from the wallet's safety loop entirely: balance
// display and spend-safety are derived purely from chain data fetched over public ElectrumX.
//
// How it works (a faithful browser port of src/indexer.js + src/envelope.js):
//   - The ordinal "global offset" line is IDENTICAL on the input side and the output side of a tx:
//     inputs are laid end-to-end (cumulative input value), outputs are laid end-to-end from 0, and
//     an inscription enters at some global offset and exits at the SAME global offset (value order is
//     preserved; anything past total output value is paid to fee => burned). See indexer.js
//     assignToOutput/processTx.
//   - A reveal binds its new inscription to global offset 0 (the very first output sat).
//   - To enumerate the inscriptions residing in an output O, we recurse over the tx's ANCESTRY,
//     pruned to only the sat-ranges that flow into O: for each input whose global range overlaps O,
//     find the inscriptions in that prevout and map any that fall inside the overlap forward into O;
//     plus, if this tx is a reveal, its new inscription at global offset 0 lands in output 0.
//     Recursion bottoms out at coinbase / chain origin (newly minted sats, no inscription).
//
// IMPORTANT: inscriptions do NOT always sit at offset 0. The parent carry-forward mint places the
// parent at a non-zero offset of a later output (e.g. a real case has a parent riding at offset
// 800000 of vout 1). A naive "check offset 0 only" trace would misclassify such a carrier as ordinary
// XVG and could burn it. The overlap-pruned ancestry walk handles arbitrary offsets correctly.
//
// Results are immutable per outpoint (a UTXO's inscription status never changes while it is unspent,
// and a spent UTXO is gone), and raw transactions are immutable, so both are cached permanently.

import { hexToBytes, bytesToHex } from './verge.js';

// --- script opcodes / envelope tags (mirror src/envelope.js) ----------------
const OP_0 = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const TAG_CONTENT_TYPE = 0x01;
const TAG_PARENT = 0x03;
const TAG_METADATA = 0x05;

// OP_FALSE OP_IF push("ord")  ==  00 63 03 6f 72 64
const MAGIC = new Uint8Array([OP_0, OP_IF, 0x03, 0x6f, 0x72, 0x64]);

const DEFAULT_MAX_NODES = 4000; // ancestry outputs visited before giving up (=> unknown, fail-safe)

// --- byte helpers -----------------------------------------------------------
function reverseBytes(a) {
  const b = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) b[i] = a[a.length - 1 - i];
  return b;
}
function concatBytes(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
function bytesIndexOf(hay, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// --- raw transaction decode (Verge legacy: version|nTime|vin|vout|locktime) --
// Mirrors src/vergetx.js serialization, in reverse. Values are BigInt (atomic units), matching the
// units ElectrumX listunspent reports (COIN = 1e6). No witness is ever present.
export function decodeRawTx(hex) {
  const b = hexToBytes(hex);
  let o = 0;
  const need = (n) => { if (o + n > b.length) throw new Error('tx truncated'); };
  const u8 = () => { need(1); return b[o++]; };
  const u16 = () => { need(2); const v = b[o] | (b[o + 1] << 8); o += 2; return v; };
  const u32 = () => { need(4); const v = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0; o += 4; return v; };
  const i32 = () => { need(4); const v = new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0, true); o += 4; return v; };
  const u64 = () => { need(8); let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(b[o + i]) << BigInt(8 * i); o += 8; return v; };
  const bytes = (n) => { need(n); const s = b.subarray(o, o + n); o += n; return s; };
  const varint = () => {
    const x = u8();
    if (x < 0xfd) return x;
    if (x === 0xfd) return u16();
    if (x === 0xfe) return u32();
    const lo = BigInt(u32()); const hi = BigInt(u32());
    return Number(lo | (hi << 32n));
  };

  const version = i32();
  const time = u32();
  const vinLen = varint();
  const vin = [];
  for (let k = 0; k < vinLen; k++) {
    const prev = bytes(32);
    const prevVout = u32();
    const scriptSig = bytes(varint());
    const sequence = u32();
    let allZero = true;
    for (let i = 0; i < 32; i++) if (prev[i] !== 0) { allZero = false; break; }
    vin.push({
      txid: bytesToHex(reverseBytes(prev)),
      vout: prevVout,
      scriptSig,
      sequence,
      coinbase: allZero && prevVout === 0xffffffff,
    });
  }
  const voutLen = varint();
  const vout = [];
  for (let k = 0; k < voutLen; k++) {
    const value = u64();
    const scriptPubKey = bytes(varint());
    vout.push({ value, scriptPubKey });
  }
  const locktime = u32();
  return { version, time, vin, vout, locktime };
}

// --- envelope parsing (browser port of src/envelope.js) ---------------------
function readPush(script, i) {
  const op = script[i];
  if (op === OP_0) return { data: new Uint8Array(0), next: i + 1 };
  if (op < OP_PUSHDATA1) return { data: script.subarray(i + 1, i + 1 + op), next: i + 1 + op };
  if (op === OP_PUSHDATA1) { const len = script[i + 1]; return { data: script.subarray(i + 2, i + 2 + len), next: i + 2 + len }; }
  if (op === OP_PUSHDATA2) { const len = script[i + 1] | (script[i + 2] << 8); return { data: script.subarray(i + 3, i + 3 + len), next: i + 3 + len }; }
  return null;
}

export function parseInscriptionScript(script) {
  const start = bytesIndexOf(script, MAGIC);
  if (start === -1) return null;
  let i = start + MAGIC.length;
  let contentType = null;
  const parents = [];
  const metadata = [];
  const bodyChunks = [];
  let inBody = false;
  while (i < script.length) {
    if (script[i] === OP_ENDIF) break;
    const push = readPush(script, i);
    if (!push) return null;
    if (inBody) { bodyChunks.push(push.data); i = push.next; continue; }
    if (push.data.length === 0) { inBody = true; i = push.next; continue; }
    const tag = push.data[0];
    const valuePush = readPush(script, push.next);
    if (!valuePush) return null;
    if (tag === TAG_CONTENT_TYPE) contentType = valuePush.data;
    else if (tag === TAG_PARENT) parents.push(valuePush.data);
    else if (tag === TAG_METADATA) metadata.push(valuePush.data);
    i = valuePush.next;
  }
  return { contentType, parents, metadata, body: concatBytes(bodyChunks) };
}

/** tag-3 parent value -> "<txid>iN" (inverse of src/envelope.js parentIdToBuffer). */
function bufferToParentId(buf) {
  if (buf.length < 32) throw new Error('bad parent buffer');
  const txid = bytesToHex(reverseBytes(buf.subarray(0, 32)));
  let index = 0;
  for (let i = buf.length - 1; i >= 32; i--) index = index * 256 + buf[i];
  return `${txid}i${index}`;
}

/**
 * Extract the reveal envelope from a decoded tx's input scriptSigs (concatenating across inputs,
 * first content-type wins). Returns { contentType, parents } or null. Mirrors Indexer.extractReveal.
 */
function extractReveal(tx) {
  let contentType = null;
  const parents = [];
  let found = false;
  for (const inp of tx.vin) {
    if (!inp.scriptSig || inp.scriptSig.length === 0) continue;
    const parsed = parseInscriptionScript(inp.scriptSig);
    if (!parsed) continue;
    found = true;
    if (contentType === null && parsed.contentType) contentType = new TextDecoder().decode(parsed.contentType);
    for (const p of parsed.parents) { try { parents.push(bufferToParentId(p)); } catch { /* skip */ } }
  }
  if (!found) return null;
  return { contentType, parents };
}

// --- storage (permanent, immutable-keyed) -----------------------------------
function makeStorage(provided) {
  if (provided) return provided;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const s = chrome.storage.local;
    return {
      async get(key) { const r = await s.get(key); return r[key]; },
      async set(key, val) { await s.set({ [key]: val }); },
    };
  }
  const mem = new Map();
  return { async get(k) { return mem.get(k); }, async set(k, v) { mem.set(k, v); } };
}

export class InscriptionDetector {
  /**
   * @param {Object} electrum  an ElectrumClient (getTransaction(txid, true) -> verbose {hex,confirmations})
   * @param {Object} [opts]    { maxNodes, eraHeight, storage }
   *   eraHeight: a block height at or below the FIRST Verginal reveal. Descents that cross below it
   *   stop immediately as "clean" (no inscription can predate the collection). A too-LOW value only
   *   costs performance; a too-HIGH value (above a real reveal) would be unsafe, so keep it <= genesis.
   */
  constructor(electrum, { maxNodes = DEFAULT_MAX_NODES, eraHeight = 0, storage } = {}) {
    this.electrum = electrum;
    this.maxNodes = maxNodes;
    this.eraHeight = eraHeight;
    this.storage = makeStorage(storage);
    this._txMem = new Map();   // txid -> decoded tx (per-session in-memory cache)
    this._tip = null;
  }

  async _getTip() {
    if (this._tip == null) {
      try {
        const h = await this.electrum._rpc('blockchain.headers.subscribe', []);
        this._tip = (h && (h.height || h.block_height)) || 0;
      } catch { this._tip = 0; }
    }
    return this._tip;
  }

  // Returns the decoded tx with a `.height` property (Infinity if unconfirmed / unknown). Fetches
  // VERBOSE once so we get the raw hex AND the confirmation count in a single round-trip. Confirmed
  // txs are immutable, so {hex,height} is cached permanently; unconfirmed txs are only session-cached.
  async _getTx(txid) {
    if (this._txMem.has(txid)) return this._txMem.get(txid);
    const key = 'insc.tx.' + txid;
    let rec = await this.storage.get(key);
    if (typeof rec === 'string') rec = { hex: rec, height: null }; // tolerate an older cache shape
    if (!rec) {
      const v = await this.electrum.getTransaction(txid, true);
      if (!v || typeof v.hex !== 'string') throw new Error('unexpected tx format for ' + txid);
      let height = null;
      if (typeof v.confirmations === 'number' && v.confirmations > 0) height = (await this._getTip()) - v.confirmations + 1;
      rec = { hex: v.hex, height };
      if (height != null) await this.storage.set(key, rec); // persist only confirmed (immutable)
    }
    const tx = decodeRawTx(rec.hex);
    tx.height = rec.height == null ? Infinity : rec.height;
    this._txMem.set(txid, tx);
    return tx;
  }

  /**
   * Determine whether (txid, vout) carries a Verginal.
   * @returns {{status:'inscribed'|'clean'|'unknown', inscribed:boolean, id?, contentType?, parents?, all?}}
   *   'inscribed' -> id/contentType/parents of the primary (lowest-offset) carrier, plus `all`;
   *   'clean'     -> ordinary XVG; 'unknown' -> could not decide within the node budget / on a fetch
   *                  error (fail-safe: never spent, but still counted in the total balance).
   */
  async detect(txid, vout) {
    const okey = 'insc.d.' + txid + ':' + vout;
    const cached = await this.storage.get(okey);
    if (cached) return cached;

    const ctx = { budget: this.maxNodes, memo: new Map() };
    let out;
    try {
      out = await this._detectOutput(txid, vout, ctx);
    } catch (e) {
      return { status: 'unknown', inscribed: false, error: e.message };
    }

    let result;
    if (out.inscriptions.length) {
      const primary = out.inscriptions.slice().sort((a, b) => (BigInt(a.offset) < BigInt(b.offset) ? -1 : 1))[0];
      result = { status: 'inscribed', inscribed: true, id: primary.id, contentType: primary.contentType, parents: primary.parents, all: out.inscriptions };
    } else if (!out.complete) {
      result = { status: 'unknown', inscribed: false };
    } else {
      result = { status: 'clean', inscribed: false };
    }
    if (result.status !== 'unknown') await this.storage.set(okey, result);
    return result;
  }

  /**
   * Enumerate the inscriptions residing in output (txid, vout), each as { id, contentType, parents,
   * offset }, where `offset` is the decimal-string unit offset within THIS output. `complete` is false
   * if any relevant branch was cut (fetch error / node budget) so the caller must treat an empty list
   * as "unknown", never "clean".
   */
  async _detectOutput(txid, vout, ctx) {
    const key = txid + ':' + vout;
    if (ctx.memo.has(key)) return ctx.memo.get(key);
    // Permanent per-output cache (outpoints are immutable): only complete results are stored.
    const pkey = 'insc.o.' + key;
    const persisted = await this.storage.get(pkey);
    if (persisted) { ctx.memo.set(key, persisted); return persisted; }

    if (ctx.budget-- <= 0) return { inscriptions: [], complete: false };

    let tx;
    try { tx = await this._getTx(txid); } catch { return { inscriptions: [], complete: false }; }
    if (vout >= tx.vout.length) return { inscriptions: [], complete: false };

    // Launch-height floor: nothing below the first reveal can be an inscription, so a tx confirmed
    // before the era is definitively clean and we stop descending its ancestry. This bounds every
    // "prove clean" walk to the post-launch window instead of chasing funding back to a coinbase.
    if (tx.height < this.eraHeight) return { inscriptions: [], complete: true };

    let outStart = 0n;
    for (let i = 0; i < vout; i++) outStart += tx.vout[i].value;
    const outEnd = outStart + tx.vout[vout].value;

    const found = [];
    let complete = true;

    // (a) A reveal creates a new inscription at global offset 0, which lands in output 0.
    const reveal = extractReveal(tx);
    if (reveal && outStart === 0n) {
      found.push({ id: `${txid}i0`, contentType: reveal.contentType, parents: reveal.parents, offset: '0' });
    }

    // (b) Inscriptions flowing in from inputs whose global range overlaps this output's range.
    //     Inputs are laid out in order, so once cumIn reaches this output's end no later input can
    //     overlap: stop early (crucial so we don't walk funding inputs that fund LATER outputs).
    let cumIn = 0n;
    for (const inp of tx.vin) {
      if (cumIn >= outEnd) break;
      if (inp.coinbase) { cumIn += 0n; continue; } // newly minted sats carry no inscription
      let prevTx;
      try { prevTx = await this._getTx(inp.txid); } catch { complete = false; break; }
      if (inp.vout >= prevTx.vout.length) { complete = false; break; }
      const val = prevTx.vout[inp.vout].value;
      const inStart = cumIn;
      const lo = inStart > outStart ? inStart : outStart;         // overlap start (global)
      const hi = inStart + val < outEnd ? inStart + val : outEnd; // overlap end (global)
      if (lo < hi) {
        const child = await this._detectOutput(inp.txid, inp.vout, ctx);
        if (!child.complete) complete = false;
        for (const ci of child.inscriptions) {
          const g = inStart + BigInt(ci.offset); // this inscription's global offset in THIS tx
          if (g >= lo && g < hi) found.push({ ...ci, offset: (g - outStart).toString() });
        }
      }
      cumIn += val;
    }

    const result = { inscriptions: found, complete };
    if (complete) await this.storage.set(pkey, result);
    ctx.memo.set(key, result);
    return result;
  }

  /**
   * Annotate a list of UTXOs (each { txid, vout, ... }) with an `inscription` field:
   *   object   -> carries a Verginal   { id, contentType, parents }
   *   null     -> confirmed ordinary XVG (safe to spend)
   *   undefined-> status unknown (fail-safe: excluded from spends, still counted in total balance)
   * Sequential on purpose so shared ancestors hit the in-memory tx cache.
   */
  async annotate(utxos) {
    const out = [];
    for (const u of utxos) {
      const d = await this.detect(u.txid, u.vout);
      let inscription;
      if (d.status === 'inscribed') inscription = { id: d.id, contentType: d.contentType, parents: d.parents };
      else if (d.status === 'clean') inscription = null;
      else inscription = undefined;
      out.push({ ...u, inscription, inscriptionStatus: d.status });
    }
    return out;
  }

  /**
   * Fetch an inscription's actual content (for display previews), fully client-side: the envelope
   * body lives in the reveal tx named by the id ("<revealTxid>iN"), which we fetch (cached) and parse
   * in-browser. Returns { contentType:string, body:Uint8Array }. Never on the safety path.
   */
  async getContent(id) {
    const m = /^([0-9a-fA-F]{64})i(\d+)$/.exec(id || '');
    if (!m) throw new Error('bad inscription id');
    const tx = await this._getTx(m[1]);
    // A reveal chunks large content across MANY inputs: input 0 carries the content-type tag plus the
    // first body slice, and each following input appends another body slice (its scriptSig has no
    // content-type). Concatenate every envelope's body IN INPUT ORDER, keep the first content-type.
    let contentType = null;
    const chunks = [];
    let found = false;
    for (const inp of tx.vin) {
      const p = parseInscriptionScript(inp.scriptSig);
      if (!p) continue;
      found = true;
      if (contentType === null && p.contentType) contentType = new TextDecoder().decode(p.contentType);
      if (p.body && p.body.length) chunks.push(p.body);
    }
    if (!found) throw new Error('no inscription envelope in reveal tx');
    return { contentType, body: concatBytes(chunks) };
  }
}
