# Verge Assets, protocol specification v0

A single asset layer for Verge: fungible tokens and non-fungible items under one primitive, one
indexer and one wallet integration, with balances that a light client can **verify without trusting
an indexer**.

Status: draft, not deployed. Companion to `VERGINALS-SPEC-v0.md` (inscriptions), which this reuses.

---

## 0. Why not just port BRC-20 or Runes

| | BRC-20 | Runes | **Verge Assets** |
|---|---|---|---|
| Data location | inscription (JSON text) | OP_RETURN | **inscription to create, OP_RETURN to move** |
| State model | account (balance per address) | UTXO | **UTXO** |
| Cost per transfer | 2 txs (commit + reveal) | 1 tx | **1 tx** |
| Fungible + non-fungible | separate protocol | separate protocol | **one primitive** |
| Light client can verify a balance | no | no | **yes, merkle checkpoints** |
| Native swap | no | no | **yes** |
| Allowlisted mints | no | no | **yes, merkle root** |
| Enforceable royalties | no | no | **yes, as a validity rule** |

BRC-20 bolts an account model onto a UTXO chain using text files; it was an experiment that went
viral, and every operation costs a full inscription. Runes fixed the state model but kept everything
in 83 bytes of OP_RETURN, which leaves no room for anything rich, and it remains a separate protocol
from Ordinals with a separate indexer.

### The constraints this design is built around

Measured on Verge Core 26.5.0, mainnet:

| Capability | Status | Consequence |
|---|---|---|
| SegWit / Taproot | **failed activation** (bip9 `segwit: failed`) | no witness discount; bulk data stays expensive |
| CSV, relative timelocks | **failed activation** | no payment channels, no relative-timeout escrow |
| **CLTV**, absolute timelocks | **active** (bip65) | vesting cliffs, expiring offers, deadline escrow all work |
| OP_RETURN | **relayed, 83 bytes** | enough for the hot path |
| P2SH redeem script | 520 bytes | inscriptions must chunk; ~1 input per 400 bytes |
| Block spacing | **~30 s** | transfers settle in seconds, not an hour |
| COIN | 1e6 (6 decimals) | divisibility caps at 6 |

The 83-byte OP_RETURN is the reason for the hybrid model below, and the 30-second block is the reason
this can be used as money rather than as a collectible.

---

## 1. The hybrid data model

An asset is created **once** and moved **often**. The two have opposite requirements, so they use
different carriers.

| Operation | Carrier | Rationale |
|---|---|---|
| **Etch** (create) | **inscription** (`VERGINALS-SPEC-v0`) | one-time, rich: name, metadata, supply rules, allowlist root, royalty terms. No 83-byte ceiling. |
| **Mint**, **Transfer**, **Checkpoint** | **OP_RETURN** | frequent, tiny, one transaction, negligible fee |

Neither Bitcoin protocol does this: BRC-20 pays inscription prices on every transfer, Runes cannot
express anything that does not fit in 83 bytes.

An etching is an ordinary Verge inscription whose content type is `application/vnd.verge-asset+cbor`.
It therefore inherits, for free, everything the inscription layer already provides: permanence,
provenance, and the parent/child relation used for collections.

---

## 2. The asset primitive

One structure covers both cases. Fungibility is a parameter, not a separate protocol.

```
supply = 1, divisibility = 0   -> a non-fungible item
supply = N, divisibility = d   -> a fungible token
```

### 2.1 Etching payload (CBOR, inside the inscription)

| Field | Key | Type | Notes |
|---|---|---|---|
| ticker | `t` | text, 1..26 | uppercase `A-Z0-9`, unique, see §7 |
| name | `n` | text | display name |
| divisibility | `d` | uint 0..6 | capped by COIN = 1e6 |
| supply cap | `s` | uint | total that may ever exist, in atomic units |
| premine | `p` | uint | credited to the etcher's output, may be 0 |
| mint terms | `m` | map, optional | see §2.2. Absent means no open mint |
| allowlist root | `a` | bytes 32, optional | merkle root, see §5 |
| royalty | `r` | map, optional | `{ b: basis points, x: address }`, see §6 |
| metadata ref | `i` | text, optional | inscription id used as logo/metadata |
| parent | `k` | text, optional | inscription id of the collection this belongs to |

`s`, `p` and every amount are **atomic units**: a token with `d = 2` and a display supply of 1000 has
`s = 100000`.

### 2.2 Mint terms (`m`)

| Field | Key | Type | Notes |
|---|---|---|---|
| amount per mint | `a` | uint | credited per successful mint |
| cap | `c` | uint, optional | maximum number of mints |
| open height | `h0` | uint, optional | first block height that may mint |
| close height | `h1` | uint, optional | last block height that may mint |

An open mint is closed once any of: `c` mints happened, height > `h1`, or `premine + minted` would
exceed `s`.

---

## 3. Balances live on outputs

