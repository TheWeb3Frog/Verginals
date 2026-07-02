# Verginals: Verge Inscription Protocol

**Spec version:** `v0` (draft)
**Status:** unfrozen draft; format may change until tagged `v0.0` release
**Layer:** application layer only. **No Verge consensus change is required or proposed.**

---

## 0. Design goals

1. **No fork.** Inscriptions are ordinary, fully-valid Verge transactions. Nodes need no patch.
2. **Standard-relay only.** Every transaction this spec produces must pass default Verge
   relay policy, so it propagates without cooperative miners.
3. **Spendable on Verge.** Inscription payload lives in a P2SH `redeemScript` revealed in the
   `scriptSig` (Doginals-style), because Verge never serializes a SegWit witness (see below).
4. **Reproducible.** The set of valid inscriptions and their locations is a deterministic
   function of chain data. Two indexers over the same chain MUST produce identical output.
5. **`ord`-compatible envelope.** The data envelope mirrors Bitcoin Ordinals so concepts,
   tooling, and mental models transfer.

### Why P2SH and not Taproot or P2WSH

Verge Core advertises SegWit v0 (`DEPLOYMENT_SEGWIT`, `bech32_hrp = "vg"`) but its transaction
serializer is pre-segwit: `SerializeTransaction` writes `[int32 version][uint32 nTime][vin]
[vout][uint32 nLockTime]` and **never serializes a witness** (`CTxIn` writes only `prevout,
scriptSig, nSequence`). Verified empirically against `vergecurrency/verge` source and a real
on-chain transaction (byte-identical re-serialization, matching txid).

Consequences:

