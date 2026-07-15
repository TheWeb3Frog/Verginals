# Verginals Marketplace, protocol v0 (trustless swaps)

Non-custodial buying, selling and bidding of inscription-carrying UTXOs on Verge. The site is
only an order book: it stores and validates signed messages and displays them. It never holds
funds or assets, cannot execute a trade on its own, and cannot censor a trade arranged off it.
Settlement is a single atomic Verge transaction.

## 0. Two Verge consensus rules that shape everything

Verified in the Verge source (a Peercoin-style timestamped-transaction chain):

- **R1, input-time floor** (`consensus/tx_verify.cpp`): a transaction is rejected with
  `bad-txs-and-input-times` unless `tx.nTime >= nTime` of the transaction that created each of
  its inputs. `nOriginTransactionTime` is set from the creating transaction's own `nTime`
  (`coins.cpp` `AddCoins`).
- **R2, block-time ceiling** (`validation.cpp`): a block is invalid if `block.time < tx.nTime`
  for any transaction, so a transaction cannot be mined before wall-clock reaches its `nTime`.

A legacy signature always commits `nTime` (it is serialized before the inputs), so whoever
signs first pins `nTime` for the whole transaction. Everything below follows from that.

## 1. The carrier

A Verginal lives on a P2PKH UTXO (the "carrier"), tracked by the Verginals indexer's FIFO sat
model. Whoever controls the carrier's key controls the Verginal. A carrier holds a **constant
postage** of 0.1 XVG (`POSTAGE_UNITS`): every trade re-emits the Verginal onto a fresh output of
exactly one postage, with the inscribed sat at offset 0, so the "locked" value never drifts or
grows. Freshly minted carriers may hold more; their first trade heals them back to one postage
and returns the excess to the buyer.

## 2. Listing (sell at a fixed price): SIGHASH_SINGLE | ANYONECANPAY

The seller half-signs a transaction template committing to exactly one output: "output at my
input's index pays me my price". Final transaction layout (the padded ordinal-listing shape):

```
vin[0]  buyer pad A (dust)        vout[0]  padA + padB + offset -> buyer   (padding-out)
vin[1]  buyer pad B (dust)        vout[1]  POSTAGE -> buyer   (new carrier, inscription @ offset 0)
vin[2]  carrier (seller-signed)   vout[2]  price -> seller    (this is what is signed, SELLER_INDEX=2)
vin[3+] buyer funding coins       vout[3]  change -> buyer    (optional)
```

- The carrier sits at index 2 because SIGHASH_SINGLE pairs an input with the output at its own
  index (the price). The two pad inputs push it there.
- `vout[0]` is sized to swallow exactly the two pads PLUS the carrier's pre-inscription sats (its
  `offset`, read from the indexer), so by FIFO the inscribed sat becomes the FIRST unit of
  `vout[1]`. That resets the Verginal to offset 0 inside a fresh, constant-POSTAGE carrier; the
  leftover carrier value flows to the buyer's change. The postage itself travels out of the
  seller's carrier into the buyer's new one, so it stays constant across every resale.
- ANYONECANPAY means only vin[2] is signed; the buyer freely chooses the pads, funding coins and
  every output except vout[2]. The seller's signature is invariant to all of it (proven by tests,
  including a FIFO simulation across repeated trades and a bloated-carrier heal).
- The buyer needs at least three spendable coins: two small pads plus funds for the price + fee.

### 2.1 nTime variants (consequence of R1 + R2)

The seller's signature pins `nTime = T`. By R1 the buyer's coins must be older than `T`; by R2
the transaction is minable only once now `>= T`. A buyer therefore needs a variant with
`coinAge <= T <= now`. Such a `T` always exists in principle (`coinAge <= now`), so at listing
time the wallet signs a **schedule of variants** at increasing timestamps spanning the listing
lifetime (default 30 days): dense near the start, sparser later, e.g.
`T0, +15m, +1h, +4h, +12h, +1d, +2d, +4d, +7d, +14d, +30d`. Each variant is the same template
re-signed at a different `nTime`; it differs only by its scriptSig (~107 bytes). The order book,
for a given buyer, serves the variant with the **largest `T <= now`**; the wallet then spends
only buyer coins older than that `T`. A buyer holding only very fresh coins either waits for the
next variant to unlock or places a bid (section 3), which has no such constraint.

### 2.2 Cancellation and expiry

A listing is cancelled by spending the carrier (any self-send invalidates every variant, since
they all reference that one outpoint). The order book also drops a listing as soon as it sees
the carrier outpoint spent on-chain, and drops variants whose `T` has aged past the listing's
declared lifetime.

## 3. Bid (offer to buy): full transaction, SIGHASH_ALL

The buyer builds the **entire** transaction against a carrier outpoint that is public on-chain,
pins `nTime = now`, and signs only their own inputs with plain SIGHASH_ALL. The carrier input is
left unsigned. Same layout as section 2. Because the buyer pins `nTime` at build time, R1 holds
(the buyer's own coins and the old carrier are both older than now) and R2 holds (it is mined
later, so block time > nTime): **bids have no timestamp constraint**.

- The seller accepts by signing the carrier input (SIGHASH_ALL) and broadcasting. They cannot
  change anything: the buyer already committed the whole transaction.
- A bid self-invalidates if the carrier moves (its outpoint is spent) or if any buyer input is
  spent (the buyer cancels by double-spending one of their own inputs to themselves).
- Bids are the robust path for buyers with freshly received XVG.

## 4. Optional service fee

The buyer's completed transaction may include one extra output paying a fixed marketplace fee to
the operator address. It is added by the completing/​building side, so it too is non-custodial.
Because the protocol is open, a technical user can compose a transaction without the fee; the fee
is earned through the convenience of the site, not enforced. This keeps the marketplace outside
custodial/exchange regulation: the operator never holds the asset or the payment.

## 5. What the order book validates before listing something

- The carrier outpoint exists, is unspent, and currently carries a Verginal (indexer check).
- Every listing variant's signature verifies against a reconstructed template for its `nTime`.
- The seller address in vout[1] is a valid Verge address; the price is positive.
- For bids: the buyer inputs are unspent, the funded amount covers price + fee, and the buyer
  signatures verify. Nothing is broadcast by the server; acceptance is the counterparty's act.

## 6. Not in v0 (later)

Sealed-bid / dark auctions (section from the roadmap), `.xvg` name trading, batch buys, and an
on-site fee-rebate. v0 is fixed-price listings + open bids, which is a complete marketplace.
```
