'use strict';
// Verge Assets: asset-aware coin selection (ASSETS-PLAN §2.3).
//
// This is the file that decides whether users lose money.
//
// On Bitcoin, the recurring way people have destroyed inscriptions and tokens is boringly simple: a
// wallet picks utxos by value to pay a fee, happens to grab the one carrying the asset, and the
// asset is spent into the miner's pocket. It is not an exotic attack, it is ordinary coin selection
// meeting an asset-bearing utxo. So the rule here is absolute:
//
//   A utxo carrying an asset is NEVER selected for its value. It is selected only when the
//   transaction is deliberately moving the asset it carries, and never otherwise.
//
// When clean funds are short, this module FAILS rather than reaching for an asset utxo. A failed
// transaction is an inconvenience; a burnt asset is permanent.

const DUST_UNITS = 100000; // 0.1 XVG

const carries = (u) => !!(u.assets && Object.keys(u.assets).length > 0);
const amountOf = (u, ref) => (u.assets && u.assets[ref]) || 0;

class InsufficientFunds extends Error {
  constructor(needed, available) {
    super(`insufficient spendable funds: need ${needed} units, only ${available} available in utxos that carry no asset`);
    this.name = 'InsufficientFunds';
    this.needed = needed;
    this.available = available;
  }
}

class InsufficientAsset extends Error {
  constructor(assetRef, needed, available) {
    super(`insufficient balance for asset ${assetRef}: need ${needed}, hold ${available}`);
    this.name = 'InsufficientAsset';
    this.assetRef = assetRef;
    this.needed = needed;
    this.available = available;
  }
}

/**
 * Choose inputs for a transaction.
 *
 * @param {Object} p
 * @param {Array}  p.utxos        [{ txid, vout, value, assets?: { [assetRef]: amount } }]
 * @param {number} p.targetValue  units the outputs will consume
 * @param {number} p.fee          units for the miner
 * @param {Array}  [p.requiredAssets] [{ assetRef, amount }] amount 0 means "every unit held"
 * @param {number} [p.dustUnits]
 * @returns {{ inputs, inputValue, changeValue, gathered, carriedAssets }}
 *
 * `carriedAssets` reports every asset the chosen inputs hold, including ones that were not asked
 * for: they came along on a utxo we needed, and the caller MUST assign them to an output or the
 * default assignment will move them somewhere unintended.
 */
function selectCoins({ utxos, targetValue = 0, fee = 0, requiredAssets = [], dustUnits = DUST_UNITS }) {
  if (!Array.isArray(utxos)) throw new Error('utxos must be an array');
  const chosen = [];
  const used = new Set();
  const key = (u) => `${u.txid}:${u.vout}`;

  // 1) Gather the assets the transaction actually needs, largest holding first so the fewest inputs
  //    are touched. These are the ONLY asset-bearing utxos that may be spent.
  const gathered = {};
  for (const req of requiredAssets) {
    // A utxo already chosen for another asset may well carry this one too, so count what is already
    // in hand before looking for more. Skipping this made a utxo holding two required assets fail on
    // the second one.
    let got = chosen.reduce((s, u) => s + amountOf(u, req.assetRef), 0);
    const spare = utxos
      .filter((u) => amountOf(u, req.assetRef) > 0 && !used.has(key(u)))
      .sort((a, b) => amountOf(b, req.assetRef) - amountOf(a, req.assetRef));
    const held = got + spare.reduce((s, u) => s + amountOf(u, req.assetRef), 0);
    const need = req.amount === 0 ? held : req.amount;
    if (need <= 0 || held < need) throw new InsufficientAsset(req.assetRef, need, held);

    for (const u of spare) {
      if (got >= need) break;
      chosen.push(u);
      used.add(key(u));
      got += amountOf(u, req.assetRef);
    }
    gathered[req.assetRef] = got;
  }

  // 2) Top up with CLEAN utxos only. An asset-bearing utxo is never considered here, whatever its
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

  // 3) Report every asset riding on the chosen inputs, asked for or not.
  const carriedAssets = {};
  for (const u of chosen) {
    for (const [ref, amt] of Object.entries(u.assets || {})) {
      carriedAssets[ref] = (carriedAssets[ref] || 0) + amt;
    }
  }

  const change = inputValue - needed;
  return {
    inputs: chosen,
    inputValue,
    // Change below dust is left to the miner rather than creating an unspendable output.
    changeValue: change >= dustUnits ? change : 0,
    gathered,
    carriedAssets,
  };
}

/**
 * Safety net for a plain XVG payment: assert that nothing in this selection carries an asset.
 * Call it on every ordinary send. It is one line, and it is the line that would have saved a lot of
 * Ordinals users.
 */
function assertNoAssetsSpent(selection) {
  const refs = Object.keys(selection.carriedAssets || {});
  if (refs.length > 0) {
    throw new Error(`refusing to spend asset-carrying inputs in a plain payment (assets: ${refs.join(', ')})`);
  }
  return selection;
}

/**
 * Every asset on the inputs must be assigned to some output, or the default assignment will sweep it
 * to the first eligible output, which is rarely what the sender meant. Returns the assets that are
 * unaccounted for, so a wallet can add a self-send edict before signing.
 */
function unassignedAssets(selection, edicts) {
  const assigned = new Set((edicts || []).map((e) => String(e.assetRef)));
  return Object.entries(selection.carriedAssets || {})
    .filter(([ref]) => !assigned.has(String(ref)))
    .map(([assetRef, amount]) => ({ assetRef: Number(assetRef), amount }));
}

module.exports = {
  DUST_UNITS, selectCoins, assertNoAssetsSpent, unassignedAssets,
  InsufficientFunds, InsufficientAsset,
};
