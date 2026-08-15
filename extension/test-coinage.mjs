// Coin-age selection for fixed-price buys (MARKETPLACE-SPEC-v0 §2.1).
//
//   node extension/test-coinage.mjs
//
// Verge rule R1 rejects a transaction whose nTime is older than any coin it spends, so a listing
// variant signed at nTime T can only be funded by coins older than T. §2.1 says the order book
// serves the newest minable variant and "the wallet then spends only buyer coins older than that T".
//
// The wallet used to do the opposite: it announced its ENTIRE balance as `?coins=`, the server took
// the maximum of their times as a floor, and any single fresh coin then vetoed a variant that every
// other coin could have funded. Because ordinary sends are stamped at `now`, the change from a mint
// payment was exactly such a coin, so "mint a Verginal, then buy one" was impossible for days. The
// last test reproduces that scenario and pins the fix.

const store = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(k) { const key = typeof k === 'string' ? k : Object.keys(k)[0]; return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(o) { for (const k of Object.keys(o)) store.set(k, o[k]); },
    async remove(k) { store.delete(k); },
  } },
};

const { Wallet } = await import('./lib/wallet.js');
const { pickVariant, DEFAULT_SCHEDULE } = await import('./lib/swap.js');

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m, extra); } };

/** A raw tx whose only meaningful bytes are version + nTime (little-endian), where _txTime reads. */
const rawTxAt = (t) => '01000000'
  + [0, 8, 16, 24].map((s) => ((t >>> s) & 0xff).toString(16).padStart(2, '0')).join('')
  + '00';

/** An ElectrumX stub serving fixed nTimes, counting calls so we can see the cache work. */
function stubElectrum(timesByTxid) {
  return {
    calls: 0,
    async getTransaction(txid) {
      this.calls += 1;
      if (!(txid in timesByTxid)) throw new Error('unknown tx');
      return rawTxAt(timesByTxid[txid]);
    },
  };
}
const coin = (txid, value = 1_000_000) => ({ txid, vout: 0, value, inscription: null });

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000); // real clock: _spendTime's fallback compares against it

console.log('coin-age selection (spec §2.1)\n');

// --- the helper itself ---------------------------------------------------------------------------
{
  const el = stubElectrum({ old: NOW - 10 * DAY, mid: NOW - 3 * DAY, fresh: NOW - 60 });
  const w = new Wallet({ electrum: el });
  const coins = [coin('old'), coin('mid'), coin('fresh')];

  const T = NOW - 5 * DAY;
  const eligible = await w._coinsOlderThan(coins, T);
  ok(eligible.length === 1 && eligible[0].txid === 'old', 'keeps only coins at or below the variant nTime');

  const all = await w._coinsOlderThan(coins, NOW);
  ok(all.length === 3, 'a late enough variant can spend everything');

  const none = await w._coinsOlderThan(coins, NOW - 30 * DAY);
  ok(none.length === 0, 'a variant older than every coin selects nothing');
}

// --- an exactly-equal timestamp is legal (R1 is >=, not >) ---------------------------------------
{
  const w = new Wallet({ electrum: stubElectrum({ exact: NOW - DAY }) });
  const got = await w._coinsOlderThan([coin('exact')], NOW - DAY);
  ok(got.length === 1, 'a coin whose nTime equals the variant nTime is spendable');
}

// --- an unreadable coin is dropped, never assumed usable -----------------------------------------
{
  const w = new Wallet({ electrum: stubElectrum({ good: NOW - 5 * DAY }) });
  const got = await w._coinsOlderThan([coin('good'), coin('missing')], NOW);
  ok(got.length === 1 && got[0].txid === 'good', 'a coin whose time cannot be read is excluded');
}

// --- the cache ------------------------------------------------------------------------------------
{
  const el = stubElectrum({ a: NOW - DAY });
  const w = new Wallet({ electrum: el });
  await w._coinsOlderThan([coin('a'), coin('a'), coin('a')], NOW);
  await w._txTime('a');
  ok(el.calls === 1, `nTime is fetched once per txid (got ${el.calls} calls)`);
}

