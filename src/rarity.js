'use strict';
// Trait rarity for a fixed collection.
//
// Pure module: takes the full list of collection items (their on-chain traits are fixed at
// design time) and computes, for every trait value, how many items carry it and what share
// of the collection that is. Rarity is always computed against the ENTIRE collection, never
// the minted-so-far pool: percentages must not drift as the drop progresses, and early
// minters' rarity must not change under their feet. Because the mint order is committed in
// advance (see mint.js), publishing the full distribution gives away nothing exploitable.
//
// Score: classic statistical rarity. For each trait type an item scores supply/count of its
// value (rarer value = bigger contribution); the item's score is the sum over all trait
// types. Items missing a trait type entirely are counted under the implicit value "None",
// so HAVING a rare extra trait raises the score and LACKING a common one does too.

/**
 * @param {Array<{number:number, name?:string, attributes?:Array<{trait_type:string, value:*}>}>} items
 * @param {number} [supply] collection size (defaults to items.length)
 * @returns {{
 *   supply:number,
 *   traits:Array<{trait_type:string, values:Array<{value:string, count:number, pct:number}>}>,
 *   byNumber:Map<number,{number:number, name:string, score:number, rank:number,
 *     traits:Array<{trait_type:string, value:string, count:number, pct:number}>}>,
 *   leaderboard:Array<{number:number, name:string, score:number, rank:number}>
 * }}
 */
function computeRarity(items, supply) {
  const n = supply || items.length;
  if (!n) throw new Error('empty collection');

  // Pass 1: count every (trait_type, value) pair, tracking which types exist at all.
  const counts = new Map(); // trait_type -> Map(value -> count)
  const typeSeen = new Map(); // trait_type -> how many items carry the type
  for (const it of items) {
    for (const a of it.attributes || []) {
      if (!a || !a.trait_type) continue;
      const t = String(a.trait_type);
      const v = String(a.value);
      if (!counts.has(t)) counts.set(t, new Map());
      const m = counts.get(t);
      m.set(v, (m.get(v) || 0) + 1);
      typeSeen.set(t, (typeSeen.get(t) || 0) + 1);
    }
  }
  // Items lacking a type count as "None" for that type, so distributions always sum to supply.
  for (const [t, seen] of typeSeen) {
    const missing = n - seen;
    if (missing > 0) counts.get(t).set('None', (counts.get(t).get('None') || 0) + missing);
  }

  const pct = (c) => Math.round((c / n) * 10000) / 100; // two decimals, in percent

  const traits = [...counts.keys()].sort().map((t) => ({
    trait_type: t,
    values: [...counts.get(t).entries()]
      .sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([value, count]) => ({ value, count, pct: pct(count) })),
  }));

  // Pass 2: per-item score over the union of trait types.
  const allTypes = [...counts.keys()];
  const scored = items.map((it) => {
    const own = new Map((it.attributes || []).filter((a) => a && a.trait_type).map((a) => [String(a.trait_type), String(a.value)]));
    let score = 0;
    const itemTraits = [];
    for (const t of allTypes) {
      const v = own.has(t) ? own.get(t) : 'None';
      const count = counts.get(t).get(v) || 0;
      if (count > 0) score += n / count;
      if (own.has(t)) itemTraits.push({ trait_type: t, value: v, count, pct: pct(count) });
    }
    return {
      number: it.number,
      name: it.name || `#${it.number}`,
      score: Math.round(score * 100) / 100,
      traits: itemTraits,
    };
  });

  // Competition ranking: equal scores share the same rank.
  scored.sort((a, b) => b.score - a.score || a.number - b.number);
  let prevScore = null;
  let prevRank = 0;
  scored.forEach((s, i) => {
    s.rank = s.score === prevScore ? prevRank : i + 1;
    prevScore = s.score;
    prevRank = s.rank;
  });

  const byNumber = new Map(scored.map((s) => [s.number, s]));
  const leaderboard = scored.map(({ number, name, score, rank }) => ({ number, name, score, rank }));
  return { supply: n, traits, byNumber, leaderboard };
}

module.exports = { computeRarity };
