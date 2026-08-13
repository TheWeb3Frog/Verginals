# Verge Assets: implementation plan

Companion to `ASSETS-SPEC-v0.md`. Tracks what is built, what is next, and what blocks a mainnet
launch.

---

## Where we are

| Phase | Component | Status | Tests |
|---|---|---|---|
| 1 | Protocol spec | **done** | `spec/ASSETS-SPEC-v0.md` |
| 1 | OP_RETURN codec (`src/assets/codec.js`) | **done** | 15 |
| 1 | State machine (`src/assets/indexer.js`) | **done** | 17 |
| 1 | Merkle checkpoints (`src/assets/checkpoint.js`) | **done** | 12 |
| 2 | Chain scanner + etch discovery (`src/assets/scanner.js`) | **done** | 11 |
| 2 | Transaction builders (`src/assets/builder.js`) | **done** | 14 |
| 2 | Asset-aware coin selection (`src/assets/coinselect.js`) | **done** | 13 |
| 3 | Regtest end-to-end, full lifecycle | **done** | 38 checks on chain |
| 4 | Mainnet launch | not started | |

Phase 1 is the part where correctness actually lives: the protocol is a pure function from
transactions to state, and that function is now fully specified and tested. Everything that follows
is plumbing around it.

### What phase 1 deliberately proves

- every wire message survives a round trip, and hostile input is **ignored rather than fatal**;
- a wallet that knows nothing about the protocol **cannot destroy a balance** by making a plain send;
- mint terms, supply caps and allowlists are enforced exactly as specified;
- indexing is **deterministic**, which is the precondition for checkpoints meaning anything;
- a light client can **verify its own balance** against a published root, and detect a lying indexer.

---

## Phase 2: connecting to the chain

Three pieces, none of which touch the protocol rules.

**2.1 Scanner.** Walk blocks, turn each transaction into the shape `applyTx` expects: inputs with
their previous scriptPubKey, outputs with values and any OP_RETURN payload, plus an `etching` when
the transaction carries an asset inscription. Reuses the existing `src/indexer.js` block reader.

**2.2 Builders.** Compose the transactions: `etch` (inscription + funding, reusing the existing
inscription pipeline), `mint` (one OP_RETURN, one recipient output), `transfer` (edicts plus
recipient outputs), `checkpoint` (one OP_RETURN). Each must respect the dust minimum on any output
carrying a balance.

**2.3 Wallet.** Asset-aware coin selection: never spend an asset-carrying UTXO to pay a fee. This is
the one genuinely delicate part, and it is exactly the bug class that has burned Ordinals users.
The wallet already has inscription-aware selection for the same reason, so the logic extends rather
than starts from scratch.

---

## Phase 3: end-to-end testing

**The public Verge testnet is unusable.** Per the project handoff: faucets are dead and self-mining
is impossible because blocks must be P2PK-signed. That path is closed and no amount of work here
reopens it.

**Regtest is available and is a better environment anyway.** Verified on the node binary: `-regtest`
is supported and `generatetoaddress` exists ("Mine blocks immediately"). Blocks are mined on demand,
coins are free, and the chain resets whenever we want.

Plan:

1. A regtest node in its **own datadir and its own ports**, so it cannot touch the production node
   or its data. It syncs nothing, so it stays small.
2. Mine a handful of blocks to a throwaway address to get spendable coins.
3. Etch an asset, mint it, transfer it, publish a checkpoint, all as real broadcast transactions.
4. Run the scanner over the resulting blocks and assert the reconstructed state matches what the
   pure state machine predicted from the same transactions.

That last step is the real prize: it proves the pure core and the chain plumbing agree.

**Open decision, needs the owner's call.** The only machine with a Verge binary is the production VPS
(1 vCPU, ~1 GB RAM free, currently serving a live mint). A regtest node is small and idle, but it is
still a second daemon on a box that is already tight. Options:

- **A.** Run it on the VPS with an isolated datadir and non-default ports, started only for the test
  run and stopped afterwards. Lowest effort, small but non-zero risk to production.
- **B.** Build a Verge binary locally (macOS) and keep regtest entirely off the production machine.
  Zero risk to production, more setup.
- **C.** A separate cheap VPS for protocol work. Cleanest, costs money.

Recommendation: **B if the build is straightforward, otherwise A**, run at a quiet hour and stopped
immediately after.

---

## Phase 4: mainnet

Preconditions, all of which must hold before a single mainnet transaction:

- phase 3 green end to end;
- a second, independently written indexer agreeing on the same checkpoint roots (the whole point of
  §8 is undermined if only one implementation exists);
- the ticker schedule fixed and the Verge payout address confirmed by the Verge maintainers, since both are permanent once the first asset is etched;
- a public statement of what the protocol does **not** do (spec §10), so nobody builds on a promise
  the chain cannot keep.

The genesis etching should be deliberately unremarkable: a test asset with a tiny supply, so the
first real ticker is not spent on a shakedown run.

---

## Risks

| Risk | Mitigation |
|---|---|
| A wallet spends an asset UTXO as fee change | asset-aware coin selection (2.3), the same guard inscriptions already need |
| Two indexers diverge silently | checkpoints make divergence public and attributable (§8) |
| Ticker squatting | priced allocation split 50/50 project and Verge, no unlock calendar to camp (§7) |
| A taker steals a partial asset sale | a listing sells the whole carrier, so a missing edict costs the maker nothing (§9.1); the attack itself is asserted in test/assets-swap.test.js |
| A malformed message burns someone's balance | already handled: unknown messages fall through to the default assignment, and it is tested |
| The 83-byte ceiling is hit by a real use case | etchings carry the rich data; only the hot path is constrained |
| Nobody adopts it | the protocol is useless without a second implementation and a wallet; treat those as launch requirements, not follow-ups |
