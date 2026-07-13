# Verginals Arena — Phase 1 spec (v0)

An elemental duelling game for Verginals holders. Ported from the existing Runekoz/Wardinals
game (Bitcoin Ordinals), rebuilt on the Verge stack. Non-custodial by construction: the game
never holds player funds, entry is free, and the only reward is a champion trophy that the
project (treasury) inscribes to the winner.

Status: design. No code yet. This document is the contract we build Phase 1 against.

---

## 0. Scope and non-goals

**In (Phase 1)**
- Free play: 1v1 duels (fun + badges) and a demo-vs-bot mode.
- Free tournaments with brackets, badges, and a champion trophy inscription.
- A season leaderboard (ELO-style) with soft resets per season.
- House Wars: every duel also scores for the player's House (Fire / Water / Earth).
- Traits influence combat (small, transparent, on-chain-derivable modifiers).
- Provably-fair randomness (no hidden server dice).
- Anti-cheat: server-authoritative resolution, wallet-signed identity, ownership checks.
- Shareable deterministic battle replays via a compact link.

**Out (later phases)**
- Any XVG stake / wagered duel. Stays off until a French lawyer signs it off.
- Asset duel (winner takes the loser's Verginal). Designed later on the swap primitive.
- The PixiJS/WebGL visual glow-up (Phase 2 — the renderer is swappable, see §11).
- A real XVG prize pool funded by marketplace fees (only after fees exist and legal is clear).

**Legal framing.** Free entry means no *mise* (stake). No stake + chance + prize = a
promotional contest, not gambling. The trophy has no guaranteed cash value and is paid for by
the project, not pooled from players. We keep it that way in Phase 1.

---

## 1. What we reuse vs rebuild

The live Runekoz app is on the same VPS at `/var/www/runekoz` (Node + Express + better-sqlite3,
frontend SPA + Canvas). We have full access.

**Reuse (reskin for Verge)**
- `public/app.js` (SPA state machine) and `public/animation.js` (Canvas cinematics + Web Audio),
  `styles.css`, sounds. Swap Runekoz sprites for Verginals renders, palette to Verge colours.
- The DB shape: `seasons`, `players`, `matches_1v1`, `streaks_1v1`, `tournaments`,
  `tournament_participants`, `tournament_matches`, `badges`, `player_badges`, `game_config`,
  `day_results`. The badge catalogue (`BADGE_DEFS`: first_blood, duel_master, veteran,
  relentless, tournament_debut, top_32…finalist, champion, runner_up) ports as-is.
- The combat rules from `battleEngine.js` / `simulate-tournament.js` (elemental RPS + poison/potion).

**Rebuild for Verge (do NOT port the Bitcoin backend)**
- The whole server: our own zero-dependency `http` server, not Express. New module `src/game.js`
  (pure logic + DB) wired into `src/server.js` behind `/api/game/*`.
- Auth: replace UniSat + BIP322 with **our wallet** (`window.verge`) challenge-response (§3).
- Randomness: replace every `Math.random()` with the provably-fair source (§5).
- Prize: **drop `season.js` entirely** (custodial `SEASON_WALLET_WIF`, server-signed payouts,
  Runes/UniSat). Replace with the trophy-inscription pipeline (§9), funded by the treasury.
- Drop the `claims` / `designs` custodial tables; keep only what Phase 1 needs.

---

## 2. Identity and ownership

A player is a Verge address (the connected wallet account). To enter a duel or tournament with a
given Verginal, the player must **own that Verginal at entry time**.

- Ownership check: the server resolves the Verginal's current carrier UTXO (same
  `inscriptionLocationMap` / `gettxout` path the marketplace uses) and confirms the controlling
  address equals the player's address. No trust in a client claim.
- One live entry per Verginal per tournament (prevents entering the same NFT twice).

---

## 3. Wallet auth (replaces UniSat / BIP322)

Challenge-response with the extension, reusing the signing the wallet already exposes.

1. `GET /api/game/challenge?address=<addr>` → server returns a nonce
   `verginals-arena:<addr>:<nonce>:<expiry>` and stores it (short TTL).
2. Wallet signs the exact challenge string (`window.verge` message-sign path).
3. Client sends `{ address, nonce, signature }` to `POST /api/game/session`. Server verifies the
   signature against the address, checks the nonce is live and unused, and issues a short-lived
   session token (HMAC over `address|issued|expiry` with a server secret in the systemd env).
4. All mutating `/api/game/*` calls carry the token; the server re-derives the address from it.

No password, no key ever leaves the device. Signing is only ever over our own challenge strings,
never a transaction (§ security rules: we never ask the user to sign anything surprising).

---

## 4. Combat engine v2 (`src/game.js`)

Ports the Runekoz rules, then adds skill + trait influence. Combat is a **pure function**:
`resolve(matchState, moves, seed) -> result`. Deterministic: same inputs always give the same
outcome. This is what makes anti-cheat, replays, and provably-fair all work.

