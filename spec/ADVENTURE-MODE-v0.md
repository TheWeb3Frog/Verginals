# Verginals Adventure Mode: breeding, mortality and seasons

Rewritten 2026-08-01. The previous version is kept verbatim in
`ADVENTURE-MODE-v0-ARCHIVE-2026-08-01.md`; its genetics and temperament work is still good and much
of it survives here. What changed is the economy and the life cycle.

## 0. The two decisions that shape everything else

**There is no game token, and nothing is ever emitted.** Tournament prizes are XVG and 1/1
inscriptions, funded by the founder. Not a pool players pay into, not a coin whose price has to be
defended, not an emission schedule. This is a budget line, and it can be raised, lowered or stopped
without breaking a promise to anyone.

Two things follow, and both are worth more than they look:

- **No player ever pays for the rewards they win.** No stake, no entry fee, no pot. So this is a
  free-entry contest funded by its organiser, not a game of chance.
- **The design stays free.** Every play-to-earn froze because rebalancing destroyed someone's
  financial position. Nobody holds a position in this game's state, so any rule can be changed the
  day it stops being fun.

**Descendants are mortal; Alphas are not.** A season lasts one month and ends with every descendant
dying. This is what makes the stakes real, and it is also what keeps the population bounded without
a single artificial cap.

---

## 1. The season

| | |
|---|---|
| Season length | **1 month** |
| Generation | **~4-5 days** (2 gestation + maturation, §5.3) → about 6-7 per season |
| At season end | every descendant dies; Alphas are untouched |
| Carried into the next season | Alphas, DNA Orbs, the Hall of Fame |

**Only an Alpha can start a lineage.** Within a season descendants breed freely with each other
(that is where the depth lives) but a new season always begins from Generation Zero.

This is what protects the collection. An Alpha is not a one-time key: it is the only permanent
breeding stock, required again every single month. Two Alphas means two starting lines and two
chances. Owning more is a permanent, recurring advantage that no amount of play can substitute for.

The shape is a roguelike: you lose the run, you keep the meta-progression.

### 1.1 Fertility is rest, and the chain measures it

**An Alpha can breed only if its carrier UTXO has not moved for two days.**

Verge's R1 consensus rule stamps every transaction with an `nTime` bounded by the coins it spends, so
a UTXO's age is carried by the chain itself rather than reconstructed from a height proof. Fertility
is therefore not server state: it is a fact anyone can check, including a player who does not trust
our indexer.

**Breeding spends the Alpha's carrier**, moving it to a fresh output. That is deliberate, and it is
what makes the rule pay for itself: the act of breeding resets the rest, so each Alpha carries a
natural two-day recovery with no cooldown table anywhere. The Alpha goes to stud, its coin moves, and
it is available again two days later.

Consequences worth knowing before this ships:

- Selling an Alpha resets its rest, so a buyer waits two days. At two days this is flavour rather
  than friction: the animal settles in.
- A brand new player buys an Alpha and cannot breed immediately. This one **did** hurt, so it now
  has an exemption: see §1.1b.
- Shuffling Alphas between wallets costs fertility every time. That was never the point, but it is a
  pleasant side effect.

### 1.1b The first three pairings are instant

A new player with two Alphas hits the two-day rest, then the two-day gestation, and has nothing to
look at for four days. That is not anticipation, it is a wall, and it was measured on a real player
rather than guessed: the game had not started yet, so there was nothing for the waiting to build.

**The first three pairings of a player skip both waits.** No rest gate, and the descendant is born
the moment it is conceived. Everything after birth is untouched: it arrives as a juvenile with no
growth, no attentions and no temperament, so what is skipped is the waiting, never the raising.

Three rather than one, because one descendant cannot be bred, has nothing to be compared against,
and shows none of the variation the genetics exist for. Three is a litter you can read.

The waiver is spent when a pairing **opens**, not when it takes, so opening several at once cannot
multiply it. That does charge a player for a pairing that fails its viability roll, which is
acceptable: the opening pairings are Alpha with Alpha and unrelated parents roll 1.0.

The rest is still computed and still shown during the opening. A screen that pretended the rule did
not exist and then began enforcing it without warning on the fourth pairing would be worse than the
wait it removed.

### 1.2 Why six generations is the right number

A serious genetic project (a Monochrome, say) needs the same recessive to converge across every
slot. Six or seven generations gets you closer and does not get you there.

That is deliberate, and it is what gives the DNA Orb its job: a season is not long enough to finish
anything ambitious, so the only way to pursue one is to win the right to carry it forward.

It also makes each pairing matter. With fifteen you experiment; with six you think.

---

## 2. The DNA Orb

The Orb is **not a trophy. It is the save file for your breeding work**: the right to clone one
fighter and carry its genome into the next season.

