# Verge Runes, protocol specification v0

A single rune layer for Verge: fungible tokens and non-fungible items under one primitive, one
indexer and one wallet integration, with balances that a light client can **verify without trusting
an indexer**.

Status: draft, not deployed. Companion to `VERGINALS-SPEC-v0.md` (inscriptions), which this reuses.

---

## 0. Why not just port BRC-20 or Runes

| | BRC-20 | Runes | **Verge Runes** |
|---|---|---|---|
| Data location | inscription (JSON text) | OP_RETURN | **inscription to create, OP_RETURN to move** |
| State model | account (balance per address) | UTXO | **UTXO** |
| Cost per transfer | 2 txs (commit + reveal) | 1 tx | **1 tx** |
| Fungible + non-fungible | separate protocol | separate protocol | **one primitive** |
| Light client can verify a balance | no | no | **yes, merkle checkpoints** |
| Native swap | no | no | **yes** |
| Allowlisted mints | no | no | **yes, merkle root** |

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

A rune is created **once** and moved **often**. The two have opposite requirements, so they use
different carriers.

| Operation | Carrier | Rationale |
|---|---|---|
| **Etch** (create) | **inscription** (`VERGINALS-SPEC-v0`) | one-time, rich: name, metadata, supply rules, allowlist root. No 83-byte ceiling. |
| **Mint**, **Transfer**, **Checkpoint** | **OP_RETURN** | frequent, tiny, one transaction, negligible fee |

Neither Bitcoin protocol does this: BRC-20 pays inscription prices on every transfer, Runes cannot
express anything that does not fit in 83 bytes.

An etching is an ordinary Verge inscription whose content type is `application/vnd.verge-rune+cbor`.
It therefore inherits, for free, everything the inscription layer already provides: permanence,
provenance, and the parent/child relation used for collections.

That inheritance is structural, not a coincidence of tooling, and it is the one thing Bitcoin cannot
copy. Runes there was deliberately built to be independent of inscriptions: a Runestone is a bare
OP_RETURN with no envelope, no parent and no provenance, and `ord` indexes both only because it is
one binary. A Bitcoin rune cannot belong to a collection. Here a rune etching *is* an inscription, so
one index reads both, one coin can carry a Verginal and a token at once, and a rune's parent claim is
verified by the same rule inscriptions use: the etching must SPEND the parent it names (§10.2).
Without that check a rune could claim any collection it liked.

---

## 2. The rune primitive

One structure covers both cases. Fungibility is a parameter, not a separate protocol.

```
supply = 1, divisibility = 0   -> a non-fungible item
supply = N, divisibility = d   -> a fungible token
```

### 2.1 Etching payload (CBOR, inside the inscription)

| Field | Key | Type | Notes |
|---|---|---|---|
| ticker | `t` | text, 1..26 | uppercase `A-Z` only, unique, see §7 |
| symbol | `y` | text, exactly 1 character, optional | what a wallet shows beside an amount. Absent renders as `¤`, see §7.3 |
| divisibility | `d` | uint 0..6 | capped by COIN = 1e6 |
| supply cap | `s` | uint | total that may ever exist, in atomic units |
| premine | `p` | uint | credited to the etcher's output, may be 0 |
| mint terms | `m` | map, optional | see §2.2. Absent means no open mint |
| allowlist root | `a` | bytes 32, optional | merkle root, see §5 |
| display spacers | `x` | uint, optional | bitfield, see §7.1. Display only, never part of the identity |
| price lock | `l` | map | `{ t: unix locktime, k: 33-byte pubkey }`, see §7.2 |

**There is no free text name, deliberately.** A ticker is the name. An earlier draft carried a
display name under `n`, written to the chain and permanent, and nothing in it stopped an etcher
labelling their coin "Official Bitcoin" or the name of somebody else's project. Every wallet would
have shown it and nobody could have taken it back. Bitcoin Runes has no such field for the same
reason, and this follows it. `n` is reserved and MUST NOT be written; an implementation that finds
one in an old payload MUST ignore it and use the ticker.

A rune has two names, exactly as Bitcoin Runes does. The **ticker** is the human one, unique, and
claimed first come. The **rune ID** is `<height>:<txIndex>`, the block the etching landed in and its
position inside that block, which is the same `BLOCK:TX` shape Runes writes as `840000:1`. The ID is
what a wallet or an explorer refers to; the ticker is what a person says out loud.

