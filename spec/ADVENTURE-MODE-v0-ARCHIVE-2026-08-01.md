# Verginals Adventure Mode: breeding, genetics and living lineages

Design notes, not yet implemented. Inspiration: **Creatures 2 / 3** (Norns): real genetics, learning,
mortality, a world that lives without you. The goal is to capture that magic while avoiding the trap
that killed every 2021 breeding game.

Status: design only. Nothing here is built. See `GAME-SPEC-v0.md` for the Arena that already ships.

---

## 0. The diagnosis

Breeding games of 2021 (Axie and its clones) did not die because of breeding. They died because
**the offspring were themselves NFTs**: every birth minted a permanent, tradeable asset with no
removal mechanism. Supply rose forever against flat demand, so price collapsed. It was arithmetic,
not bad luck.

The whole design follows from one rule:

> **What reproduces must not be what is sold.**

---

## 1. Core structure: the Alpha is a bloodline, not a creature

| Layer | What it is | Supply |
|---|---|---|
| **Alpha Verginal** | the founding ancestor, the bloodline, the tradeable asset | **3333, fixed forever** |
| **Vergling** | a living descendant: born, trained, ages, retires. **Never an NFT** | capped by slots, ~13k max |

A Vergling is bound to its founding Alpha and cannot be traded on its own. Selling the Alpha
transfers the whole lineage and its recorded legacy with it.

**The inversion that makes it work:** achievements are engraved onto the Alpha's permanent record, so
breeding makes existing Alphas *more* valuable instead of diluting them. That is the exact opposite
of the Axie dynamic.

---

## 2. Genetics

### 2.1 Sex is already in the collection

The **Ears** trait is the sex chromosome, and the artist already balanced it:

| Ears | Sex | Count | Share |
|---|---|---|---|
| Pink | female | 1671 | 50.1% |
| Grey | male | 1662 | 49.9% |

A near-perfect 50/50 breeding pool exists on day one, with no retrofitting needed. This is also why
Ears are excluded from the colour-combo rarity maths in `src/combos.js`: they were never a colour
trait, they are sex.

### 2.2 Gene roles per slot

Each slot is a gene with two alleles, one from each parent.

| Slot | Role | Inheritance |
|---|---|---|
| **Ears** | **sex determination** | see 2.1; drives who can breed with whom |
| **House** | elemental gene | strict dominance; drives the Arena's fire/earth/water cycle |
| **Body** | major, **codominant** | two alleles can blend, which is how bicolour Harlequins arise |
| **Background** | major, independent | free segregation |
| **Face** | ability gene | carries combat effects (the round-3 comeback) |
| **Collar** | minor | transmits easily; fine-tunes combos |
| **Rune** | **recessive** | hides for generations, then resurfaces. The breeder's treasure |

Mutation rate: ~2% per slot. Rare enough that a mutation is a Discord event, common enough that the
gene pool never freezes.

### 2.3 Sex-linked coats (optional, scientifically authentic)

In real cats, tortoiseshell and calico coats are X-linked, so they are almost always female; males
occur at roughly 1 in 3000 (XXY) and are typically **sterile**.

The collection currently has these coats on both sexes: **207 female, 189 male**. Two options:

- **Ignore it**, keep the art as-is.
- **Turn it into lore**: the 189 male torties/calicos become the celebrated XXY rarities, beautiful
  but **sterile**. That creates a genuine tension (you own something gorgeous that cannot breed) and
  is 100% faithful to feline genetics.

### 2.4 Breeding targets are already defined

The existing combo badges become the breeding objectives, at no extra design cost:

| Target | Difficulty | Why it is a real puzzle |
|---|---|---|
| Camouflage | easy | align Body and Background |
| Chromatic | medium | 3 slots on one colour |
| **Monochrome** | hard | stack neutral alleles everywhere |
| **Prismatic** | very hard | lock 4 slots to one hue |
| **Double Rainbow** | near impossible | Spectrum plus a rainbow face; only 3 exist in 3333 |

### 2.5 Verifiable births

Child genome = deterministic function of (genome A, genome B, committed seed), reusing the same
commit-reveal already used for the mint order and for `resolveMatch()`. Anyone can recompute a birth
and prove it was not tampered with.

