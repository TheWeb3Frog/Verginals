# Art brief: the world around the cats

For the 26 pieces Second Form needs. The Alphas themselves are finished and are not touched by any
of this: 157 layers under `sprites/`, on chain, permanent. What is missing is everything they live
in and everything they eat.

---

## 1. The place

A **paludarium**. A sealed glass tank, half water and half land, standing in an unlit room and lit
only by its own lamp. Warm light from the upper left, everything outside the glass falling away
into a dark that is brown rather than black.

Inside it a small economy runs without anyone watching: plants put out greens, small round
herbivores eat the greens and leave droppings, water carries the droppings into the basin as
nitrogen, nitrogen feeds algae, algae feed fish. The cat is the only thing in the tank that can
break the cycle, and it does, by eating.

**The feeling to aim for is a tended thing, not a wilderness.** Somebody built this. It is closer
to a terrarium on a shelf than to a jungle. It should look like it would be quiet if you were in
the room, and like it would go on without you.

Three moments the art has to carry, because the game turns on them:

- **A dropping sitting on dry soil is inert.** It must look like waste, useless, slightly
  disappointing. Then water crosses it and it becomes the most valuable thing in the tank.
- **The basin turning green.** When the fish overpopulate they strip the algae, starve, and their
  bodies feed a bloom that starves the next generation. There is no popup and no sound for this.
  The water shifts green over three seconds and that is the entire notification.
- **A vivarium at the floor.** Two torpid herbivores, seeds waiting in the substrate. It must read
  as survivable, not as a ruin. A player who comes back to sterile dirt does not come back twice.

---

## 2. The technical contract

Measured from the existing sprites, not assumed.

| | |
|---|---|
| Logical grid | **16 real pixels per cell** |
| Body frame | 576 x 624 px = **36 x 39 cells** |
| Face frame | 560 x 560 px = 35 x 35 cells, offset x = 8 inside the body frame |
| Format | **webp, lossless, transparent background** |
| Ink | **`#131313`**, the darkest tone, used for every outline |
| Tones per element | **three**: base, shade, ink. Bengal is exactly `#3d3d3d`, `#272727`, `#131313` |
| Anti-aliasing | **none** on anything on the 16 px grid |

**The cats stay locked to that grid. The world does not have to be.**

That distinction matters and it is deliberate. The Alphas are the collection, they are on chain, and
they must render identically here and on the marketplace. Everything in this brief is scenery, and
scenery is allowed to breathe: softer edges, real light, depth, a gradient in the water. What it is
**not** allowed to do is change the palette or drop the ink outline, because the moment a cat stands
in front of it they have to look like they belong to the same world.

The rule of thumb: **if it can be picked up, eaten or killed, it holds the ink outline. If it is
behind everything, it can be painted.**

### The palette

Everything comes from `sprites/verginals-kit.js`. Do not introduce a hue that is not in this list.

```
ink      #0E0E13   coal   #17171E   panel  #1E1E28   slab   #2A2A36   edge  #3C3C4C
ash      #6E6F82   fog    #A9AAB8   bone   #E6E4DC   paper  #F7F5EE
fire     #E8452C   ember  #FF9A2E   fireDark #A62615
earth    #7FA83F   moss   #A8CC63   loam   #4A6B2A
water    #3E8FD0   foam   #86D3E8   deep   #245F94
gold     #FFC93C   goldLight #FFE9A3  goldDark #C4801A
toxic    #9BE04A   toxDark #4B7A1E
```

**Fire, water and earth are reserved.** Those three carry the combat triangle and nothing decorative
may use them at full saturation. A red plant would read as a Fire creature. Push scenery toward
loam, moss, deep and ash, and keep the saturated versions for things that matter.

---

## 3. The pieces

### 3.1 Nubbin, the herbivore. 96 x 96, three poses

The most-seen object in the game: a dozen on screen at once, hopping, eating, occasionally dying.

Round, no neck, two long upright ears, a body about as wide as it is tall. Bone (`#E6E4DC`) with a
`#B3A88F` shade so it reads against dark soil. One visible eye, a single ink dot, no mouth.

**Cute, but not a pet.** The player farms these and feeds them to cats. Give it enough life that a
starvation entry in the log lands, and not so much personality that anyone names one. Blank is
correct here. No eyelashes, no smile, no expression at all.

| Pose | What it does |
|---|---|
| `rest` | sitting, ears up, weight settled |
| `hop` | airborne, body stretched vertically, ears swept back |
| `eat` | head down to the ground, ears forward, back rounded |

Anchor: bottom centre, feet on the last row of pixels.

### 3.2 Glim, the fish. 96 x 64, two poses

Small, silver, and visibly fragile. It dies in three hours without food and its die-off is the best
thing the simulation produces, so it has to look like something that could go.

Pale silver `#C9CCDA` body, `#86D3E8` fin edges, one ink dot for the eye, a triangular tail. Thin.
A fat fish reads as healthy and this one is never far from trouble.

| Pose | What it does |
|---|---|
| `swim` | side on, tail swept left, body slightly curved |
| `turn` | three quarters toward the viewer, tail swept right |

Anchor: centre.

### 3.3 Plants. Four species, two stages each. 128 x 160