The only other identity is `y`, a symbol of **exactly one character**, counted in code points so a
single emoji is legal and a two character string is not. One character is too short to impersonate
anything.
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
| mint price | `f` | uint, optional | atomic units each mint must pay **as transaction fee**, see §7.3 |

Every field here is a **non-negative whole number**, and an etching whose terms are not is not a rune
at all: it is refused outright, exactly as a bad ticker is. `a` must additionally be at least 1, and
`h1` may not be below `h0`.

That is stricter than it looks and the strictness is the point. A fractional `a` mints perfectly
happily and produces a balance that no edict can encode, so the units exist on an outpoint and can
never be moved off it again. Dropping just the offending terms would be worse than refusing the
etching: it silently registers a premine-only rune where the etcher paid for a mintable one, which
is a different rune from the one they bought.

An open mint is closed once any of: `c` mints happened, height > `h1`, or `premine + minted` would
exceed `s`.

A mint that does not pay `f` credits nothing. The fee is `sum(inputs) − sum(outputs)`, so an indexer
must be able to value every input of a mint transaction; **an indexer that cannot resolve the fee
must refuse the mint**, never assume it was paid, or two indexers reading the same chain would
disagree according to how their node happens to be configured.

---

## 3. Balances live on outputs

A balance is attached to a **transaction output**, exactly like the coin itself. Ownership of the
output is ownership of the balance. There is no account table, and no address ever appears in the
protocol messages.

Consequences that matter in practice:

- moving a rune is moving a UTXO: the existing wallet UTXO logic applies unchanged;
- an output can carry **several different runes** at once;
- an output carrying a rune must hold at least the dust minimum in XVG so it stays spendable;
- burning is sending to an unspendable output, and needs no special opcode.

### 3.0 Two names no rune may take

**`VERGE` and `XVG` cannot be etched.** An etching claiming either is ignored, even when the lock pays
in full, and the name stays unclaimed for ever.

The reason is narrow and it is the only one: a rune called XVG claims to be the chain's own money, and
no rune can be. A wallet showing `1,000 XVG` beside a rune balance would be indistinguishable from one
showing a coin balance, and there is no honest reading of that. Every other name is somebody's to take.

**The list is exactly two and it does not grow.** A reserved list that can be added to later is a
governance surface, and the moment one exists somebody has to be trusted to decide what belongs on it.
The rule is not "names we would rather keep", it is "the name of the chain and the name of its coin",
and that pair was fixed in 2014. `VERGECOIN` is a different word and is not a claim to be XVG, so
reserving it would be taste rather than a rule. An implementation that reserves a third name is not
this protocol.

Checked against the **bare** ticker, after display spacers are removed (§7.1), so `V•ERGE` reduces to
`VERGE` before the rule is consulted and cannot walk around it.

### 3.1 Activation, and how long a rune must settle

**Activation height: 9,420,420.** An etching in a block below this height is not a rune, however well
formed it is. This is not only a start date. It is the **indexer's start block**: no name can be
claimed before the rules were published, and any implementation may skip 9.4M blocks of history
before it begins reading.

**Maturity: 6 blocks.** A rune is named by *where* it was etched, the pair `(height, txIndex)`. A
reorg re-mines the etching somewhere else, so **the name changes**, and a different etching can
inherit the old one. Until an etching has 6 blocks on top of it:

- **no edict naming that rune is honoured**, and
- an implementation must not report the rune as settled.

Everything else about the etching applies at once. In particular **the ticker is claimed
immediately**, because a name that stayed free for six blocks could be claimed twice inside the gap
and only one claimant would ever find out.

**A held-back edict does not destroy anything.** The balance falls through to the default assignment
below, exactly as an unnamed rune does. This is deliberate and it is the more important half of the
rule: refusing the balance outright would **burn a premine** on an ordinary wallet transaction sent a
few minutes after an etch, which is far worse than the problem the delay exists to solve. What the
delay stops is being *sold* a rune whose name is not settled, because a sale moves it by edict.

**Why 6.** Measured on Verge mainnet across 56,572 blocks (9,362,949 to 9,419,521): two reorgs, both
one block deep, both resolved inside thirty seconds. At the observed 34 s pace six blocks is 3.4
minutes, six times the deepest thing seen, and it costs an etcher that wait exactly once.

Both numbers are parameters, not constants of nature: a test or a regtest chain passes its own, and
the defaults are the mainnet rule so forgetting to pass them gives the strict behaviour rather than
the permissive one.

**Default assignment.** Inputs' balances are pooled per rune, edicts are applied in order (§4), and
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