A balance is attached to a **transaction output**, exactly like the coin itself. Ownership of the
output is ownership of the balance. There is no account table, and no address ever appears in the
protocol messages.

Consequences that matter in practice:

- moving an asset is moving a UTXO: the existing wallet UTXO logic applies unchanged;
- an output can carry **several different assets** at once;
- an output carrying an asset must hold at least the dust minimum in XVG so it stays spendable;
- burning is sending to an unspendable output, and needs no special opcode.

**Default assignment.** Inputs' balances are pooled per asset, edicts are applied in order (§4), and
anything left over goes to the first non-OP_RETURN output. If a transaction has no such output, the
remainder is **burned**. This makes an ordinary wallet transaction that knows nothing about the
protocol safe by default: it moves the whole balance to the recipient rather than destroying it.

---

## 4. The hot path: OP_RETURN messages

```
OP_RETURN OP_PUSH <payload>
```

Payload, at most 83 bytes total:

```
magic (2 bytes)  = 0x56 0x41   ("VA")
version (1 byte) = 0x00
body             = sequence of LEB128 varints
```

The body is a flat varint stream, so it costs nothing when fields are absent.

### 4.1 Edicts (transfers)

An edict is 4 varints:

```
assetRef , amount , outputIndex , flags
```

- `assetRef` is **delta-encoded** against the previous edict's reference, so moving several assets
  in one transaction stays compact and edicts are naturally sorted.
- `amount = 0` means "all of the remaining pooled balance for this asset".
- `outputIndex` is the destination output in this transaction.
- `flags` bit 0 marks the last edict; the remaining bits are reserved and must be 0.

An asset reference is `blockHeight . txIndex` packed as a single varint, which is far smaller than a
32-byte id and is stable once the etching confirms.

### 4.2 Mint message

```
0x01 , assetRef , [ allowlist proof index ]
```

The minted amount is `m.a` from the etching; it is credited to output 0, or to the first
non-OP_RETURN output if output 0 is the OP_RETURN itself.

### 4.3 Checkpoint message

```
0x02 , height , merkleRoot (32 bytes, as 4 varints of 8 bytes)
```

See §8. Anyone may publish one; publishing is permissionless and unprivileged.

### 4.4 Rejection rules

A message is ignored in full (never partially applied) if: the magic or version is unknown, a varint
is truncated, an output index is out of range, `flags` has a reserved bit set, or the message exceeds
83 bytes. **Ignoring is not burning**: the default assignment of §3 still applies, so a malformed
message cannot destroy someone's balance.

---

## 5. Allowlisted mints

The etching may carry a 32-byte merkle root `a`. A mint is then valid only if the transaction spends
an input whose scriptPubKey hashes to a leaf proven by the supplied proof.

Leaf = `SHA256(scriptPubKey || maxAmount)`. The proof travels in a second OP_RETURN output when it
does not fit, or in an inscription for large proofs.

This gives real airdrops and fair whitelists for **32 bytes** in the etching. Neither BRC-20 nor Runes
can express it.

---

## 6. Royalties as a validity rule

If the etching declares `r = { b, x }`, a transfer of that asset is **valid only if** the transaction
pays at least `b` basis points of the declared sale value to address `x`.

This is enforceable in a way it is not on Ethereum or Bitcoin, because in a metaprotocol the indexer
**defines what a valid transfer is**. A transfer that skips the royalty simply does not move the
asset: the sender still owns it.

Honest limits, stated in the spec rather than in a footnote:

- it binds those who follow the protocol, which is everyone who agrees on what the asset is;
- a hostile fork of the indexer could ignore royalties, producing a competing state, exactly as with
  any metaprotocol. Social consensus decides which state is real;
- it applies to protocol-level transfers, not to handing someone a private key.

Royalties are **optional per asset** and immutable once etched.

---

## 7. Ticker allocation

Runes made names free and released short ones on a length-unlock schedule spread over four years.
The result was not fairness: bots raced each unlock, and the good names went to squatters who paid
**miners** rather than the ecosystem. The name was never free, only the recipient of the payment
changed.

On Verge that failure mode would be worse. Relay fees are 0.2 XVG/kB, so there is no accidental cost
filter at all, and one operator could take every desirable ticker for pocket change. This is an
observed behaviour on this chain, not a hypothesis: a single operator has already accumulated 565
collection items across 612 wallets.

So a ticker has a price, and it exists for one reason: **to make mass registration ruinous while
leaving one good name affordable to a real project.**

### Schedule

An explicit table rather than a formula, because a lookup cannot be misread by a second
implementation. Permanent once the first asset is etched.

| Length | Price | | Length | Price |
|---|---|---|---|---|
| 1 | 100,000 XVG | | 7 | 1,000 XVG |
| 2 | 50,000 XVG | | 8 | 500 XVG |
| 3 | 25,000 XVG | | 9 | 250 XVG |
| 4 | **10,000 XVG** | | 10 | 100 XVG |
| 5 | 5,000 XVG | | 11 | 50 XVG |
| 6 | 2,500 XVG | | 12+ | 10 XVG |

