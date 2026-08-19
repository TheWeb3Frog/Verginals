# Adventure Mode v1 (working title: Second Form)

Supersedes `ADVENTURE-MODE-v0.md`, which is kept for the season model and the Arena work that is
still in production. This file is not a replacement for the owner's full design document
(`ADVENTURE_MODE_SPEC (1).md`, repo root): that document is the design, it is good, and its numbers
were checked against the real 3333 and hold. This file records only what was CHANGED, what was
DECIDED, and what running the thing revealed that reading it did not.

## 0. What was verified before anything was built

Every headline figure in the design document was recomputed from the collection.

| Claim | Doc | Recomputed |
|---|---|---|
| Allele pairs tested | 7 604 | 7 604 (the sum of n squared, self pairs included) |
| Co-dominant pairs, Body | 50.6 % | 50.6 % |
| Co-dominant pairs, Face | 75.5 % | 75.5 % |
| Co-dominant pairs, Background | 83.3 % | 83.3 % |
| Rainbow window, share of Face pool | 4.05 % | 4.05 % |
| Spectrum window, share of Background pool | 24.78 % | 24.78 % |
| P(random hybrid expresses Rainbow) | 0.011 % | 0.0109 % |
| P(Tuned collar) | 6.8 % | 6.69 % predicted, 6.78 % observed in the 3333 |

## 1. Rare grants a rule. The line is data, not taste

An allele that **can be masked** is an allele you have to breed for, and breeding for a bigger
number is not a project. So every hideable allele carries a rule, and only alleles that cannot hide
may be a flat modifier.

The set is read off the collection by `src/adventure/pool.js`, not chosen: 10 Faces (ranks 34-43),
13 Bodies (19-31), 3 Backgrounds (18-20). `test/adventure-content.test.js` fails the build if a
hideable allele carries a flat modifier, and that test was mutation tested against the original
table before it was trusted.

**Seven Faces were rewritten.** The design document states the principle and then breaks it in its
own largest table: Lover +3 HP a turn against In Love +8, Laughing +4 against Big Laughing +8,
Happy +2 against Super Happy +6, and so on. The rare ones that survived unchanged (the Glasses
tribe, Old TV, the Lasers, sessalG D3) are exactly the ones that were already rules.

Four more moved for a different reason. Grumpy and Grumpier are 98 and 84 copies; Cooler and Cool
are 91 and 77. They are peers, not tiers, and presenting them as an upgrade ladder claims a rarity
gap the data does not contain. They are now different rules of comparable weight.

**Bodies now price their rules.** The document budgets `HP + 4*Force + 9*Armor` and rates Harlequin
Monster the weakest body in the game at 114 while granting it uncapped Force growth, which over an
average five turn fight beats every stat line on the list. Rules carry a `worth`, the growth is
capped at +10 so the price is a fact, and Oreo drops from Armor 6 to 5. Range was 114-158; it is
now 134-149.

## 2. Initiative moved off Collar

The document gives initiative to the rarer Collar, and the initiative holder imposes their
Background for the whole fight. Collar is the flattest locus in the collection, 249 down to 195,
with no dominance at all, so this handed a permanent advantage to White on a rarity gap of 1.28x,
and it broke the rule in section 1 in the same stroke.