An edict is 5 varints:

```
heightDelta , txIndex , amount , outputIndex , flags
```

- `heightDelta` is the block height of the rune, **delta-encoded** against the previous edict, so
  moving several runes in one transaction stays compact.
- `txIndex` is the position of the etching transaction inside that block, written in full.
- `amount = 0` means "all of the remaining pooled balance for this rune".
- `outputIndex` is the destination output in this transaction.
- `flags` bit 0 marks the last edict; the remaining bits are reserved and must be 0.

Edicts are sorted by `(height, txIndex)` ascending.

#### What names a rune

A rune is identified by **where it was etched**: the pair `(blockHeight, txIndex)`. The two numbers
are carried as two separate varints and are **never combined arithmetically**. In memory, in JSON and
in a checkpoint leaf, the canonical written form is `"<height>:<txIndex>"`, and it is an opaque
identity: parse it, never do arithmetic on it. Sorting is by height then position, never as text,
since `"100:1"` sorts before `"99:2"` lexicographically.

An earlier draft packed this as a single varint, `height * 1000 + txIndex`. That is wrong, and it is
worth recording why rather than quietly fixing it: a block holding 1000 transactions makes the
thousandth transaction of block N collide with the first of block N+1. Two runes then share one
reference, the second etching overwrites the first, and their balances merge into one number. Any
constant K has the same cliff at K transactions per block, so there is no value worth choosing. The
pair must stay a pair.

The pair also costs nothing. At a mainnet-scale height a packed reference took 5 bytes; the pair
takes 4 for the height and 1 for a small position, and a mint message is 9 bytes either way.

Heights below 3 cannot be encoded, because the first varint of an edict stream shares its byte with
the control opcodes of §4.2 and §4.3. Nothing is lost: no rune can be etched in the first three
blocks of a chain.

### 4.2 Mint message