The arithmetic that matters: a four-letter ticker costs **one project 10,000 XVG**, and costs
**a squatter wanting fifty of them 500,000 XVG**. A descriptive name of twelve characters or more is
nearly free, so honest naming is never priced out.

There is no unlock calendar, so there is no date to camp on. Allocation is first come, tickers are
unique, case-folded to uppercase, and permanent.

### Where the money goes

**Half to the project treasury, half to Verge itself.** Nothing is burned.

A protocol that depends on a chain should contribute to it. Verge's development and its public
infrastructure are what make this protocol possible at all, so a share of every registration goes
back to them by design rather than by goodwill. It also aligns the incentives: the protocol's success
and the chain's health become the same thing.

Both halves must be paid **in the transaction that carries the etching**, each to its exact address.
Paying only one side does not buy a ticker. Any odd unit from the split goes to Verge, never to the
project.

The Verge address is fixed in the protocol and immutable. It **must be an address published by the
Verge project itself**; it is deliberately left unset here until the Verge maintainers confirm one,
because an address invented for a specification would send real money nowhere, forever.

---

## 8. Verifiable light clients (the part nothing else has)

Every metaprotocol has the same unfixable-looking weakness: **you must trust an indexer**. Runes and
BRC-20 offer no answer at all.

### 8.1 Checkpoints

Any party may compute, at a given height, a merkle tree over the entire balance set:

```
leaf   = SHA256( outpoint(36B) || assetRef || amount )
leaves sorted by (outpoint, assetRef)
root   = merkle root, SHA256 pairs, last node duplicated on odd levels
```

and publish `{ height, root }` in a checkpoint message (§4.3).

### 8.2 What this buys

- A **wallet can verify its own balance** with a merkle proof against an on-chain root, without
  running an indexer and without trusting the one it queries.
- **Disagreement becomes public and provable.** Independent indexers publishing at the same height
  either match or do not. A divergence is visible on-chain, immediately, to everyone, and the
  offending indexer can be identified by its own signature.
- It creates an incentive for **several independent indexers**, because publishing is permissionless.

This does not make the protocol trustless in the consensus sense, and the spec should not pretend
otherwise: an indexer can still be wrong. What changes is that being wrong is now **detectable and
attributable** instead of invisible.

---

## 9. Native atomic swaps

The marketplace primitive is part of the protocol, not left to third parties.

A swap is a single transaction, partially signed: the maker signs their input and their expected
output with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`, and the taker appends their input, their output,
and the fee. Neither side can alter the other's leg, and the trade either happens atomically or not
at all.

Because assets are a single primitive, the same construction covers **any pair**: token/XVG,
token/token, item/token, item/item. This is the same construction already proven in
`src/swap.js` for inscription trading.

Offers can be made to expire with CLTV, which is active on Verge.

---

## 10. What this deliberately does not do

Stated plainly so nobody builds on a promise the chain cannot keep:

- **No Turing-complete contracts.** Issuance rules are a fixed, auditable set. A general VM would
  require every indexer to agree on execution semantics, which is where metaprotocols break.
- **No confidential amounts.** Hiding values needs a consensus change. Transport privacy (Tor/I2P)
  and stealth receiving addresses are in scope; amount privacy is not.
- **No payment channels.** CSV never activated on Verge, so relative timelocks are unavailable.
- **No large data in one transaction.** Without SegWit there is no witness discount; bulk media stays
  chunked and expensive, which is why etchings are one-time.
- **No indexer-free operation.** No metaprotocol has this. §8 makes the indexer *checkable*, which is
  the honest version of the claim.

---

## 11. Reference constants

| Name | Value |
|---|---|
| Magic | `0x5641` ("VA") |
| Version | `0` |
| Content type (etching) | `application/vnd.verge-asset+cbor` |
| Max OP_RETURN payload | 83 bytes |
| Max divisibility | 6 |
| Max ticker length | 26 |
| Dust minimum on an asset output | 0.1 XVG |
| Checkpoint leaf hash | SHA256 |

---

## 12. Test vectors

Every vector below is asserted in `test/assets-codec.test.js` and `test/assets-indexer.test.js`, so
an independent implementation can be checked against them. They are the normative examples.

1. Round-trip of an empty message, a single edict, and the maximum number of edicts that fit in 83 bytes.
2. Delta encoding of three ascending asset references in one transaction.
3. `amount = 0` moving the entire pooled balance.
4. Remainder assignment to the first non-OP_RETURN output.
5. Burn when a transaction has no eligible output.
6. A malformed message leaving balances intact via the default assignment.
7. A mint refused past its close height, and one refused for exceeding the cap.
8. A transfer refused for underpaying a declared royalty.
9. A merkle proof verifying against a checkpoint root, and a tampered proof failing.