- Base rules (from `battleEngine.js`): 3 rounds, Fire beats Earth beats Water beats Fire; poison
  is a damage-over-time badge; potion is an antidote/heal. Round winner scored; best of 3.
- **Real choices** (new): each round the player picks their element (and optionally spends a
  limited poison/potion charge), instead of the current all-random resolution. Skill = reading the
  opponent + managing charges.
- **Trait modifiers** (option #1, §6): small deterministic edges derived from the Verginal.
- **Randomness** only enters for genuine ties, and comes from the beacon `seed`, never
  `Math.random()`.

Server is authoritative: it validates each submitted move (legal element, charge available, within
time), then resolves. Clients render the result; they never decide it.

---

## 5. Provably-fair randomness

Two regimes, each matched to its latency needs.

**A. 1v1 duels — commit-reveal seed pair (instant, no chain wait).**
1. At match start the server generates `serverSeed`, sends the player `serverSeedHash =
   SHA256(serverSeed)` and the `matchId`. (Commitment: the server is now bound to that seed.)
2. The player's client contributes a `clientSeed` (random, sent with the first move).
3. Moves are locked (each move optionally hash-committed then revealed to stop last-look).
4. Final `seed = SHA256(serverSeed || clientSeed || matchId)`. Any tie in `resolve()` consumes it.
5. After the match the server reveals `serverSeed`; the client verifies
   `SHA256(serverSeed) == serverSeedHash` and can recompute the whole outcome. The server could
   not have biased the result without breaking the hash commitment.

**B. Tournament rounds — Verge block-hash beacon (maximally trustless, scheduled).**
Tournament rounds resolve on a schedule (cron), so we can afford to wait for a block.
1. When a round is scheduled, the server publicly commits: "this round is seeded by the hash of
   Verge block height `H`" where `H` is a small margin above the current tip (announced before `H`
   exists, so unpredictable).
2. Once block `H` is mined, `beacon = blockhash(H)`. Every match seed in that round is
   `SHA256(beacon || tournamentId || matchId)`.
3. Anyone can verify: the block hash is public on-chain, the derivation is fixed. Neither the
   server nor a player can have known or steered it. No server seed to trust at all.

---

## 6. Traits → combat (option #1)

The point: **which Verginal you own matters in a fight**, feeding demand into the marketplace,
while skill still decides most games. Rules are public and derived from the same trait data the
rarity engine already exposes (`src/rarity.js`), so they are verifiable, not a black box.

Design constraints: modifiers are **small** (a fight is mostly player choice), fully deterministic
from the inscription, and never create an unbeatable NFT.

Initial barème (tunable in `game_config`, starts conservative):
- **HOUSE** = elemental affinity. Winning a round with your House's element gives a small edge on
  ties in that round (e.g. House Fire wins fire-vs-fire tiebreaks). No raw damage bonus.
- **RUNE trait** = one special charge per match themed on the rune (e.g. a one-time re-roll, or a
  guaranteed non-loss on a chosen round). Rarer runes get the more useful charge.
- **FACE "Crying"** (and a few flavour faces) = a comeback buff: if you lose round 1, you get a
  tie-break edge in round 3. Pure flavour → mechanic.
- **Rarity score** = a tiny tiebreak nudge only (the last coin-flip leans slightly to the rarer
  Verginal), never a round win on its own.

Balance is a `game_config` row so we can retune without redeploying. If Phase 1 launch wants "pure
skill" first, we ship with all modifiers set to zero and turn them on once tuned — same code path.

---

## 7. Anti-cheat

- **Server-authoritative**: clients submit moves, the server resolves. No outcome is trusted from
  the client. The deterministic engine means the server recomputes everything.
- **Signed identity** (§3): every action is tied to a wallet signature; no anonymous spoofing of
  another player.
- **Ownership-gated entry** (§2): you can only fight with a Verginal you actually hold.
- **Unpredictable seed** (§5): a client cannot pick moves knowing the tiebreak, and the server
  cannot bias it after the fact (hash commitment / on-chain beacon).
