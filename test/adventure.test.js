// The Adventure controller: ownership re-verified on chain, fertility read per request, and a
// commitment that cannot be resolved against different parents.
// Run: node test/adventure.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Adventure } = require('../src/adventure');
const L = require('../src/lifecycle');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('  ok - ' + name); }

async function atest(name, fn) { await fn(); passed += 1; console.log('  ok - ' + name); }

const { buildCollection } = require('./fixtures/collection');
const items = buildCollection();
const at = (i, t) => i.attributes.find((a) => a.trait_type === t).value;
const AF = items.find((i) => at(i, 'Ears') === 'Pink' && at(i, 'House') === 'Fire');
const AM = items.find((i) => at(i, 'Ears') === 'Grey' && at(i, 'House') === 'Water');

const DAY = L.DAY;
const T0 = 1_770_000_000 - (1_770_000_000 % DAY);
const ADDR = 'DPlayer';
const KEY_F = `${'a'.repeat(64)}:0`;
const KEY_M = `${'b'.repeat(64)}:0`;

function build(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verginals-adv-'));
  const world = {
    owner: { [KEY_F]: { address: ADDR, number: AF.number }, [KEY_M]: { address: ADDR, number: AM.number } },
    times: { [KEY_F]: { time: T0 - 5 * DAY, confirmations: 9 }, [KEY_M]: { time: T0 - 5 * DAY, confirmations: 9 } },
    t: T0,
  };
  const a = new Adventure({
    dataDir: dir,
    items,
    now: () => world.t,
    ownerOf: async (address, key) => {
      const o = world.owner[key];
      if (!o) return { error: 'that Verginal outpoint has been spent' };
      if (o.address !== address) return { error: 'you do not currently hold that Verginal' };
      return { number: o.number };
    },
    carrierTime: async (key) => world.times[key],
    holdingsOf: async (address) => Object.entries(world.owner)
      .filter(([, o]) => o.address === address)
      .map(([carrierKey, o]) => ({ number: o.number, carrierKey })),
    ...over,
  });
  return { a, world };
}
const MUM = { carrierKey: KEY_F };
const DAD = { carrierKey: KEY_M };