Initiative goes to the **Tuned** collar (colour matching the Rune), which already pays for itself:
Tuned charges in two turns instead of four, Mute takes +2 Armor instead. Ties fall to the lighter
cat, which makes Cow slow and Tiger fast without a word of explanation, then to the seeded flip.
Two alleles override the chain, one upward (Shiny Eyes Happy) and one downward (Cow's Placid).

## 3. Mutation

The document's `breed()` calls `mutate(locus)` without excluding the parents' alleles, so a
"mutation" can land on a value the parent already carried and be indistinguishable from ordinary
inheritance. `src/genetics.js` already excludes both parents and stays as it is.

## 4. Seasons are out. This had to be decided

`ADVENTURE-MODE-v0.md` runs 30 day seasons and kills every descendant at the end of each one; it is
implemented in `src/lifecycle.js` (`SEASON_DAYS = 30`, `seasonEnd`). The v1 document has no seasons
at all and needs lineages that survive a median of 83 days to reach a grail.

**Those are not reconcilable**, and the repo was holding both. Seasons are out of v1.

What seasons were protecting is covered without them:

- **Population** is bounded by the vivarium's carrying capacity, which the design already fixes at
  six Alphas on sixteen tiles.
- **Depth** is limited by Wright's coefficient, which `src/genetics.js` already computes properly by
  the kinship recursion. The only remedy for a closed line is unrelated blood.
- **The founder** therefore stays valuable forever, because it is the only guaranteed source of it.
  No new rule was needed for this; it falls out of the inbreeding model.

`lifecycle.js` seasons remain for the Arena and the v0 mode. v1 does not call them.

## 5. What running it revealed

None of these were visible by reading.

- **A fight could never end.** Damage has a floor of 1, several Faces and Bodies regenerate 3 a
  turn, and Oreo's layered reduction sits on top of its Armor. Found by running 200 random
  pairings. Fights now have a 20 turn horizon, roughly four times the median, and the healthier cat
  walks away.
- **The Glims died every cycle.** The equilibrium arithmetic assumes droppings convert to nitrate
  continuously, but conversion only happened at irrigation, and irrigation is a burst the player
  cannot trigger every three hours. Nitrate now seeps slowly through damp substrate; irrigation
  still delivers the rest at once.
- **Watering below the lip did nothing.** The lip is at 80 units and pouring more than 40 at once
  floods, so the obvious action did nothing twice and then the plants wilted. Damping the substrate
  and washing the droppings are now two separate effects of the same action.
- **A wilted plant kept its tile forever.**
- **The tutorial fight could be unwinnable.** The wild's House is set to the one the player beats,
  but House is fully co-dominant, so which of the pair it SHOWS is a seeded draw. Its id is
  re-salted until it wears the right House.
- **The bot ignored its own Flip telegraph.** Two bot turns could be scheduled at once, so the tell
  fired and a second call took the turn with a claw. In a three button game that is the worst
  available failure: it turns a read into a coin flip.

## 6. What is built

| Piece | File | State |
|---|---|---|
| Allele pool, windows, expression, Second Form | `src/adventure/pool.js` | done |
| 44 Faces | `src/adventure/faces.js` | done |
| 32 Bodies | `src/adventure/bodies.js` | done |
| 21 Backgrounds | `src/adventure/backgrounds.js` | done |
| 63 Runes as 9 families | `src/adventure/runes.js` | done |
| Combat, three buttons | `src/adventure/combat.js` | done |
| Vivarium, event queue | `src/adventure/vivarium.js` | done |
| Hunt, wild generation, Strands | `src/adventure/hunt.js` | done |
| Browser bundle | `tools/adventure/bundle.js` | done |
| The slice, minute 0 to 12 | `web/adventure*.js`, `/adventure` | done |
| Breeding, Vigor, inbreeding in the game loop | | designed, not built |
| Wounds, capture, biomes, rare species | | designed, not built |

Behind `VERGINALS_SECONDFORM=1`, its own flag: the page calls no endpoint and needs no collection
loaded, so it must not ride on the Arena's switch.

## 7. Art

The slice draws the **real collection sprites**: 157 webp layers under `sprites/`, through the
kit's own `TRAIT_LAYERS` and `LAYER_RECTS`. Layer order is Body, Ears, Collar, Face, Rune and is
not negotiable, because the collar's pendant plate is opaque and two faces in forty four hang past
it.

`web/adventure-creature.js` exists only because the scene is a canvas and the fight needs the
creature to breathe, flash on a hit, desaturate for a Flip and be swept through by a band of light.
Those are transforms over the same five images. `web/adventure-art.js` remains the DOM path and
neither should be reimplemented in the other.

## 8. Still open

1. **The title.** "Second Form" is a working title taken from the design's own second pillar. The
   design document's section 14 asks the same question.
2. **The save is not verifiable.** The design proposes localStorage and, in the same section, a
   public leaderboard of Double Rainbow births. A local save is editable in thirty seconds, so the
   only claim worth making in this game would be worthless. Everything is already seeded and
   deterministic, and `src/game.js` already does commit and reveal; breeding should be a committed
   seed the server signs, so a grail can be proved instead of announced.
3. **Playtest numbers**: capture pricing, bot tier thresholds, and whether 83 days to a grail
   survives contact with a fatigue point the design itself puts at days 10 to 14.