### 2.6 The hidden dominance table

Do **not** publish the dominance rules. Publish only their hash, so players know the rules cannot be
changed after the fact but must be **discovered experimentally**. Creatures fans reverse-engineered
the Norn genome and it fed that community for twenty years. Expect community spreadsheets, competing
theories and a wiki. It is a free, self-sustaining engagement engine.

---

## 3. Inbreeding: the anti-whale mechanism

One operator currently holds ~565 Alphas across ~612 wallets (46% of minted supply). In a normal
game they would dominate breeding outright.

Biology disarms them. Implement Wright's coefficient of inbreeding. Breeding related creatures causes
**inbreeding depression**:

- deleterious recessives get expressed (weakness traits)
- combat vigour drops
- fertility falls

And the mirror: **hybrid vigour**, a bonus for crossing genetically distant lineages.

**Consequence:** a closed stable degenerates generation after generation. Staying competitive
*requires* outcrossing with other players' lineages. The whale cannot play in autarky and must
negotiate with the community. The hermit loses; the connected player wins.

---

## 4. The stud system: an economy with zero new supply

Offer your Alpha as a sire for a XVG fee. The other player breeds and takes the offspring; you keep
your Alpha and collect the fee.

- **Passive income for good genetics.** Discovering you carry a rare recessive is discovering a business.
- **A role for non-fighters**: the breeder/geneticist archetype earns without entering the Arena.
- **No NFT is created.** Access to genes is rented, not an asset.
- A cut of every stud fee flows to the tournament prize pool.

Combined with inbreeding, this forces circulation: the whale must pay smaller players for fresh
blood, so value flows back down.

---

## 5. Temperament: the Creatures biochemistry, and the link to the Arena

Four inherited temperament axes, expressed as continuous values, driving the **autonomous** combat AI:

| Axis | Effect in combat |
|---|---|
| Aggression | strikes early vs waits |
| Caution | uses potion/shield early vs absorbs |
| Adaptability | changes strategy after a loss vs persists |
| Focus | consistency vs brilliance-and-blunders |

This is the missing link between breeding and the Arena: two Verglings with identical traits but
different temperament do not fight alike.

It also creates a real trade-off: chase a beautiful Monochrome, *or* a killer temperament. **The
rarest is not automatically the strongest**. Essential, or everyone converges on one combo and the
meta dies.

---

## 6. Autonomous combat and the Hand

**Autonomous fighting.** Once trained, a Vergling fights the ladder on its own, in the style you
taught it. You are a breeder and a mentor, not a button-masher. The game runs while you sleep: no
daily chore, no burnout, no punishment for going on holiday.

**The Hand.** In Creatures you were a disembodied hand that could slap or tickle, and the Norn learned
by association. Here: after each autonomous match you review the replay (the engine already
reconstructs a whole fight from `(moves, seed)`) and approve or correct key decisions. Your feedback
adjusts its learned weights, so each lineage converges to a recognisable style.

This is reinforcement learning turned into gameplay, which is exactly what Creatures did in 1998.

---

## 7. The living world

**Seasons.** The environment favours different traits over time: a Winter favours neutrals (Monochrome
shines), a Prismatic Festival favours saturated colours. Effects:

- the meta rotates, so **no trait is ever permanently useless**
- all 3333 Alphas stay relevant
- each season creates buying demand for a trait profile -> marketplace volume -> 2% fees -> bigger prizes
- it hands marketing a built-in content calendar

**Plagues.** Creatures 3 had a real immune system. A seasonal epidemic sweeps the world and resistance
is genetic. A genetically uniform stable gets wiped out, so **diversity becomes insurance**. It is
true in biology, true here, and it punishes large uniform breeders hardest. It also produces
community legends: "the Great Plague of Season 3 erased 60% of the fire lineages".

**Feral Verglings.** An ownerless population breeding on its own. Anyone, even without an Alpha, can
tame one. Weak genetics, but it is a **free entry point**: the player gets attached, learns the game,
then wants a real bloodline and **buys an Alpha**. That is the acquisition funnel, and it feeds the
marketplace.