It is the only thing besides an Alpha that crosses a season boundary, which is what makes it the
most desirable object in the game while being worth nothing in money.

So the motivation loop is not "compete to earn". It is **compete so you don't lose your lineage**.

### 2.1 Two ladders, because there are two ways to play

Orbs are awarded to the **top 10% of each ladder**, a percentage rather than a fixed number, so a
small community still has winners and it scales on its own if the game grows.

| Ladder | Measures | Who it is for |
|---|---|---|
| **Combat** | Arena record over the season | the fighter |
| **Genetics** | rarity of what you bred, scored by `combos.js` | the breeder |

Without the second ladder, a player who breeds something extraordinary but cannot fight loses a
month of work. The breeder archetype is real, it existed in the previous draft, and it costs almost
nothing to keep: the genetics score is the rarity engine that already runs in production.

---

## 3. Genetics

### 3.1 Sex is already in the collection

Ear colour is sex: **pink is female, grey is male**. It was there before the game was designed.

### 3.2 Alleles, dominance, mutation

Every trait slot carries a pair of alleles, one from each parent. Dominance decides which is
expressed; the recessive is carried invisibly and can surface generations later.

**Mutation** is the only source of new material: rare, and it produces a value present in neither
parent. Rare enough that it should be an event people talk about.

### 3.3 The two grails need opposite strategies

This falls straight out of the existing rarity engine, and it is the best thing in the design.

**Monochrome is a recessive convergence.** For a slot to show a recessive colour it must come from
both parents; for a creature to be monochrome that convergence must happen on *every* slot at once.
That is why there are nine in 1,264. Chasing one means accumulating invisible carriers over many
generations, crossing, and hoping, which is exactly what real breeders chasing a recessive coat do.

**Double Rainbow is the opposite: maximum divergence.** You must avoid convergence everywhere.

A player cannot pursue both with the same stock. That is real strategic depth, and it required
writing no new rules.

### 3.4 Inbreeding, and why depth limits itself

Implement Wright's coefficient. A closed stable converges genetically and expresses its deleterious
recessives: vigour drops, fertility falls. The remedy is never to stop, it is to bring in unrelated
blood from another player.

Surface it as **one number, before the pairing is confirmed**: *"Shared grandparent. Offspring
viability −18%."* A single percentage is legible at a glance and turns an abstract coefficient into a
decision the player can actually weigh. Whatever the model computes underneath, this is what it must
be reduced to at the moment of choice.

The interaction is the elegant part: **chasing a Monochrome requires convergence, and convergence is
what causes inbreeding.** The hunt for the rarest trait manufactures its own difficulty, with no rule
imposing it. The closer you get, the more fragile your line becomes, and the more you need a carrier
someone else owns.

So the community becomes the resource without anyone being forced to socialise. A large holder cannot
breed in autarky either, but that is a side effect and not the point: at current volumes the
concentration of Alphas is not a real problem. Inbreeding earns its place as **game design**: it is
what makes depth cost something and what makes other players worth talking to.

**Nothing else limits generational depth.** No decay per generation, no tax on breeding deep. Either
would punish the exact behaviour the game is about. Depth is paced by gestation time and by living
slots, and regulated by biology.

---

## 4. Combat

### 4.1 Tournaments: three moves, committed blind

Both players choose their three moves in advance, then everything is revealed and resolved.

This is not a degraded turn-based fight, it is a different genre. You do not read your opponent in
real time. You **model** them, from their past fights, their creature's genetics and their habits.
That metagame layer does not exist in real time. Frozen Synapse is built entirely on this and is
well regarded for it.

It also solves three problems at once: it works across time zones, it never needs two players online
simultaneously (essential for a small global community) and it **is already the architecture**.
`game.js` commits and reveals a seed for provable fairness; committed moves slot into the same
mechanism, and anyone can re-run `resolveMatch()` afterwards to verify nothing was altered.

### 4.2 The rule that keeps it deep

**Genetics shifts the payoff matrix. It never adds raw power.**

A creature is not stronger, it is better at certain choices: a poison that lingers, a slower potion, an
earth attack that only half-loses to water, an ability that unlocks in round three.

Three consequences, all load-bearing:

- the game stays about reads rather than stats
- old lineages never become mathematically superior, so it does not close to newcomers
- **breeding changes how you play, not how much you win**, which is the trap every breeding game
  falls into

### 4.3 Not Pokémon

Explicitly avoided: an eighteen-entry type chart, HP attrition, a team of six, switching, catching.
Those are the signature.

What this is instead: one creature, one fight, three simultaneous reads, on a three-element cycle
plus poison and potion. Short, sharp, and shareable as a link.

### 4.4 Bot mode: turn by turn