```
0x01 , height , txIndex , [ allowlist proof index ]
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

Two further rules exist so that two implementations cannot read the same bytes differently:

**Varints must be minimal.** LEB128 allows `0x81 0x00` and `0x01` to both mean 1. A padded encoding
is refused. One meaning must have one encoding, or a transaction has several valid forms and an
implementation that normalises differently reads a different message.

**The carrying script must be exactly `OP_RETURN <push>`.** The declared push length is honoured, and
anything after that push means the output carries no message. Reading to the end of the script
instead let a trailing byte join the payload and silently change what the message said: one `0x51`
appended to a mint turned `proofIndex: null` into `proofIndex: 81`. This is stricter than it needs to
be, deliberately, because "the payload is the one data push" cannot be read two ways.

---

## 5. Allowlisted mints

The etching may carry a 32-byte merkle root `a`. A mint is then valid only if the transaction spends
an input whose scriptPubKey hashes to a leaf proven by the supplied proof.

```
leaf   = SHA256( 0x00 || uint32be(len(scriptPubKey)) || scriptPubKey || ascii(maxAmount) )
parent = SHA256( 0x01 || lower || higher )     // the pair ordered by byte comparison
```

Three things in that shape are load-bearing:

**The tag bytes.** Leaves and interior nodes are hashed under different tags, so nothing that hashes
like an interior node can be presented as a leaf and have a proof one step short of the root still
verify.

**The length prefix.** Without it, `scriptPubKey || "12"` and `(scriptPubKey || "1") || "2"` are the
same preimage, so two different entitlements share one leaf.

**`maxAmount` is an entitlement, and it is enforced.** An indexer keeps a running total per
`(rune, leaf)` and refuses a mint that would take the entry past `maxAmount`. Without that ledger the
same proof mints for ever, which makes an allowlist a door rather than an allocation: the first
version of this section said it bought "a real airdrop or a fair whitelist" while the amount in the
leaf was never checked against anything.

The proof travels alongside the transaction, and every field of it is type-checked before use. A path
element that is not a 32-byte value invalidates the proof; it must never reach a comparison that
throws, because one hostile transaction would then stop the whole scan.

This gives real airdrops and fair whitelists for **32 bytes** in the etching. Neither BRC-20 nor Runes
can express it.

---

## 6. An etch has no owner

Once the etching confirms, **no party has any privileged relationship to the rune**. Not the etcher,
not an indexer operator, not whoever runs a marketplace. This is a promise, so it is stated as a rule
rather than left to be inferred from the absence of a feature:

- **no field may ever change.** There is no update message in §4, and there is no authority that
  could send one if there were;
- **the etcher's only privilege is the premine**, and it is taken in the etching transaction itself.
  Once that transaction confirms they are an ordinary holder;
- **a mint cannot be paused, closed early, or extended by anyone.** It ends by its own terms and by
  nothing else: the cap in `m.c`, the close height in `m.h1`, or the supply cap in `s`;
- **the metadata reference `i` is fixed at etch time.** Runes has no such field at all, so logos and
  links live in marketplace databases instead. Pinning the reference on chain gives the rune its
  identity without giving anybody the power to rewrite it later.

The point is what a buyer does not have to ask. On a protocol with an owner, holding any rune means
knowing who holds the keys to it and what they are allowed to do. Here that question has no subject.

This rules out royalties, which an earlier draft of this spec enforced as a validity rule. Enforcement
did work: the indexer decides what a valid transfer is, so a transfer that skipped the payment simply
would not move the rune, which is more than Ethereum can do. It came out anyway. A royalty needs a
sale price, and a UTXO chain cannot tell a payment from change, so the price had to be asserted from
outside the chain and two indexers could disagree on it without either being wrong. Nothing in this
protocol may depend on a value that is not in a block.

---

## 7. Ticker allocation

Runes made names free and released short ones on a length-unlock schedule spread over four years.
The result was not fairness: bots raced each unlock, and the good names went to squatters who paid
**miners** rather than the ecosystem. The name was never free, only the recipient of the payment
changed.

On Verge that failure mode would be worse. Relay fees are 0.2 XVG/kB, so there is no accidental cost
filter at all, and one operator could take every desirable ticker for pocket change. Nor is
wallet-rotation at scale hypothetical here: it is already observable on this chain, on any drop worth
farming.

So a ticker has a price, and it exists for one reason: **to make mass registration ruinous while
leaving one good name affordable to a real project.**

### Schedule

An explicit table rather than a formula, because a lookup cannot be misread by a second
implementation. Permanent once the first rune is etched.

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

### 7.1 Display spacers

A ticker is `A-Z`, and that alone makes for flat names. Runes solved this with spacers, and the
same trick works here for a few bytes.

The etching may carry `x`, a bitfield: **bit `i` set means render a separator after character `i`**.
The separator is always `U+2022 BULLET`, fixed by the protocol and never chosen by the etcher. Two
etchers picking different separator characters would produce names that look identical to a human
and differ to an indexer, which is a homograph attack with extra steps.

```
ticker  DOGGOTOTHEMOON
x       bits 2, 4, 6, 9 set
display DOG•GO•TO•THE•MOON
```

**Spacers are display only, and never part of the identity.** Uniqueness (§7) and price (§7 schedule)
are both computed on the bare ticker. `DOGGOTOTHEMOON`, `DOG•GO•TO•THE•MOON` and `DOGGO•TOTHEMOON`
are **one rune**, and the second and third cannot be etched once the first exists.

That collision is the mechanism, not a limitation of it. If re-spacing produced a new name, every
desirable ticker could be squatted a dozen times over and the length-based price would stop meaning
anything: a four-letter name would cost 10,000 XVG and its spaced variants nothing.

Normalisation, applied at indexing time:

- only positions `0 .. len-2` are meaningful, so there is no leading and no trailing separator;
- **bits outside that range are ignored, not rejected.** Bitcoin's Runes makes the same call
  ("trailing spacers are ignored") and it is the right one: both behaviours are deterministic since
  the rule is written down either way, but rejecting means a wallet that sets one bit too many
  destroys the etching, and the etcher loses the ticker price over a field that only decides where a
  bullet is drawn;
- **adjacent bits are legal and ordinary.** Bit `i` and bit `i+1` put separators in two neighbouring
  gaps, rendering `A•B•C`. There is no way to place two separators in one gap, so there is nothing
  to forbid here.

Wallets and explorers SHOULD render the spaced form and MUST match, sort and search on the bare one.

This is affordable here in a way it was not on Bitcoin: Runes had to pack spacers into an 80-byte
budget. The etching is CBOR inside an inscription, so the field costs a few bytes and nothing was
given up for it.

### 7.2 The price is locked, not paid

**Nothing is burned and nothing is paid to anyone.** The price is sent to an output the etcher can
spend again, and only again, after `LOCK_SECONDS` have passed.

This is the whole answer to a question every fee model runs into: who receives it. A burn answers
"nobody" but destroys the money. A payout answers with an address, and an address is a party, which
is precisely what §6 spent its length removing from this protocol. A lock answers "nobody, for four
years", which deters mass registration without creating a beneficiary at all.

The deterrence is real, not cosmetic. What a lock costs is the present value of what comes back, so
at the discount rates that actually apply to a coin holder, locking `N` bites between a third and two
thirds as hard as burning `N`. It also removes the same supply from circulation for the duration,
which is most of the monetary argument for a burn.

**The lock output must be an output of the etching transaction itself.** That is not a convention,
it is what makes recovery possible with no stored state anywhere: an indexer reconstructing history
from blocks sees the lock in the same transaction as the rune, for free, and a wallet that has lost
everything but its seed can still find it.

#### The output

A P2SH output whose redeem script is:

```
<locktime>  OP_CHECKLOCKTIMEVERIFY  OP_DROP  <pubkey>  OP_CHECKSIG
```

with `<locktime>` in minimal `CScriptNum` encoding and `<pubkey>` the 33-byte compressed key derived
at `m/44'/77'/0'/2/n`. Branch `2` is reserved for lock keys, so they can never collide with the
external (`0`) or change (`1`) keys of an ordinary wallet.