---

## 8. Economy

Nothing is ever emitted. No game token, no inflation. Rewards come only from the **2% marketplace fee**
plus stud/breeding fees: pure redistribution of real volume, structurally capped by actual activity.

```
Breeding costs XVG  ──►  feeds the prize pool
       ▲                        │
       └── breeders want to win ◄┘  richer tournaments
```

Breeders literally fund the competitions they want to win. Self-regulating: if interest falls,
breeding falls, so prizes fall too. No spiral.

### Tuning: the scarce resource is litters, not money

| Parameter | Suggested | Why |
|---|---|---|
| Litters per Alpha per season | **2** | hard cap, cannot be bought |
| Living Verglings per Alpha | **4** | bounds total population near 13k |
| Cooldown after a litter | 7 days | paces the game |
| Breeding cost | rising: 5 then 15 XVG | anti-spam, not a barrier |
| Stud fee share to prize pool | 10% | funds tournaments |
| 1/1 immortalisations | **4 per year** | the valve Axie left wide open |

With 2 litters per Alpha per season, **money cannot buy more breeding**. Only owning Alphas can, and
there will never be more than 3333.

---

## 9. Mortality and legacy

Verglings do not "die", they **become Ancestors**. Same supply effect, without the rage-quit.

On retirement:
- the record is engraved permanently into the Alpha's lineage
- the genome enters the **Codex of Ancestors** (public, prestigious)
- a living slot frees up

Retirement comes from **age only, never from neglect**.

---

## 10. Immortalisation and the 1/1 collection

An exceptional Vergling (rare genetics **plus** an Arena record) can be **immortalised**: inscribed
for real on-chain as a 1/1 in the companion collection.

This is the only path by which breeding creates an NFT, and it must stay extremely rare: a seasonal
championship prize, hard-capped (about 4 per year), never a routine outcome.

---

## 11. Narrative hooks

- **Codex of Ancestors**: every lineage has a public family tree. Prestige becomes visible and shareable.
- **Registry of Origins**: the 3333 Alphas are forever **Generation Zero**. No Vergling can ever be.
- **Named lineages**: after N documented generations you earn the right to name your line.
- **The Obituary**: great retired Verglings keep a page. Season 1's champion is still visitable years later.

---

## 12. Explicitly rejected

- **No real-time needs** (hunger, sleep). The charm of Creatures, but also the guilt that made people quit.
- **No death by neglect.**
- **No trading of Verglings.** The moment offspring become tradeable, Axie is recreated. The stud
  system provides all the economy needed without that risk.
- **No directly inherited combat stats.** Only traits and temperament are inherited, or lineages become
  mathematically superior and the game closes to newcomers.

---

## 13. Suggested phasing

| Phase | Content | Effort |
|---|---|---|
| **1. Genetics only** | breed two Alphas, inheritance + mutation, no combat | low: the rarity engine already does the work |
| **2. Verglings in the Arena** | descendants fight, per-lineage Elo | low: the engine already reads traits |
| **3. Life cycle** | ageing, Ancestors, Codex, slots | medium |
| **4. Living world** | seasons, ferals, autonomous combat | high |

Phase 1 is playable quickly and tells you whether the community bites before investing in the rest.

---

## 14. Why the existing engine is already half-ready

`src/game.js` `resolveMatch()` is a deterministic function of (fighters, moves, seed, config) and
already reads traits: House drives the elemental cycle, Face grants the comeback, rarity score nudges
the final coin flip. It already has Elo, houses and seed commit-reveal.

**A bred creature with inherited traits would fight in the Arena with no engine change.**

---

## The spine

```
3333 Alphas (fixed, eternal)
        │
        ├── limited litters ──► Verglings (mortal, never NFTs)
        │                              │
        │                    temperament + learning
        │                              │
        │                         Arena (already live)
        │                              │
        │                     prizes ◄── 2% marketplace + stud fees
        │                              │
        └────── legacy engraved ◄──────┘
              (the Alpha gains value)
```

Every arrow points back at the fixed-supply asset. That is the precise definition of the opposite of
a play-to-earn.