Stage one is a **sprout**: two leaves, nothing else, the same silhouette for all four species except
the colour. It should look like it has not decided what it is yet.

Stage two is the mature plant, and each is distinct at a glance from across the tank.

| Species | Mature reads as | Notes |
|---|---|---|
| **Clover** | low, spreading, three-lobed leaves, wide and short | cheap filler, it should look abundant and slightly weedy |
| **Carrot** | upright, feathery top, a wedge of `#E88A2C` breaking the soil line | the only one with anything below ground showing |
| **Duckweed** | flat discs floating on the water surface, no stem | **different anchor: this one sits on the waterline, not on soil** |
| **Catnip** | tall, silver-green, small pale flower heads | the most valuable plant in the tank. It should look slightly precious: a cooler green than the others, a little light on the flower heads |

Anchor: bottom centre at the soil line, except Duckweed which anchors at its own vertical centre.

### 3.4 Hunt node icons. Seven, 64 x 64

**These carry no text, ever.** The hunt map is a grid of these and nothing else, so each one has to
say what it is with no label and no legend.

| Icon | Reads as |
|---|---|
| `dew` | a single droplet |
| `pool` | three droplets, or a small still puddle with a rim |
| `spring` | water coming up, movement, the largest of the three |
| `seeds` | two or three seeds with a husk, warm brown, dry |
| `nubbin` | the Nubbin silhouette, ink only, no fill |
| `glim` | the Glim silhouette, ink only, no fill |
| `wild` | a seated cat silhouette, ink, **with two lit eyes** |

Dew, pool and spring are **one visual family at three sizes**: the player has to read "more water"
without being told which is which. The wild node is the only dangerous one on the map and its
danger has to come from the eyes, not from a skull, a spike or a red glow. Everything else on the
map is calm; that is what makes it work.

### 3.5 The vivarium backdrop. 1600 x 900, one piece

The single largest thing to draw and the one that sets the mood for the whole game.

A cross section of the tank, seen dead on from the side:

- **Lower third: the basin.** Water, dark at the bottom and lighter near the surface. The waterline
  is drawn separately by code, so leave the surface open.
- **Middle: the substrate.** Soil in `#4A3A26` and `#241A12`, with visible texture. A damp band
  along the top surface, because the game raises and lowers humidity and the top centimetre is where
  the player reads it.
- **Upper: air.** Empty. Plants and creatures are drawn on top of it in code, so anything busy up
  here fights them.
- **The glass.** Faint vertical highlights at the left and right edges, and a soft reflection band
  across the upper left. This is what says "sealed", and "sealed" is what makes the ecosystem feel
  like a closed system rather than a garden.
- **Beyond the glass**: a warm dark, `#17171E` to `#0E0E13`. Suggest a room, do not draw one.

One light source, upper left, warm. Nothing in this image may be at full saturation.

### 3.6 Resource icons. Five, 48 x 48

They appear in the log and the HUD and have to survive being shown at 24 px.

| Icon | Reads as |
|---|---|
| `greens` | a small pile of leaf, moss green |
| `dropping` | a dark pellet. Dull, matte, unappealing. It is the least attractive thing in the game until water touches it |
| `nitrate` | a mote of light in the water, pale gold, dissolving |
| `algae` | a soft green cluster, `#9BE04A` |
| `roe` | a small cluster of translucent eggs, pale with a darker centre in each |

`dropping` and `nitrate` are the same substance before and after irrigation, and they should look
like it: same silhouette, one dull and one lit. That relationship is the entire nutrient loop in two
icons and it is worth the time.

---

## 4. What is not needed

So nothing gets built twice.

- **Cats.** All 157 layers exist. Do not redraw them, do not draw new bodies, faces, collars, ears
  or runes.
- **Combat arenas.** They are painted in code from the Background allele.
- **UI chrome.** Buttons, bars and panels are CSS.
- **Animation frames.** Breathing, hopping, hit flashes, the Flip sweep and the irrigation wave are
  all transforms applied in code. Deliver still poses; the game moves them.

---

## 5. Delivery

Drop the files straight in, no renaming needed:

```
sprites/world/nubbin-rest.webp      sprites/world/nubbin-hop.webp     sprites/world/nubbin-eat.webp
sprites/world/glim-swim.webp        sprites/world/glim-turn.webp
sprites/world/plant-clover-sprout.webp   sprites/world/plant-clover-mature.webp
sprites/world/plant-carrot-sprout.webp   sprites/world/plant-carrot-mature.webp
sprites/world/plant-duckweed-sprout.webp sprites/world/plant-duckweed-mature.webp
sprites/world/plant-catnip-sprout.webp   sprites/world/plant-catnip-mature.webp
sprites/world/node-dew.webp         sprites/world/node-pool.webp      sprites/world/node-spring.webp
sprites/world/node-seeds.webp       sprites/world/node-nubbin.webp    sprites/world/node-glim.webp
sprites/world/node-wild.webp
sprites/world/vivarium-back.webp
sprites/world/res-greens.webp       sprites/world/res-dropping.webp   sprites/world/res-nitrate.webp
sprites/world/res-algae.webp        sprites/world/res-roe.webp
```

**26 files.** Every one has a drawn placeholder in the game already, so they can arrive one at a
time and each replaces its stand-in the moment it lands. Nothing has to wait for the set.