**`locktime` is a unix timestamp, never a block height.** Both are available (`nLockTime` below
500000000 is a height, at or above it is a timestamp) and the choice is not close over this horizon.
A height lock assumes block spacing will be unchanged four years out: ten percent of drift is five
months of error. A timestamp lock is judged against the block's median time past (BIP113), which
trails the wall clock by the median of the last eleven block times, so it over-runs by roughly two
and a half minutes on a 30-second chain. Two and a half minutes of error on four years is nothing.

`LOCK_SECONDS` is **126,144,000** (1460 days).

#### What the etching publishes

The etching payload carries `l = { t, k }`: the exact `locktime` and the exact 33-byte pubkey. Both
are already public the moment the lock is spent, so publishing them costs no privacy, and it is what
turns recovery from a search into a calculation. A tool given the seed derives keys until one matches
`k`, rebuilds the script from `k` and `t`, and is done. It never has to guess a timestamp, and it
never needs an address index, which Verge does not have.

#### How the lock is spent, in full

This procedure is written out rather than referenced, because **Verge Core cannot perform it**. Its
signing routines only solve recognised script templates, and this is not one of them, so
`signrawtransactionwithkey` refuses with `invalid stack size (possibly missing key)` no matter which
key it is handed. Recovering these coins always requires software written for the purpose.

1. build a transaction spending the lock output, with `nSequence` **below** `0xffffffff` on that
   input. At `0xffffffff` the chain ignores `nLockTime` entirely and the lock is never consulted;
2. set the transaction's own `nLockTime` to at least the script's `locktime`;
3. compute Verge's legacy sighash over it with `SIGHASH_ALL`, `scriptCode` being the redeem script.
   Verge's sighash serialisation is Bitcoin's with the 4-byte `nTime` inserted after the version;
4. `scriptSig` is two pushes: the DER signature with the `SIGHASH_ALL` byte appended, then the redeem
   script itself.

An implementation of exactly this is `test/e2e/timelock-regtest.js`.

#### This section is inscribed

Everything above is a fact about outputs that already exist, so it can never change, and a document
that can never change should not depend on a website. **This section is inscribed on chain, and the
etching's `i` field points at it.** The instructions for unlocking the money live on the same chain
as the money, which is the only form of durability that does not need somebody to keep paying for it.

The program is a convenience; the procedure is the artifact. Any developer with any secp256k1 library
can rebuild the tool from the four steps above, which is how a specification outlives its software.

#### Measured, not assumed

Every claim here was run on a Verge Core v26.5.0 chain (`test/e2e/timelock-regtest.js`):

| | |
|---|---|
| a P2SH CLTV output relays | yes, standard |
| spending before the lock | refused, `non-final` (code 64) |
| spending with `nLockTime` dropped | refused by the script, `non-mandatory-script-verify-flag (Locktime)` |
| spending after the lock | accepted, coins land at the destination |
| a 300s lock released after | 377s, the median-time-past lag |
| Verge Core signing the script | cannot, at all |
| two OP_RETURN outputs in one tx | accepted, unlike Bitcoin Core's default |
| mempool floor | 0.1 XVG, well above Bitcoin's |

**One number is still open.** The schedule above was written for a burn, where the price is the cost.
Under a lock the cost is only the present value of the wait, so the same figures deter between a
third and two thirds as hard. Either the schedule rises to keep the intended pressure, or the
pressure was set too high to begin with. It has to be settled before the first rune is etched,
because the schedule is permanent from that moment.