Fought interactively against an AI, and its job is not consolation: **it is where you learn your own
creature.** You have just bred a descendant and you do not yet know what it can do.

The two modes feed each other: the bot teaches you the tool, the tournament asks you to use it blind.

### 4.5 Types

One principle governs the whole table, and breaking it breaks the game:

> **Rarity buys strangeness, not strength.**

A plain creature is never weak. The rare types trade simplicity for specialisation: they change the
*rules of the exchange* rather than adding damage. This is §4.2 applied to types, and it is what keeps
a three-year-old bloodline from being mathematically superior to a newcomer's first litter.

**Layer one: element.** Everyone has exactly one, from House. Fire burns Earth, Earth buries Water,
Water douses Fire. Always relevant, learnable in ten seconds.

**Layer two: trait type.** Most creatures have none, and that is fine.

| Type | Source | What it changes |
|---|---|---|
| **Prism** | Double Rainbow, 3 exist | **Has no element at all.** The cycle does not apply to it, in either direction |
| **Void** | Monochrome, 9 exist | **Zero variance**: it does exactly what you committed, every time. And it is the only thing that can pin a Prism: against Prism, the elemental cycle applies again |
| **Toxic** | Harlequin and poison traits | Its hits **resolve one round late** |
| **Veil** | Camouflage, 186 exist | Its committed move **stays hidden on reveal** for one round |

Why each of these is interesting rather than strong:

**Prism** is legendary without being powerful. It deletes a whole layer of the game: your elemental
read is worthless against it, and it has no elemental advantage of its own either. Fighting one feels
alien, and that is the point. Three exist, and they should feel like an event.

**Void** is the kingslayer. Monochrome is one colour everywhere (purity, focus) and zero variance is
the exact expression of that: in a game with a seeded coin flip, a creature that never rolls badly is
distinctive without hitting harder. It is devastating for a good planner and useless for someone who
reads their opponent wrong. And it gives the legendary exactly one predator, which is what stops
Prism from warping the meta.

**Toxic** rewards thinking a round ahead: commit the poison now, collect next round. In a
three-round blind fight that is a genuinely different rhythm. Its weakness is built in: if the fight
resolves early, the setup never pays.

**Veil** is information denial, which in a pre-committed game is the perfect common-tier power. With
186 of them it is the accessible special, so most players get to feel like they have something.

**Stacking:** one trait type per creature, rarest wins. Readability beats expressiveness here.

**Left open:** Duotone, Chromatic, Perfect Pair, Tailored and Prismatic have no type. They may become
small passives, or nothing at all. Seven things to learn is already the ceiling, so resist inventing
eight more.

---

## 5. Raising a juvenile

A descendant is born juvenile and cannot breed. It matures through **attention**, and the whole
system rests on one rule:

> **Absence never subtracts. Presence adds.**

Creatures punished you: the creature *needed* you, suffered without you, and that guilt is what made
people stop playing. Here a juvenile grows on its own, slowly. Looking after it makes it grow
**faster** and decides **what it becomes**. You never repair a deficit, you only build an advantage.

### 5.1 Attentions

A juvenile can absorb **three attentions per day**. Which three is the interesting part:

| Attention | Effect |
|---|---|
| **Spar** | general experience |
| **Drill** | develops one specific latent ability |
| **Feed** | growth, faster |
| **Play** | biases how temperament expresses |

Each one matures the juvenile, and each one steers it somewhere different. You never have enough
attentions to do everything, so **you are deciding what this creature becomes**, not filling a bar.

This is what makes two identical genomes produce two different individuals, and therefore what makes
a DNA Orb worth having. The Orb preserves the bloodline; the individual has to be raised again, and
it can turn out differently.

### 5.2 Fight as much as you like, only the first few count

Thirty bot fights an evening is fine, and encouraged: it is how you learn a new creature before
committing three blind moves in a tournament.

**Three count toward growth per day.** That is what stops maturation from collapsing into two minutes
of clicking, without ever capping the fun to protect the pacing.

### 5.3 Rhythm

```
growth        6 points, at most 3 per day
maturation    2 days at full attention, longer if you are around less
gestation     2 days
generation    ~4-5 days
season        ~6-7 generations
```

Six or seven generations makes a season a project where every pairing counts, rather than a race. It
also makes the DNA Orb genuinely necessary for any serious genetic goal, which is exactly what gives
winning its meaning.

**Watch when playing:** three attentions per creature across a whole litter may get tedious. It may
want to be a per-player budget rather than per-creature, or a batch action. Tune it with a controller
in hand.

---

## 6. Living slots

A player can keep only a limited number of descendants alive at once (tuning: start around 6). Going
deep therefore means choosing what not to keep.

This is a decision, not a penalty, and it is the kind of decision that creates attachment.

---

## 7. Death, the Hall of Fame and Paradise

