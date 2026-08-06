# Primitives that only Verge can afford

Design space, not a specification. **Nothing here is part of ASSETS-SPEC-v0**, and v0 should ship
without any of it: Runes is minimal on purpose, that minimalism is why it is auditable, and a wider
data budget invites exactly the complexity the BRC-20 account model was rejected for. This file
exists so the ideas are written down while they are fresh, not so they get built next.

Written 2026-08-01, after the regtest probe described in §0.

## 0. What was measured, and what was not

Verified against a real regtest chain (verge 26.5.0, the same binary that runs mainnet):

- **An OP_RETURN carrying value is relayed and mined, and the coins are provably destroyed.**
  `gettxout` on the nulldata output returns null: it never enters the UTXO set. The UTXO-set total
  moved by exactly one block's subsidy minus the burned amount, so the destruction is arithmetic,
  not inference.
- **Verge accepts MULTIPLE OP_RETURN outputs per transaction.** Two and three were both broadcast
  *and mined*. Bitcoin Core rejects this as `multi-op-return`; Verge's fork does not carry the rule.

Not verified, and load-bearing for everything below:

- **Mainnet relay.** Only regtest was tested. If any mainnet relay node enforces `multi-op-return`,
  multi-output transactions propagate badly. Test before depending on it.
- **The interpretation rule.** The spec assumes one OP_RETURN. Two indexers reading several
  differently is a protocol split. The conservative rule (*first one wins, the rest are ignored*)
  must be pinned in the spec before any third party indexes, whether or not the capacity is used.

Measured capacity, with the project's own codec: a 7-byte header, then **7 bytes per edict**, so
**10 edicts per OP_RETURN** (the eleventh overflows at 84 bytes).

## 1. The thesis

**Bitcoin is script-rich and data-poor. Verge is script-poor and data-rich, and it carries a clock.**

No SegWit, no CSV, no Taproot: script-level constructions are largely closed here. But structured
data is effectively free (0.2 XVG/kB, no per-transaction OP_RETURN cap), blocks settle in ~30
seconds rather than ~600, and every transaction carries its own `nTime` with consensus rules R1/R2
binding it to the coins it spends.

Runes is minimal *because 80 bytes forbade more*, not by taste. Copying its shape on Verge means
inheriting a constraint Verge does not have. The architecture that actually fits this chain pushes
logic into indexer-interpreted **data**, where Verge is strong, rather than into **script**, where it
is weak.

The three ideas below share one structure: they spend time and data, which Verge has, where Bitcoin
would have to spend capital and script. That is what makes them non-transposable. Not clever, just
priced differently.

## 2. Coin age as sybil resistance

R1 makes a coin's age a first-class, cheaply verifiable property: it is carried by the transaction
that created it, not reconstructed from a height proof. An indexer can therefore enforce rules of the
form *"this claim requires coins older than N days"* and anyone can check the result from blocks
alone.

The interesting consequence: **the cost imposed on a sybil is time, not money.** Time is the one
resource that cannot be bought or parallelised. A thousand freshly created wallets are still a
thousand wallets aged zero.

Applied to an open mint, the claimable amount becomes a function of coin age. Runes open mints are
races won by bots bidding up fees, that is, won by capital. An age-weighted mint is won by patience.
Given what wallet rotation at scale already looks like on this chain, that is a materially different
distribution mechanism, and a fairer one.

**Honest limit:** this raises the cost of the *reactive* sybil, not the *planned* one. Someone who
opens a thousand wallets today to use them in a year is unaffected. It filters opportunists, which is
what the observed abuse actually was.

## 3. On-chain indexer attestation

ASSETS-SPEC-v0 §8 gives light clients merkle proofs against a state root, the thing no Bitcoin
metaprotocol offers. It leaves one question open: *which root should a wallet believe?*

Proposal: **every indexer publishes its state root on chain, in an OP_RETURN, permissionlessly.**
Anyone compares. A wallet accepts a root only when K independent indexers agree.

This is affordable only here:

```
one root per 100 blocks  =  every ~50 minutes  =  0.2 XVG per attestation
28.8 attestations/day × $0.000379  ≈  $4 per indexer per year
```

The same cadence on Bitcoin costs thousands of dollars a year, roughly a 1300× difference, which is
what moves the idea from impossible to trivial.

Conceptually it replaces *"trust an indexer"* with *"observe agreement between indexers"*, with no
staking, no slashing and no governance. Divergence becomes publicly visible and timestamped.

**Honest limit:** it is a transparency mechanism, not a consensus mechanism. Anyone can publish
anything; the value is in comparison over time and in the reputation of publishers, not in the act of
publishing.

## 4. The inscription as an asset container

This protocol is, as far as we know, the only one where **inscriptions and fungible balances share a
single design**. On Bitcoin, Ordinals and Runes are separate, mutually unaware protocols. Here they
were written together, and multiple OP_RETURNs make it possible to express, in one transaction,
movements that touch both an inscription and the balances riding on the same output.

The primitive: **an NFT that holds tokens inside itself.** Selling the item sells its contents,
atomically, with no contract and no custodian, because both live on the same UTXO and move together
by construction.

For Adventure Mode this is the natural shape: a creature carrying its own food, resources and points
in one output. Transfer the creature and everything it holds travels with it, indivisibly. No escrow,
no wrapper, no second transaction that can fail halfway.

Nobody has this as a native primitive, and not because nobody wanted it. On Bitcoin the two
protocols cannot see each other.

## 5. If only two things are taken from this file

**Batch capacity** and **version headroom** are risk-free and immediately useful: many recipients in
one transaction, and a reserved first OP_RETURN so a later version can add outputs that v0 indexers
simply ignore. Bitcoin metaprotocols must version *inside* one blob, which makes every extension
painful; this costs nothing.

Everything else in this file is open design space. It should be explored once the protocol is running
in production with real users, and not before.
