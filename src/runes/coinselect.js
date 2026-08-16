'use strict';
// Verge Runes: rune-aware coin selection (RUNES-PLAN §2.3).
//
// This is the file that decides whether users lose money.
//
// On Bitcoin, the recurring way people have destroyed inscriptions and tokens is boringly simple: a
// wallet picks utxos by value to pay a fee, happens to grab the one carrying the rune, and the
// rune is spent into the miner's pocket. It is not an exotic attack, it is ordinary coin selection
// meeting a rune-bearing utxo. So the rule here is absolute:
//
//   A utxo carrying a rune is NEVER selected for its value. It is selected only when the
//   transaction is deliberately moving the rune it carries, and never otherwise.
//
// When clean funds are short, this module FAILS rather than reaching for a rune utxo. A failed
// transaction is an inconvenience; a burnt rune is permanent.

const DUST_UNITS = 100000; // 0.1 XVG

const carries = (u) => !!(u.runes && Object.keys(u.runes).length > 0);
const amountOf = (u, ref) => (u.runes && u.runes[ref]) || 0;

class InsufficientFunds extends Error {
  constructor(needed, available) {
    super(`insufficient spendable funds: need ${needed} units, only ${available} available in utxos that carry no rune`);
    this.name = 'InsufficientFunds';
    this.needed = needed;
    this.available = available;
  }
}

class InsufficientRune extends Error {
  constructor(runeRef, needed, available) {
    super(`insufficient balance for rune ${runeRef}: need ${needed}, hold ${available}`);
    this.name = 'InsufficientRune';
    this.runeRef = runeRef;
    this.needed = needed;
    this.available = available;
  }
}

/**
 * Choose inputs for a transaction.
 *
 * @param {Object} p
 * @param {Array}  p.utxos        [{ txid, vout, value, runes?: { [runeRef]: amount } }]
 * @param {number} p.targetValue  units the outputs will consume
 * @param {number} p.fee          units for the miner
 * @param {Array}  [p.requiredRunes] [{ runeRef, amount }] amount 0 means "every unit held"
 * @param {number} [p.dustUnits]
 * @returns {{ inputs, inputValue, changeValue, gathered, carriedRunes }}
 *
 * `carriedRunes` reports every rune the chosen inputs hold, including ones that were not asked
 * for: they came along on a utxo we needed, and the caller MUST assign them to an output or the
 * default assignment will move them somewhere unintended.
 */
function selectCoins({ utxos, targetValue = 0, fee = 0, requiredRunes = [], dustUnits = DUST_UNITS }) {
  if (!Array.isArray(utxos)) throw new Error('utxos must be an array');
  const chosen = [];
  const used = new Set();
  const key = (u) => `${u.txid}:${u.vout}`;

  // The candidate lists below are built once and walked, while `used` fills up as we go, so the same
  // outpoint appearing twice in `utxos` would be selected twice and the transaction would spend one
  // input as two. Deduplicate up front rather than re-filtering inside every loop.
  const seen = new Set();
  utxos = utxos.filter((u) => { const k = key(u); if (seen.has(k)) return false; seen.add(k); return true; });

  // 1) Gather the runes the transaction actually needs, largest holding first so the fewest inputs
  //    are touched. These are the ONLY rune-bearing utxos that may be spent.
  const gathered = {};
  for (const req of requiredRunes) {
    // A utxo already chosen for another rune may well carry this one too, so count what is already
    // in hand before looking for more. Skipping this made a utxo holding two required runes fail on
    // the second one.
    let got = chosen.reduce((s, u) => s + amountOf(u, req.runeRef), 0);
    const spare = utxos
      .filter((u) => amountOf(u, req.runeRef) > 0 && !used.has(key(u)))
      .sort((a, b) => amountOf(b, req.runeRef) - amountOf(a, req.runeRef));
    const held = got + spare.reduce((s, u) => s + amountOf(u, req.runeRef), 0);
    const need = req.amount === 0 ? held : req.amount;
    if (need <= 0 || held < need) throw new InsufficientRune(req.runeRef, need, held);

    for (const u of spare) {
      if (got >= need) break;
      chosen.push(u);
      used.add(key(u));
      got += amountOf(u, req.runeRef);
    }
    gathered[req.runeRef] = got;
  }

  // 2) Top up with CLEAN utxos only. A rune-bearing utxo is never considered here, whatever its
  //    value and however short we are.
  let inputValue = chosen.reduce((s, u) => s + u.value, 0);
  const needed = targetValue + fee;
  if (inputValue < needed) {
    const clean = utxos
      .filter((u) => !carries(u) && !used.has(key(u)))
      .sort((a, b) => b.value - a.value); // largest first: fewest inputs, smallest fee
    for (const u of clean) {
      if (inputValue >= needed) break;
      chosen.push(u);
      used.add(key(u));
      inputValue += u.value;
    }
  }
  if (inputValue < needed) {
    const availableClean = utxos.filter((u) => !carries(u) && !used.has(key(u))).reduce((s, u) => s + u.value, 0)
      + chosen.reduce((s, u) => s + u.value, 0);
    throw new InsufficientFunds(needed, availableClean);
  }

  // 3) Report every rune riding on the chosen inputs, asked for or not.
  const carriedRunes = {};
  for (const u of chosen) {
    for (const [ref, amt] of Object.entries(u.runes || {})) {
      carriedRunes[ref] = (carriedRunes[ref] || 0) + amt;
    }
  }

  const change = inputValue - needed;
  return {
    inputs: chosen,
    inputValue,
    // Change below dust is left to the miner rather than creating an unspendable output.
    changeValue: change >= dustUnits ? change : 0,
    gathered,
    carriedRunes,
  };
}

/**
 * Safety net for a plain XVG payment: assert that nothing in this selection carries a rune.
 * Call it on every ordinary send. It is one line, and it is the line that would have saved a lot of
 * Ordinals users.
 */
function assertNoRunesSpent(selection) {
  const refs = Object.keys(selection.carriedRunes || {});
  if (refs.length > 0) {
    throw new Error(`refusing to spend rune-carrying inputs in a plain payment (runes: ${refs.join(', ')})`);
  }
  return selection;
}

/**
 * Every rune on the inputs must be assigned to some output, or the default assignment will sweep it
 * to the first eligible output, which is rarely what the sender meant. Returns the runes that are
 * unaccounted for, so a wallet can add a self-send edict before signing.
 */
function unassignedRunes(selection, edicts) {
  const assigned = new Set((edicts || []).map((e) => String(e.runeRef)));
  return Object.entries(selection.carriedRunes || {})
    .filter(([ref]) => !assigned.has(String(ref)))
    .map(([runeRef, amount]) => ({ runeRef, amount })); // a reference is an identity, never a number
}

module.exports = {
  DUST_UNITS, selectCoins, assertNoRunesSpent, unassignedRunes,
  InsufficientFunds, InsufficientRune,
};