- **Move commit-reveal** stops "last look" (seeing the opponent's move before choosing).
- **Rate limits** reuse the server's `allowQuote`-style limiter; per-address caps on matches/min.
- **Idempotent resolution**: a match resolves once; replays of the same request return the stored
  result, never re-roll.

---

## 8. Data model (Verge side, `data/game.db` via better-sqlite3)

Adapt the Runekoz schema; drop custodial tables. Keys are Verge addresses, not BTC wallets.

- `seasons(id, name, started_at, ends_at, status)`
- `players(season_id, address, elo, wins, losses, matches, house, best_streak, updated_at)` —
  `house` cached from the player's chosen Verginal.
- `matches_1v1(id, season_id, p1_address, p2_address, p1_verginal, p2_verginal, moves_json,
  server_seed_hash, server_seed, client_seed, winner_address, status, created_at)`
- `streaks_1v1(address, current, best, updated_at)`
- `tournaments(id, name, status, size, seed_block_height, created_at, started_at, ended_at,
  champion_address, trophy_inscription_id)`
- `tournament_participants(tournament_id, address, verginal, house, seed, eliminated_round)`
- `tournament_matches(id, tournament_id, round, p1_address, p2_address, moves_json, seed,
  winner_address, status)`
- `house_scores(season_id, house, points, wins)` — House Wars aggregation (§ option #2).
- `badges(badge_key, name, description, icon, category)` + `player_badges(address, badge_key,
  earned_at, tournament_id)` — ported catalogue.
- `game_config(key, value)` — trait barème, season length, tournament sizes, feature flags.
- `replays(id, kind, payload, created_at)` — optional cache for shareable replay links (§10).

`matches_1v1.moves_json` + seeds are enough to fully reconstruct any fight (needed for replays and
audits).

---

## 9. Champion trophy (non-custodial reward)

No pooled funds, no player money. When a tournament ends, **the project treasury pays to inscribe a
unique trophy and sends it straight to the champion's address.** The winner receives an asset; they
never claim from a pot the server holds.

- Reuse the existing inscription pipeline (the same `buildPlan` / reveal path the mint and the
  promo funding use — the promo already lets the server *pay for* an inscription delivered to a
  user's address; the trophy is that mechanism, generalised).
- **Trophy artwork** is generated server-side: the champion's Verginal + a crown + season number +
  tournament name, composed into an image (the Runekoz repo already has a Python sprite compositor
  we can adapt). The metadata records season, tournament, date, and the champion's Verginal id.
- The trophy is a normal Verge inscription, so it is **automatically tradeable on the marketplace
  we just built**. Season champions form a growing mini-collection with real floor value.
- Flow: tournament final resolves → server queues a trophy job → treasury-funded inscribe to the
  winner → `tournaments.trophy_inscription_id` set → champion badge awarded → UI shows the trophy.
- The treasury key stays server-side ONLY to pay for the *project's own* outgoing inscription
  (like promo). It never touches, holds, or moves player funds. This is not custody of user assets.

Runner-up and round badges (`player_badges`) are DB-only (no inscription) in Phase 1; we can
promote finalists to a cheaper inscribed medal later if we want.

---

## 10. Shareable replays (option #4)

A fight is fully determined by `(moves_json, seeds)`. Encode that into a compact, URL-safe blob:
`/arena/replay/<blob>` re-runs the deterministic engine client-side and plays the cinematic. No
server round-trip needed to watch. Great for X: "watch this final". Optionally back it with the
`replays` table for short ids instead of long blobs.

---

## 11. Rendering and the Phase 2 glow-up

Phase 1 ships the **existing Canvas renderer**, reskinned for Verginals, plus a cheap "juice" pass
(hit-stop, screen shake, easing, anticipation/follow-through, damage pops). Because the battle is
deterministic **data**, the renderer is a pure consumer of it — so Phase 2 can swap Canvas for a
**PixiJS/WebGL** VFX layer (particles, elemental shaders, 60fps) and add procedural sprite
animation **without touching game logic, seeds, or anti-cheat**. Optional premium: signature
special-move effects tied to rare RUNE traits (loops back to §6).

---

## 12. Endpoints (all under `/api/game/`, wired into `src/server.js`)

- `GET  /challenge?address=` → nonce (auth §3)
- `POST /session` → `{address,nonce,signature}` → session token
- `GET  /me` → player profile, elo, badges, streak (token)
- `POST /duel/start` → `{verginal}` → matchId + serverSeedHash (ownership-checked)
- `POST /duel/move` → `{matchId, round, element, useCharge?, commit?/reveal?}` 
- `GET  /duel/:id` → state / result (includes serverSeed once revealed)
- `GET  /leaderboard?season=` → ELO ladder
- `GET  /houses?season=` → House Wars standings
- `GET  /tournaments` / `POST /tournament/join` `{verginal}` / `GET /tournament/:id`
- `GET  /replay/:blob` (or POST to mint a short id)
- Admin/cron (SSH or token, never public HTTP mutation): open/close season, create tournament,
  resolve round (pulls the beacon block), queue trophy inscription.

---

## 13. Build milestones

1. `src/game.js`: DB schema + pure combat engine (ported rules + traits + seed), unit-tested
   hermetically (no chain, no wallet) — same style as `rarity.js` / `swap.js` tests.
2. Auth (§3) + ownership (§2) wired into `src/server.js`.
3. 1v1 duel loop end-to-end with commit-reveal seed (§5A) + badges + ELO + streaks.
4. House Wars aggregation (§ option #2) on top of duel results.
5. Tournaments: bracket generation, cron round resolution with block-hash beacon (§5B),
   tournament badges.
6. Trophy pipeline (§9): generated artwork + treasury-funded inscribe to the champion.
7. Frontend reskin: port `app.js` + `animation.js`, wire to `/api/game/*`, Verge palette, a new
   "Arena" tab on the site, juice pass.
8. Replays (§10).

Phase 2 (separate): PixiJS/WebGL renderer + procedural animation + trait-signature effects.