Descendants die **of age, at season end, all together**. Never from neglect, never from a lost fight,
never from failing to log in.

Every fighter that ever lived keeps a permanent page: its genome, its lineage, its record. Nothing is
deleted, ever, and the record lives **on chain**, not in a database, so it survives this project.

### 7.1 What gets inscribed

Inscribing every fighter individually would be affordable (a small inscription costs well under a
cent) but it would put hundreds of near-identical records a month on a chain that is not ours. Two
tiers instead:

| | What | Cost |
|---|---|---|
| **Season roster** | one inscription per player per season: every fighter that lived, with genome, lineage and record | 1 per player per month |
| **Champions** | Orb winners get their own individual inscription | a handful per season |

Same permanence, roughly fifty times less data, and an individual inscription becomes a mark of
distinction rather than the default. "My season 3 stable" is also a better object than fifty
scattered entries.

**Paradise** is the cheap part with the highest emotional return: the dead remain visitable, and they
have a line of dialogue drawn from their temperament. Without it, wiping a player's entire stable
once a month is brutal enough to make them leave. With it, the season's end is a farewell rather than
a deletion.

---

## 7bis. What a simulated season actually produces

Measured 2026-08-06 against the real engine (`src/genetics.js`, `src/lifecycle.js`,
`src/fertility.js`) over a full 30-day season, with viability rolled as a real success chance
rather than treated as advice. A generation is 3 days: 2 gestation + adulthood on the third day at
full attention.

| Alphas held | How the player breeds | Pairings | Failed | Descendants | Deepest generation |
|---|---|---|---|---|---|
| 1 pair | avoids fragile pairings | 30 | 0 | 6 | **1** |
| 1 pair | accepts any pairing | 30 | 18 (60%) | 12 | 6 |
| **2 unrelated pairs** | avoids fragile pairings | 40 | 4 (10%) | 26 | **7** |
| 3-4 pairs | avoids fragile pairings | 30 | 7 | 23 | 6 |

Two things this settles:

**§3.4 is correctly calibrated.** Careful breeding with unrelated blood beats inbreeding on both
axes at once: more depth *and* twice the descendants. Forcing a single line is not a shortcut, it
is a worse strategy that also feels bad. Nothing needs tuning.

**§1.2's "six or seven generations" is conditional, and the condition is not season length.** It is
having roughly four unrelated Alphas to draw on. Every descendant of one Alpha pair is a full
sibling, so F = 0.25 at generation 2 and viability sits at the floor. A player with a single pair
who breeds sensibly stops at generation 1.

That is §3.4 working exactly as designed, *"the remedy is never to stop, it is to bring in
unrelated blood from another player"*, but it must be said out loud in the UI. A new player who
hits this wall with no explanation will read it as the game being broken, not as an invitation.

---

## 8. Open, not decided

**What a season's ranking actually measures** (win rate, a proper Elo, or points) and how a player
who joins mid-season is treated.

**Who pays for the roster inscription.** It is a few tenths of a XVG in network fees, not revenue for
anyone, but somebody's wallet has to sign it.

**Whether a descendant also needs rest to breed**, or only Alphas. Applying it to descendants too
would slow within-season depth considerably: fifteen generations assumes back-to-back breeding.
Probably Alphas only, but it should be a conscious choice rather than an oversight.

---

## 9. Explicitly rejected

- **No game token, no emission, no player-funded pool.**
- **No real-time needs** (hunger, sleep, daily login). The charm of Creatures, and also the guilt
  that made people quit.
- **No death by neglect, and no death from losing a fight.**
- **No inherited combat stats.** Traits and temperament are inherited; raw power is not, or lineages
  become mathematically superior and the game closes.
- **No trading of descendants.** They live one month. There is nothing to trade.

---

## 10. Phasing

| Phase | Content | Why this order |
|---|---|---|
| **1** | breed two Alphas → a descendant with inherited traits, fought in the Arena, mortal at season end | the smallest complete loop; `combos.js` and `game.js` already do most of it |
| **2** | descendants breed with each other, inbreeding, mutation | this is where the game becomes a game |
| **3** | seasons, ladders, DNA Orbs, Hall of Fame | needs phase 2 to have anything worth saving |
| **4** | Paradise, temperament-driven flavour, narrative | pure warmth, no mechanics |

Phase 1 is playable quickly and tells you whether anyone bites before the rest is worth building.

---

## 11. What already exists

`src/game.js` `resolveMatch()` is a deterministic function of (fighters, moves, seed, config), reads
traits already, and commits and reveals its seed. `src/combos.js` is the rarity engine and therefore
the genetics fitness landscape. `src/tournament.js` runs brackets. `src/trophy.js` inscribes champion
artwork.

The Adventure Mode adds rules to these. It does not add systems.