- **Taproot** (Bitcoin Ordinals' tapscript path-spend) is **unavailable**: no `DEPLOYMENT_TAPROOT`.
- **P2WSH** outputs can be *funded* but **never spent**: the spending witness that would carry
  the envelope is dropped on serialization, so the reveal can't be formed. The original
  witness-native design is therefore unviable on Verge.
- **P2SH with the envelope in the `scriptSig`** (Dogecoin Doginals method) is the only path that
  works: the `scriptSig` *is* serialized and signed. No witness discount, but it is spendable.

Signing note: because `nTime` sits in the preimage, Verge uses a **legacy sighash that includes
`nTime`** (`CTransactionSignatureSerializer`). Generic bitcoinjs `hashForSignature` is wrong for
Verge; the reveal is signed with a custom serializer (`src/vergetx.js`).

---

## 1. Network parameters (sourced from `vergecurrency/verge` `chainparams.cpp`)

| Parameter | Mainnet | Testnet |
|---|---|---|
| PUBKEY_ADDRESS (P2PKH) | `30` (0x1E) | `115` (0x73) |
| SCRIPT_ADDRESS (P2SH)  | `33` (0x21) | `198` (0xC6) |
| SECRET_KEY (WIF)       | `158` (0x9E) | `243` (0xF3) |
| bech32 HRP             | `vg` | `vt` |
| Default P2P port       | `21102` | `21104` |
| Net magic (pchMessageStart) | `f7 a7 7e ff` | `cd f2 c0 ef` |
| Block target spacing   | 30 s | 45 s |

Monetary unit (`amount.h`): `COIN = 1000000` → **6 decimals**, atomic unit `0.000001 XVG`.
`MAX_MONEY = 16,555,000,000 XVG` → total atomic-unit space `1.6555 × 10^16`.

The atomic unit (1e-6 XVG) is the unit ordinal theory numbers and the unit inscriptions bind
to. This document calls it the **"unit"**.

---

## 2. The inscription envelope

The payload is a never-executed (dead-code) branch appended to a P2SH `redeemScript`.
The `redeemScript` for one inscription input is:

```
<33-byte compressed pubkey>
OP_CHECKSIG
OP_FALSE
OP_IF
    OP_PUSH "ord"            ; protocol tag, ASCII 6f 72 64
    OP_PUSH 0x01  OP_PUSH <content-type>   ; field 1: MIME type, e.g. "image/png"
    OP_PUSH 0x03  OP_PUSH <parent-id>      ; field 3: optional parent inscription (see §10)
    OP_PUSH 0x05  OP_PUSH <metadata>       ; field 5: optional CBOR metadata (may repeat)
    OP_PUSH 0x00                            ; field 0: body marker
    OP_PUSH <body-chunk>     ; one or more pushes, each ≤ 520 bytes
    ...
OP_ENDIF
```

Execution semantics (why this is a valid, standard spend):
- The P2SH `scriptPubKey` (`OP_HASH160 <h160(redeemScript)> OP_EQUAL`) succeeds, then the
  `redeemScript` is deserialized from the last `scriptSig` push and executed.
- `<pubkey> OP_CHECKSIG` consumes the signature (the first `scriptSig` push) and the pubkey,
  leaving `true`.
- `OP_FALSE` pushes empty; `OP_IF` consumes it as false and **skips** to `OP_ENDIF`, so the
  envelope never executes; it is committed and revealed bytes only.
- Final stack is `[true]`.

Field tags follow the `ord` convention: odd tags (1,3,5,…) are defined fields; even tag `0`
marks the start of the body. Unknown odd tags MUST be ignored by indexers (forward-compat).
Tag `1` (content-type) SHOULD appear at most once. The body is the concatenation, in order,
of every push after the `0` marker.

### scriptSig for the reveal input
```
<signature>  <redeemScript>
```
The `redeemScript` is the **last** push and carries the envelope; the whole `redeemScript` is
pushed as a single element, so it must stay ≤ 520 bytes (see §3).

---

## 3. Standardness limits and chunking

P2SH relay policy constrains us tightly, because the whole `redeemScript` is one pushed element:

| Limit | Value | Consequence |
|---|---|---|
| `MAX_STANDARD_P2SH_SCRIPT_SIZE` | 520 bytes | one `redeemScript` (≈ one input) carries ≤ ~474 bytes of body after envelope overhead |
| `MAX_SCRIPT_ELEMENT_SIZE` | 520 bytes | the `redeemScript` push, and each body push, must each stay ≤520 bytes |
| `MAX_STANDARD_TX_WEIGHT` | 400,000 WU | bounds total reveal size (no witness discount on Verge) |

**Chunking rule.** Content larger than one `redeemScript` is split across **multiple P2SH
inputs within a single reveal transaction**. The logical inscription = the concatenation of
body bytes across all inscription inputs **in input order**. The content-type and metadata
fields are taken from the **first** inscription input; later inputs MAY carry body-only
envelopes (tag `0` + body pushes). One reveal transaction = one inscription.

Because each input carries only ~474 body bytes, multi-input reveals are the norm for anything
beyond a short text inscription; the per-input cap keeps every transaction standard-relayable.

---

## 4. Commit / reveal flow

1. **Commit transaction.** Pay an ordinary output to the P2SH address
   `P2SH(redeemScript)` for each inscription input. Standard, indistinguishable from any
   other P2SH payment.
2. **Reveal transaction.** Spend each commit output, supplying `<sig> <redeemScript>` in the
   `scriptSig` (revealing the envelope). Output 0 is the **carrier** output that receives the
   inscription.

Verge's 30 s blocks make commit→reveal confirm quickly.

---

## 5. Inscription identity and location

- **Inscription ID:** `<reveal_txid>iN` where `N` is the 0-based index of the inscription
  among all inscriptions created in that reveal transaction (v0: always one per reveal ⇒ `i0`).
- **Inscription number:** a global counter assigned in chain order (see §6), starting at `0`.
- **Binding:** an inscription binds to the **first unit of the reveal transaction's output 0**
  (txid `:0`, unit offset `0`), matching the Ordinals convention.
- **Transfer / tracking:** the carrier unit moves with normal spends. Indexers follow it
  using first-in-first-out unit flow: outputs are filled from inputs in order; the inscription
  follows the output that contains its bound unit. (This requires unit-flow tracking but NOT
  a global ordinal numbering of the whole supply; that is optional, §7.)
- An inscription whose carrier unit is spent to a transaction fee is considered **burned**
  (assigned to the coinbase/unspendable per indexer policy; v0: marked `burned`).

---

## 6. Indexer determinism

To guarantee identical output across implementations:

1. Process blocks in height order; within a block, transactions in their block order; within
   a transaction, inputs in index order.
2. A transaction creates inscriptions if and only if it has ≥1 input whose `scriptSig` reveals a
   redeemScript with a well-formed envelope (§2). Malformed envelopes are **ignored** in v0 (no
   "cursed" negative numbering).
3. Assign the next global **inscription number** at the moment of creation, in the order
   above.
4. Publish an **index digest**: `SHA256` over the canonical serialization
   `(number, id, content_type, sha256(body), location)` of all inscriptions up to height `H`,
   for agreed checkpoint heights, so independent indexers can prove they agree.

---

## 7. Ordinal theory (optional, Phase 2)

Full ordinal numbering, assigning a serial number to every unit in mining order and tracking
all of them, is **not required** for inscriptions (§5 only needs to track inscribed units).
It is specified separately as an optional extension:

- Unit numbering space: `0 … 1.6555×10^16 − 1`, assigned in mining order using Verge's actual
  per-block subsidy schedule (multi-algo aware) read from the chain.
- FIFO transfer rule identical to Bitcoin ordinal theory.
- Enables rarity/`.sat`-style features. Deferred until the inscription layer is stable.

---

## 8. Out of scope for v0

- Recursion / inscription-references.
- Marketplaces, PSBT trading flows.
- Stealth-address interaction: inscriptions live on the transparent UTXO layer; behavior when
  carrier outputs use Verge privacy features is undefined in v0 and SHOULD be avoided.

---

## 9. Privacy disclosure (normative for tooling)

Verge is a privacy-first chain (Wraith/Tor, stealth addresses). Inscriptions are the
opposite: **permanent, public, transparent on-chain data**. Conforming wallets/tools MUST
surface this to users before they inscribe.

---

## 10. Collections: parent-child membership (tag 3)

A **collection** is a set of inscriptions provably authorized by one **parent inscription**
(the collection root). This mirrors Bitcoin Ordinals and makes collection membership a
*trustless, on-chain* fact that any indexer reproduces without an off-chain allow-list, so
counterfeits are impossible for a conforming indexer to accept.

### 10.1 The parent field (tag 3)

Tag `3` in the envelope (§2) carries the **parent inscription ID** the child claims membership
in. The value is encoded exactly as in `ord`:

```
<32-byte reveal txid, internal byte order> || <output-index, little-endian, trailing zero bytes stripped>
```

For the common `iN` where `N = 0`, the index encodes to zero bytes, so the value is just the
32-byte txid. Tag `3` MAY appear more than once (multiple parents); v0 tooling emits at most one.

### 10.2 Validity: the parent MUST be spent

A tag-3 claim is **valid** (the child is a genuine member) **only if** the child's reveal
transaction has at least one input whose outpoint holds the claimed parent inscription at the
moment of the spend (per the §5 FIFO location index). A tag-3 claim whose reveal does **not**
spend the parent is **unverified** and MUST NOT be counted as a member; indexers MAY expose it
separately as an unverified claim. This spend requirement is what makes membership unforgeable:
only the holder of the parent can mint valid children.

### 10.3 Reveal transaction shape

To keep the §5 binding rule (a new inscription binds to output 0, offset 0) while carrying the
parent forward to the operator, the reveal is:

```
inputs:  [ commit input 0 .. N-1 ]   [ parent UTXO ]        ; parent input LAST
outputs: [ output 0: child carrier ] [ output 1: parent carrier ]
```

- The child's envelope lives in the commit inputs (first), so the child sits at global offset 0
  and binds to **output 0** (the minter's address). No pointer is required.
- The parent inscription's unit sits at global offset `sum(commit input values)`, which, with
  `output0 = commitTotal - revealFee`, lands in **output 1** provided `parentValue > revealFee`.
  Output 1 pays an **operator-controlled** address, carrying the parent forward.

### 10.4 Carry-forward and serialization

The parent inscription is a single unit; each child reveal spends it and re-emits it on output 1.
Mint *k+1* spends the parent from mint *k*'s output 1 (chaining on the unconfirmed output is
permitted, subject to standard mempool ancestor/descendant limits). Consequences a conforming
minter MUST handle:

1. **Serialize** reveals on the parent UTXO (one in flight per unconfirmed-chain slot).
2. **Persist** the current parent tip `{txid, vout}` and advance it atomically per mint.
3. **Reconcile** the tip from the index after any dropped/reorged reveal, by locating the live
   UTXO that currently holds the parent inscription, before resuming.

Losing the operator key that controls the parent UTXO strands the collection: no further
verifiable children can be minted (recovery requires a new parent, which starts a new lineage).

### 10.5 Genesis items minted before the parent existed

Inscriptions created before the parent inscription cannot carry a valid tag 3 (a parent cannot be
referenced before it exists, and `ord`-style parenting is not retroactive). Such items are
**genesis** members whose provenance rests on the collection's published image/asset hashes
(the manifest `provenance_hash`, §manifest) rather than on tag 3. A collection SHOULD enumerate
its genesis items explicitly in its manifest.

### 10.6 Digest

The §6 reproducibility digest is unchanged by this section (it does not fold in parent/child or
metadata). Parent/child relationships are recomputed deterministically from chain data and MAY be
published in a separate, versioned collection digest.