### 7.3 The mint price, and why the protocol refuses to pick it

A ticker is paid for once. A mint happens thousands of times, so the lock is the wrong instrument
for it: every mint would create an output an ordinary wallet cannot reopen, for an amount that does
not justify the ceremony.

**A mint pays its price as a transaction fee.** Nothing is locked, nothing is burned, and the miner
of the block receives it, exactly as with any other fee. There is still no beneficiary written into
the protocol, and the money now pays for the chain's own security rather than sitting still.

Relay fees alone cannot do this job. Two limits apply to a mint and the larger one binds: the relay
rate of 0.2 XVG/kB, which asks about 0.05 XVG of a 250-byte mint, and the absolute mempool floor of
0.1 XVG, which is therefore what actually gets paid. Taking a 21,000,000 supply issued 1,000 at a
time costs about **2,100 XVG** in total, which is not a deterrent, it is a rounding error. A declared
price of 20 XVG per mint puts the same supply at **420,000 XVG**.

#### The etcher sets it, not the protocol

**`f` is chosen by whoever etches the rune, and applies only to that rune.** This is the one place
where declining to make a decision is the decision.

A protocol-wide constant would be fixed in XVG and permanent from the first etching, while the thing
it is trying to express is a value in dollars. 20 XVG is a few cents today. If XVG appreciates by two
orders of magnitude, that same constant prices minting out of reach, for reasons that have nothing to
do with the rune it is guarding. There is no oracle available that does not introduce a party to
trust, and §6 exists to keep parties out of this protocol, so there is no honest way to keep a single
number current.

An etcher choosing at etch time prices their mint at the value XVG has that day. A coin etched two
years from now carries a judgement made two years from now, without anything being governed, revised
or agreed by anybody. The incentive also lands where the information is: set it too low and one
participant takes the whole mint, too high and nobody mints, and the etcher is the party that cares
about both.

An interface SHOULD offer a suggested figure computed from the price of XVG at etch time, and show
what taking the entire supply would cost at that figure. Most etchers will take the suggestion, which
gets the intended outcome without the protocol having to defend a constant it cannot keep honest.

#### The ceiling, which is measured and not negotiable

Verge Core refuses to broadcast any transaction whose **absolute** fee exceeds **50 XVG**
(`absurdly-high-fee`). It is a flat amount rather than a rate, so a larger transaction buys no
headroom. `sendrawtransaction` accepts `allowhighfees=true` to get past it, and peers relaying the
transaction never apply the check at all, so this is node policy and not consensus. But a price above
it cannot be paid by an ordinary wallet, which is the only thing that matters in practice.

A builder MUST therefore refuse a mint price above **49 XVG**, leaving room for the relay fee that
stacks on top of the price. Refusing at etch time is the whole point: the etching is permanent, and
the mistake would otherwise surface only when the first person tried to mint.

#### What a miner can do about it

A miner can mint for free, by including their own mint in their own block and recovering the fee in
the coinbase. This is stated rather than fixed. The alternative is a burn, which cannot be recovered
by anyone, and which throws away the reason to prefer fees in the first place; and the attack is
bounded, since it takes sustained hashrate and one transaction per mint rather than a single cheap
sweep.

#### Measured, not assumed

Everything above was run on a Verge Core v26.5.0 chain (`test/e2e/runes-price-regtest.js`):

| | |
|---|---|
| a mint paying 20 XVG (81 XVG/kB, 400x the relay minimum) | standard, relays, no override needed |
| a fee of exactly 50 XVG | accepted |
| a fee of 50.000001 XVG | refused, `absurdly-high-fee` |
| the same, with `allowhighfees` | accepted |
| the coinbase of the block carrying the mints | subsidy + every fee in the block, to the unit |
| `getblock` verbosity 3 (inline prevouts) | not implemented, so a fee costs one lookup per input |
| a `fee` field on a block transaction | absent |
| a mint paying the price to an address instead of the miner | credits nothing |

---

## 8. Verifiable light clients (the part nothing else has)

Every metaprotocol has the same unfixable-looking weakness: **you must trust an indexer**. Runes and
BRC-20 offer no answer at all.

### 8.1 Checkpoints

Any party may compute, at a given height, a merkle tree over the entire state: every balance, **and
every rune definition**.