// --- THE REGRESSION: mint, then buy an aged listing ------------------------------------------------
{
  // A listing published 10 days ago, with the real schedule.
  const T0 = NOW - 10 * DAY;
  const listing = {
    carrier: { txid: 'c'.repeat(64), vout: 0, value: 100000 },
    priceUnits: 5_000_000, feeUnits: 0, feeAddress: null,
    sellerAddress: 'DSELLER', version: 1, locktime: 0,
    variants: DEFAULT_SCHEDULE.map((off) => ({ time: T0 + off, scriptSig: 'aa' })),
  };
  // The buyer holds a coin from three weeks ago, and the change from a mint they paid seconds ago.
  const el = stubElectrum({ aged: NOW - 21 * DAY, mintchange: NOW - 5 });
  const w = new Wallet({ electrum: el });
  const coins = [coin('aged', 20_000_000), coin('mintchange', 4_000_000)];

  // OLD behaviour: announce every coin, the newest becomes the floor.
  const oldFloor = Math.max(NOW - 21 * DAY, NOW - 5);
  ok(pickVariant(listing, { now: NOW, maxCoinTime: oldFloor }) === null,
    'OLD: the mint change vetoes the listing entirely');

  // NEW behaviour: the variant is chosen independently, then coins are filtered against it.
  const variant = pickVariant(listing, { now: NOW, maxCoinTime: 0 });
  ok(variant !== null, 'NEW: a variant is served regardless of our coins');
  ok(variant.time === T0 + 604800, 'NEW: it is the newest minable rung (7 d into a 10-day-old listing)');

  const eligible = await w._coinsOlderThan(coins, variant.time);
  ok(eligible.length === 1 && eligible[0].txid === 'aged', 'NEW: the aged coin funds it, the mint change is left alone');
  ok(eligible.every((u) => true) && eligible.reduce((s, u) => s + u.value, 0) >= listing.priceUnits,
    'NEW: the eligible coins still cover the price');

  // R1 must hold for every selected coin against the chosen variant.
  const times = await Promise.all(eligible.map((u) => w._txTime(u.txid)));
  ok(times.every((t) => t <= variant.time), 'NEW: every selected coin satisfies R1 for this variant');
}

// --- _spendTime: the R1 floor ----------------------------------------------------------------------
{
  const w = new Wallet({ electrum: stubElectrum({ a: NOW - 9 * DAY, b: NOW - 2 * DAY }) });
  ok((await w._spendTime([coin('a'), coin('b')])) === NOW - 2 * DAY, 'stamps at the newest input, the R1 floor');
  ok((await w._spendTime([])) >= NOW - 5, 'no inputs falls back to now');

  const w2 = new Wallet({ electrum: stubElectrum({ a: NOW - 9 * DAY }) });
  const t = await w2._spendTime([coin('a'), coin('unreadable')]);
  ok(t >= NOW - 5, 'an unreadable input falls back to now, always legal, optimisation forfeited');
}

// --- a send's change inherits the age of the coin that paid for it -----------------------------------
{
  const TXID = 'aa'.repeat(32);
  const AGE = NOW - 12 * DAY;
  const w = new Wallet({ electrum: stubElectrum({ [TXID]: AGE }) });
  await w.create('test passphrase for coin age');
  w.getUtxos = async () => [{ txid: TXID, vout: 0, value: 50_000_000, inscription: null, runes: {} }];

  const built = await w.send({ toAddress: 'DU8rvf7eHDwyvshWGJMqBduPRs1X6K652M', amount: 1_000_000, broadcast: false });
  const b = [...built.hex.slice(8, 16).matchAll(/../g)].map((m) => parseInt(m[0], 16));
  const stamped = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

  ok(stamped === AGE, `the send is stamped at its input's nTime, not now (got ${stamped}, want ${AGE})`);
  ok(NOW - stamped > 11 * DAY, 'so the change is born 12 days old rather than fresh');

  // And that change can immediately fund a listing variant it would otherwise have been locked out of.
  w._txTimes.set('change', Promise.resolve(stamped));
  const usable = await w._coinsOlderThan([coin('change')], NOW - 7 * DAY);
  ok(usable.length === 1, 'the inherited-age change can fund a 7-day-old variant right away');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
