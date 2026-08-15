// Verge Runes in the browser wallet (ESM, MV3-safe). Mirrors the rules of src/runes/*, checked
// against them in extension/test-runes.mjs.
//
// A wallet cannot index the whole chain, and it must not have to trust whoever indexes it for it.
// That is exactly what checkpoints are for (RUNES-SPEC-v0 §8): an indexer hands over a balance and
// a merkle proof, the wallet checks the proof against a root it read from the chain itself, and a
// lying or dead indexer can neither forge a balance nor be believed.
//
// The other half of this file is the safety rule that matters more than any feature: a rune-
// carrying coin is never spent to pay for something else.

import * as verge from './verge.js';

const MAGIC_0 = 0x56, MAGIC_1 = 0x41; // "VA"
const VERSION = 0;
const MAX_PAYLOAD = 83;
const OP_MINT = 1, OP_CHECKPOINT = 2;
export const DUST_UNITS = 100000;

// --- wire format (decode only: a wallet reads messages, the backend builds them) ----------------

function readVarint(buf, offset) {
  let value = 0, shift = 1;
  for (let i = offset; i < buf.length; i++) {
    const byte = buf[i];
    value += (byte & 0x7f) * shift;
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) return null;
  }
  return null;
}

/** Decode an OP_RETURN payload, or null for anything this version does not understand. */
export function decodeMessage(payload) {
  if (!payload || payload.length < 3 || payload.length > MAX_PAYLOAD) return null;
  if (payload[0] !== MAGIC_0 || payload[1] !== MAGIC_1 || payload[2] !== VERSION) return null;
  const body = payload.slice(3);
  if (body.length === 0) return null;

  if (body[0] === OP_MINT) {
    const a = readVarint(body, 1);
    return a ? { type: 'mint', runeRef: a.value } : null;
  }
  if (body[0] === OP_CHECKPOINT) {
    const h = readVarint(body, 1);
    if (!h) return null;
    const root = body.slice(h.next);
    return root.length === 32 ? { type: 'checkpoint', height: h.value, root } : null;
  }
  const edicts = [];
  let off = 0, ref = 0;
  while (off < body.length) {
    const d = readVarint(body, off); if (!d) return null;
    const amt = readVarint(body, d.next); if (!amt) return null;
    const out = readVarint(body, amt.next); if (!out) return null;
    const flags = readVarint(body, out.next); if (!flags || flags.value > 1) return null;
    ref += d.value;
    edicts.push({ runeRef: ref, amount: amt.value, output: out.value });
    off = flags.next;
    if (flags.value === 1) return off === body.length ? { type: 'edicts', edicts } : null;
  }
  return null;
}

// --- checkpoint proofs: how the wallet avoids trusting an indexer -------------------------------

const enc = new TextEncoder();
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Fixed ordering, so a proof never has to carry left/right flags. Mirrors checkpoint.js. */
function cmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

async function parentHash(a, b) {
  const joined = new Uint8Array(a.length + b.length);
  if (cmp(a, b) <= 0) { joined.set(a, 0); joined.set(b, a.length); }
  else { joined.set(b, 0); joined.set(a, b.length); }
  return verge.sha256(joined);
}

/**
 * Check that `entry` really is part of the state the published `root` commits to.
 *
 * This is the whole trust story: run this, and a balance an indexer told you becomes a balance the
 * chain told you. Returns false rather than throwing on any malformed input.
 */
export async function verifyBalance(entry, path, root) {
  if (!entry || !Array.isArray(path) || !root || root.length !== 32) return false;
  let node = await verge.sha256(enc.encode(`${entry.outpoint}|${entry.runeRef}|${entry.amount}`));
  for (const sib of path) {
    if (!sib || sib.length !== 32) return false;
    node = await parentHash(node, sib);
  }
  return eq(node, root);
}

/**
 * Turn an indexer's answer into balances the wallet is willing to believe.
 *
 * Every entry must carry a proof that verifies against `root`. An entry that does not verify is
 * DROPPED, never merged in: a balance the wallet cannot prove is a balance it does not have.
 * Returns { balances: Map(outpoint -> {runeRef: amount}), rejected }.
 */
export async function verifiedBalances(answer, root) {
  const balances = new Map();
  let rejected = 0;
  for (const item of (answer && answer.entries) || []) {
    const ok = await verifyBalance(item.entry, (item.path || []).map((p) => Uint8Array.from(p)), root);
    if (!ok) { rejected += 1; continue; }
    const { outpoint, runeRef, amount } = item.entry;
    const at = balances.get(outpoint) || {};
    at[runeRef] = (at[runeRef] || 0) + amount;
    balances.set(outpoint, at);
  }
  return { balances, rejected };
}

// --- the safety rule ----------------------------------------------------------------------------

/** Does this coin carry any rune? `undefined` means "not known", which counts as yes. */
export function carriesRune(utxo) {
  if (!utxo || utxo.runes === undefined || utxo.runes === null) return true; // unknown: assume it does
  return Object.keys(utxo.runes).length > 0;
}

/**
 * The coins a plain payment may spend: runes confirmed absent AND inscriptions confirmed absent.
 *
 * Both checks are deliberately positive. A coin whose status could not be determined is left alone,
 * because the cost of being wrong is asymmetric: a refused payment is an inconvenience, a spent
 * inscription or token is gone for good.
 */
export function spendableForPayment(utxos) {
  return (utxos || []).filter((u) => u.inscription === null && u.runes !== undefined
    && u.runes !== null && Object.keys(u.runes).length === 0);
}

/**
 * Coins for a transfer that is deliberately moving `runeRef`: the carriers, plus clean coins for
 * the fee. Throws rather than reaching for another rune's carrier to make up a shortfall.
 */
export function selectForRuneTransfer(utxos, runeRef, amount, { targetValue = 0, fee = 0 } = {}) {
  const holders = (utxos || [])
    .filter((u) => u.runes && u.runes[runeRef] > 0)
    .sort((a, b) => b.runes[runeRef] - a.runes[runeRef]);
  const held = holders.reduce((s, u) => s + u.runes[runeRef], 0);
  const need = amount === 0 ? held : amount;
  if (need <= 0 || held < need) {
    const e = new Error(`insufficient balance for rune ${runeRef}: need ${need}, hold ${held}`);
    e.name = 'InsufficientRune';
    throw e;
  }

  const inputs = [];
  let got = 0;
  for (const u of holders) {
    if (got >= need) break;
    inputs.push(u);
    got += u.runes[runeRef];
  }

  let value = inputs.reduce((s, u) => s + u.value, 0);
  const required = targetValue + fee;
  if (value < required) {
    for (const u of spendableForPayment(utxos)) {
      if (value >= required) break;
      inputs.push(u);
      value += u.value;
    }
  }
  if (value < required) {
    const e = new Error(`insufficient spendable funds: need ${required}, have ${value}`);
    e.name = 'InsufficientFunds';
    throw e;
  }

  // Anything else riding on the chosen coins must be given a destination by the caller, or the
  // default assignment will sweep it to the first output.
  const alsoCarried = {};
  for (const u of inputs) {
    for (const [ref, amt] of Object.entries(u.runes || {})) {
      if (Number(ref) === Number(runeRef)) continue;
      alsoCarried[ref] = (alsoCarried[ref] || 0) + amt;
    }
  }
  return { inputs, inputValue: value, gathered: got, alsoCarried };
}