```
balance leaf = SHA256( 0x00 || utf8( "<outpoint>|<runeRef>|<amount>" ) )
               outpoint is "<txid hex>:<vout>", runeRef is "<height>:<txIndex>"
rune leaf    = SHA256( 0x02 || utf8( "<runeRef>|<ticker>|<divisibility>|<supply>|<spacers>" ) )
pair         = SHA256( 0x01 || a || b ), a and b ordered by byte comparison, smaller first
leaves       = every balance sorted by (outpoint, runeRef), THEN every rune sorted by runeRef
root         = fold pairs upward; an ODD node is carried up unchanged, never duplicated
empty        = 32 zero bytes, a valid commitment to "nothing exists yet"
```

and publish `{ height, root }` in a checkpoint message (§4.3).

Four details here are load-bearing and easy to get wrong in a second implementation:

**The tree commits to what a reference MEANS, not only to how much of it sits where.** An earlier
draft covered balances alone, so a verified proof told a wallet "outpoint X holds 500 of 9388102:14"
and left the ticker, the divisibility and the supply coming from whoever answered the query. That is
exactly the trust a checkpoint exists to remove: a wallet that cannot prove the reference is GRUMPY
has not proven it holds any GRUMPY. A wallet showing a balance should fetch both proofs.

**Leaves and interior nodes are tagged apart.** Without the tag bytes, anything that hashes like an
interior node can be handed over as a leaf, and a proof one step short of the root still verifies.
Here the two preimages happen to differ in length as well, since an outpoint alone is 66 characters
and an interior preimage is exactly 64, but that is an accident of formatting and the tag is what
makes it a property.

**A lone node at the end of a level is carried up as it is.** Duplicating it, which is what Bitcoin's
own transaction tree does, lets one proof authenticate two different trees (the CVE-2012-2459 shape).
Carrying it up costs nothing and closes that off.

**The pair order comes from comparing the two hashes, not from left and right.** That is what lets a
proof be a bare list of sibling hashes with no direction flags in it.

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
at all. This is the construction already proven in `src/swap.js` for inscription trading, and because
runes are a single primitive the same shape covers any pair: token/XVG, token/token, item/token,
item/item.

Offers can be made to expire with CLTV, which is active on Verge.

### 9.1 Why a listing must sell a whole carrier

Applying the inscription construction to a **divisible** rune without one extra rule is a theft
vector, so the rule is stated here rather than left to implementers to discover.

`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` commits the maker to exactly one output: their own payment.
Every other output, **including the OP_RETURN that carries the edicts**, is built by the taker. For an
inscription that is safe, because an inscription is indivisible and travels with its satoshi. For a
divisible rune it is not, because **the amount that leaves is decided by an edict the maker never
signed**.