(async () => {
  // --- construction ------------------------------------------------------------------------------

  test('the controller refuses to start without its injected chain access', () => {
    assert.throws(() => new Adventure({ dataDir: '/tmp', items }), /ownerOf is required/);
  });

  // --- ownership is proved on chain, never read from our own state --------------------------------

  await atest('an Alpha the player no longer holds cannot be bred with', async () => {
    const { a, world } = build();
    world.owner[KEY_M].address = 'DSomeoneElse';
    const r = await a.preview(ADDR, MUM, DAD);
    assert.match(r.error, /do not currently hold/);
  });

  await atest('a spent carrier is refused', async () => {
    const { a, world } = build();
    delete world.owner[KEY_F];
    assert.match((await a.preview(ADDR, MUM, DAD)).error, /has been spent/);
  });

  await atest('a creature cannot breed with itself', async () => {
    const { a } = build();
    assert.match((await a.preview(ADDR, MUM, MUM)).error, /cannot breed with itself/);
  });

  await atest('a carrier the chain cannot answer for is an error, never a free pass', async () => {
    const { a, world } = build();
    world.times[KEY_M] = undefined;
    assert.match((await a.preview(ADDR, MUM, DAD)).error, /could not read that carrier/);
  });

  // --- the Alpha picker ----------------------------------------------------------------------------

  await atest('the breeding stock lists what the player holds, with sex and fertility in words', async () => {
    const { a } = build();
    const r = await a.alphas(ADDR);
    assert.strictEqual(r.alphas.length, 2);
    assert.strictEqual(r.females, 1);
    assert.strictEqual(r.males, 1);
    const mum = r.alphas.find((x) => x.sex === 'F');
    assert.strictEqual(mum.number, AF.number);
    assert.strictEqual(mum.carrierKey, KEY_F);
    assert.strictEqual(mum.label, 'Ready to breed');
    assert.ok(mum.traits.Body, 'the picker needs traits to draw the creature');
  });

  await atest('someone else Alphas are not listed as breeding stock', async () => {
    const { a, world } = build();
    world.owner[KEY_M].address = 'DSomeoneElse';
    const r = await a.alphas(ADDR);
    assert.strictEqual(r.alphas.length, 1);
    assert.strictEqual(r.males, 0);
  });

  await atest('fertile Alphas sort first, then the ones readiest soonest', async () => {
    const { a, world } = build();
    world.times[KEY_F] = { time: world.t - 3600, confirmations: 3 };      // ~47h to go
    world.times[KEY_M] = { time: world.t - 40 * 3600, confirmations: 3 }; // ~8h to go
    const r = await a.alphas(ADDR);
    assert.deepStrictEqual(r.alphas.map((x) => x.carrierKey), [KEY_M, KEY_F]);
    assert.ok(r.alphas.every((x) => !x.fertile));
  });

  await atest('an Alpha whose carrier the chain will not answer for is shown unusable, not hidden', async () => {
    const { a, world } = build();
    world.times[KEY_M] = undefined;
    const r = await a.alphas(ADDR);
    assert.strictEqual(r.alphas.length, 2, 'an Alpha the player can see in their wallet was dropped');
    const bad = r.alphas.find((x) => x.carrierKey === KEY_M);
    assert.strictEqual(bad.fertile, false);
    assert.match(bad.label, /unreadable/);
  });

  // --- fertility is read per request --------------------------------------------------------------

  await atest('the preview carries each Alpha fertility in words as well as numbers', async () => {
    const { a } = build();
    const pv = await a.preview(ADDR, MUM, DAD);
    assert.strictEqual(pv.ok, true);
    assert.strictEqual(pv.mother.fertility.fertile, true);
    assert.strictEqual(pv.mother.fertility.label, 'Ready to breed');
    assert.strictEqual(pv.viability, 1);
    assert.strictEqual(pv.relation, 'Unrelated');
  });

  await atest('a carrier that moved since the last request is resting on this one', async () => {
    const { a, world } = build();
    assert.strictEqual((await a.preview(ADDR, MUM, DAD)).ok, true);
    world.times[KEY_M] = { time: world.t - 3600, confirmations: 2 }; // it moved
    const pv = await a.preview(ADDR, MUM, DAD);
    assert.strictEqual(pv.ok, false);
    assert.strictEqual(pv.father.fertility.fertile, false);
    assert.match(pv.father.fertility.label, /^Resting/);
  });

  // --- commit and reveal ---------------------------------------------------------------------------

  await atest('a commitment cannot be resolved against a different pair', async () => {
    const { a, world } = build();
    const open = await a.openPairing(ADDR, MUM, DAD);
    assert.ok(open.serverSeedHash);
    // Swap the carrier under the commitment for a different Alpha.
    const other = items.find((i) => at(i, 'Ears') === 'Grey' && i.number !== AM.number);
    world.owner[KEY_M].number = other.number;
    const r = await a.resolvePairing(ADDR, open.pairingId);
    assert.match(r.error, /not the parents this pairing was committed to/);
  });

  await atest('selling an Alpha between commit and reveal voids the pairing', async () => {
    const { a, world } = build();
    const open = await a.openPairing(ADDR, MUM, DAD);
    world.owner[KEY_M].address = 'DBuyer';
    assert.match((await a.resolvePairing(ADDR, open.pairingId)).error, /do not currently hold/);
  });

  await atest('an unknown pairing id is refused', async () => {
    const { a } = build();
    assert.match((await a.resolvePairing(ADDR, 'pair_nope')).error, /unknown pairing/);
  });

  await atest('a resolved pairing yields a descendant with visible traits and a revealed seed', async () => {
    const { a } = build();
    let r = null;
    for (let i = 0; i < 20 && !(r && r.conceived); i++) {
      const open = await a.openPairing(ADDR, MUM, DAD);
      r = await a.resolvePairing(ADDR, open.pairingId);
    }
    assert.strictEqual(r.conceived, true, 'twenty unrelated pairings all failed to take');
    assert.strictEqual(r.generation, 1);
    assert.ok(r.seed && r.seed.length >= 32, 'the seed must be revealed so the player can recompute');
    for (const t of ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House', 'Ears']) assert.ok(r.traits[t]);
    assert.strictEqual(r.bornAt, T0 + 2 * DAY);
  });

  // --- raising and releasing -------------------------------------------------------------------------

  await atest('a descendant is raised, released, and then no longer in the stable', async () => {
    const { a, world } = build();
    let r = null;
    for (let i = 0; i < 20 && !(r && r.conceived); i++) {
      const open = await a.openPairing(ADDR, MUM, DAD);
      r = await a.resolvePairing(ADDR, open.pairingId);
    }
    assert.strictEqual(a.attend(ADDR, r.id, 'feed').error, 'gestating');
    world.t = r.bornAt;
    assert.strictEqual(a.attend(ADDR, r.id, 'feed').ok, true);
    assert.strictEqual(a.attend(ADDR, r.id, 'scold').error, 'unknown attention');
    assert.strictEqual(a.roster(ADDR).living.length, 1);
    assert.strictEqual(a.release(ADDR, r.id).ok, true);
    assert.strictEqual(a.roster(ADDR).living.length, 0);
    assert.strictEqual(a.attend(ADDR, r.id, 'feed').error, 'no such creature');
  });

  // --- fighting (§4.2, §4.4, §5.2) -------------------------------------------------------------------

  /** Breed one descendant and hand back its id, retrying seeds until a pairing takes. */
  async function aDescendant(a) {
    for (let i = 0; i < 20; i++) {
      const open = await a.openPairing(ADDR, MUM, DAD);
      const r = await a.resolvePairing(ADDR, open.pairingId);
      if (r.conceived) return r;
    }
    throw new Error('twenty unrelated pairings all failed to take');
  }
  // A stand-in Arena: records what it was handed, and lets the caller decide who won.
  const arena = (winner) => {
    const seen = [];
    const play = (fighter, loadout) => {
      seen.push({ fighter, loadout });
      return { winner: winner === 'player' ? ADDR : 'bot', score: [2, 1] };
    };
    return { play, seen };
  };
  const LOADOUT = { attacks: ['fire', 'water', 'earth'], poisonRound: 0, potionRound: 1, shieldRound: null };

  await atest('GENETICS NEVER BUYS A COIN FLIP: a descendant enters at the bot own score (§4.2)', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    const { play, seen } = arena('player');
    a.fight(ADDR, r.id, LOADOUT, play);
    // makeBot() gives the bot rarityScore 100. Equal scores mean the rarity nudge between them is
    // exactly zero, so a well-bred lineage cannot win more coin flips than a first litter.
    assert.strictEqual(seen[0].fighter.rarityScore, 100);
    assert.strictEqual(seen[0].fighter.address, ADDR);
    assert.strictEqual(seen[0].fighter.descendant, r.id);
    assert.ok(['fire', 'water', 'earth'].includes(seen[0].fighter.house), 'the fighter must carry its House');
  });

  await atest('a juvenile fights — that is how it learns and how it grows (§4.4, §5.2)', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    const before = a.roster(ADDR).living[0];
    assert.strictEqual(before.adult, false);
    const out = a.fight(ADDR, r.id, LOADOUT, arena('player').play);
    assert.strictEqual(out.won, true);
    assert.strictEqual(out.counted, true);
  });

  await atest('fighting is never refused; only the first three of the day feed growth (§5.2)', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    let counted = 0;
    for (let i = 0; i < 25; i++) {
      const out = a.fight(ADDR, r.id, LOADOUT, arena('bot').play);
      assert.ok(!out.error, `fight ${i} was refused: ${out.error}`);
      if (out.counted) counted += 1;
    }
    assert.strictEqual(counted, 3);
    assert.strictEqual(a.stable.state.players[ADDR].creatures[r.id].record.fights, 25);
  });

  await atest('the win record follows the match result', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    a.fight(ADDR, r.id, LOADOUT, arena('player').play);
    a.fight(ADDR, r.id, LOADOUT, arena('bot').play);
    const rec = a.stable.state.players[ADDR].creatures[r.id].record;
    assert.strictEqual(rec.fights, 2);
    assert.strictEqual(rec.wins, 1);
  });

  await atest('a descendant still gestating cannot fight', async () => {
    const { a } = build();
    const r = await aDescendant(a);
    assert.match(a.fight(ADDR, r.id, LOADOUT, arena('player').play).error, /not been born/);
  });

  await atest('a released descendant cannot fight, and an unknown id is refused', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    a.release(ADDR, r.id);
    assert.match(a.fight(ADDR, r.id, LOADOUT, arena('player').play).error, /no such creature/);
    assert.match(a.fight(ADDR, 'nope', LOADOUT, arena('player').play).error, /no such creature/);
  });

  await atest('an Arena that rejects the loadout surfaces its message, it does not throw', async () => {
    const { a, world } = build();
    const r = await aDescendant(a);
    world.t = r.bornAt;
    const out = a.fight(ADDR, r.id, LOADOUT, () => { throw new Error('loadout needs exactly 3 attacks'); });
    assert.strictEqual(out.error, 'loadout needs exactly 3 attacks');
    // A refused fight must not have consumed a counted slot.
    assert.strictEqual(a.stable.state.players[ADDR].creatures[r.id].record.fights, 0);
  });

  await atest('a descendant does not rest to breed, only Alphas do (§8)', async () => {
    const { a, world } = build();
    let r = null;
    for (let i = 0; i < 20 && !(r && r.conceived); i++) {
      const open = await a.openPairing(ADDR, MUM, DAD);
      r = await a.resolvePairing(ADDR, open.pairingId);
    }
    const p = await a.parent(ADDR, { id: r.id });
    assert.strictEqual(p.carrier, null, 'a descendant was given a carrier and would be gated on rest');
    assert.strictEqual(p.alpha, false);
  });

  console.log(`\n${passed} adventure tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