Concretely, with the marketplace layout (`vout[0]` padding-out to the buyer, `vout[1]` the buyer's new
carrier, `vout[2]` the maker's price):

| | Buyer receives | Maker keeps |
|---|---|---|
| Honest taker, edicts as agreed | 300 | 700 |
| Taker simply omits the OP_RETURN | **1000** | **0** |

With no edict, the default assignment (§3) sweeps the whole pooled balance to the first eligible
output, which belongs to the buyer. The maker is paid for 300 and loses 1000, using the maker's own
valid signature.

**The rule:** a rune listing sells the **entire balance of one carrier outpoint**. A listing may not
name a partial amount. A maker who wants to sell part of a holding **splits first**, in a separate
transaction they sign in full, and then lists the resulting carrier.

This removes the attack rather than mitigating it: when everything on the carrier is for sale, a
missing edict costs the maker nothing, and the worst a lazy taker achieves is receiving the balance on
`vout[0]` instead of on the intended carrier at `vout[1]`. Implementations SHOULD still emit the
explicit edict so the balance lands on the proper carrier.

### 9.2 A listing declares everything on the carrier

A single outpoint can hold several different runes (§3). A listing MUST therefore declare **every**
rune and amount the carrier holds, and a taker MUST refuse a listing whose declaration does not match
the chain.

This protects both sides: a maker cannot accidentally sell a rune they had forgotten was sitting on
that coin, and a taker knows exactly what the coin carries before paying for it.

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
- **No fair-launch guarantee on an open mint.** The mint price (§7.3) makes taking a whole supply
  expensive rather than free, which is the difference between 2,100 XVG and 420,000 XVG on a
  21,000,000 supply, but it does not decide who gets there first. It rations capital, not time, so a
  well funded participant can still take most of an ungated mint. No further rule is imposed, because
  every one that would settle the race rations time instead and charges the honest minter for a
  problem they did not cause. The tools that do decide are already here: an allowlist (§5) says in
  advance who is invited, and a full premine lets the etcher distribute by hand. An ungated open mint
  is a race, and the interface says so before the etching is signed rather than after.
- **No way to tighten issuance rules after the fact.** Adding a restrictive field later would split
  the index in silence, because an indexer that does not recognise it carries on permitting what the
  new rule forbids, and neither side can tell. Issuance rules are therefore what they are at v0.

---

## 11. Reference constants

| Name | Value |
|---|---|
| Magic | `0x5641` ("VA") |
| Version | `0` |
| Content type (etching) | `application/vnd.verge-rune+cbor` |
| Max OP_RETURN payload | 83 bytes |
| Max divisibility | 6 |
| Max ticker length | 26 |
| Dust minimum on a rune output | 0.1 XVG |
| Rune reference | the pair `(height, txIndex)`, written `"<height>:<txIndex>"` |
| Lowest encodable rune height | 3 |
| Checkpoint leaf hash | SHA256 |
| Domain tags | `0x00` balance leaf, `0x01` interior node, `0x02` rune definition |
| Allowlist tags | `0x00` leaf, `0x01` interior node |
| Ticker price lock | 126,144,000 seconds (1460 days) |
| Lock derivation branch | `m/44'/77'/0'/2/n` |
| Lock grace, signing to confirmation | 86,400 seconds |
| Node fee ceiling (`absurdly-high-fee`) | 50 XVG, absolute |
| Maximum mint price a builder may etch | 49 XVG |

---

## 12. Test vectors

Every vector below is asserted in `test/runes-codec.test.js` and `test/runes-indexer.test.js`, so
an independent implementation can be checked against them. They are the normative examples.

1. Round-trip of an empty message, a single edict, and the maximum number of edicts that fit in 83 bytes.
2. Delta encoding of three ascending rune references in one transaction.
3. `amount = 0` moving the entire pooled balance.
4. Remainder assignment to the first non-OP_RETURN output.
5. Burn when a transaction has no eligible output.
6. A malformed message leaving balances intact via the default assignment.
7. A mint refused past its close height, and one refused for exceeding the cap.
8. A merkle proof verifying against a checkpoint root, and a tampered proof failing.
9. Two runes etched at `(N, 1000)` and `(N+1, 0)` keeping separate references and separate balances.
10. A padded varint refused, and a script with trailing bytes after its push carrying no message.
11. An etching with fractional mint terms taking no ticker.
12. An allowlist entry stopping at `maxAmount` however many times its proof is presented.
13. A rune definition proved against the same root as a balance, and a lie about the ticker failing.

`test/runes-conformance.test.js` drives this implementation and a second, independently written one
over randomised histories and compares their roots. That harness is only worth what it can catch, so
each of the defects above was reintroduced into the second implementation alone and the harness was
confirmed to notice; a history generator that only ever etched at one position in the block, or only
ever presented well-formed input, would have passed through several of them.

---

## 13. Known gaps

Stated here rather than discovered later.

**Reorgs are handled by the service, not by the state machine.** `applyTx` only moves forward and has
no undo, which is deliberate: it is a pure reduction and the conformance harness depends on that.
Rewinding is the driver's job (`src/indexservice.js`). It follows the chain by block hash rather than
by height, keeps periodic snapshots of the whole state, and on a fork restores the newest snapshot at
or before it and reads the replacement blocks. A reorg deeper than the retained trail is refused
loudly rather than repaired badly.

Two traps are worth recording, because both were live before this was written and neither is obvious:

- A reorg does not have to make the chain longer. If blocks are replaced at heights already counted,
  the tip number is unchanged or lower, and a scan that only inspects NEW blocks fetches nothing and
  notices nothing. The position already held has to be re-checked before it is extended.
- A snapshot held by reference is not a snapshot. The state contains records that later blocks
  mutate in place, so a shallow copy silently rewrites itself and restores to a state that never
  existed. It is serialised, which also makes a snapshot and a state file the same thing.

**The second implementation shares an author.** `verify.js` is a deliberate re-derivation with no
data structure in common, and it catches implementation slips. It cannot catch a shared
misunderstanding of this document, and it did not: the packed rune reference of §4.1 was written into
both, so the conformance harness reported agreement on a defect that would have merged two runes into
one. A genuinely independent implementation, by someone else, remains a launch requirement.
