<div align="center">
<pre>
__     _______ ____   ____ ___ _   _    _    _     ____  
\ \   / / ____|  _ \ / ___|_ _| \ | |  / \  | |   / ___| 
 \ \ / /|  _| | |_) | |  _ | ||  \| | / _ \ | |   \___ \ 
  \ V / | |___|  _ <| |_| || || |\  |/ ___ \| |___ ___) |
   \_/  |_____|_| \_\\____|___|_| \_/_/   \_\_____|____/ 
</pre>

# Verginals

**Inscriptions on the Verge (XVG) blockchain.**

An application-layer protocol for permanent, on-chain digital artifacts. No
consensus change, no fork, no permission needed.

</div>

---

## What is this?

Verginals lets you inscribe arbitrary data (text, images, anything) directly onto
the Verge blockchain, where it lives permanently and publicly. It's the same idea
as Bitcoin Ordinals and Dogecoin Doginals, adapted to what Verge can actually do
today.

Everything happens at the **application layer**. Verginals adds no rule to Verge,
requires no soft fork, and needs no cooperative miner. If your transaction relays
under standard node policy, it inscribes.

## Why Verge needs its own method

Verge is a Bitcoin fork that ships **SegWit v0** (bech32 `vg` addresses) but **not
Taproot**. That rules out the usual playbook:

| Method | Where the data lives | Works on Verge? |
|---|---|---|
| Ordinals (Bitcoin) | Tapscript witness | ❌ Needs Taproot, which Verge lacks |
| Doginals (Dogecoin) | P2SH `scriptSig` | ✅ Yes, and this is the basis for Verginals |

Verge's transaction serialization does not carry segwit witnesses in a way an
inscription can use, so the witness-discount trick isn't available. Verginals
therefore uses a **P2SH commit/reveal**, Doginals-style:

1. **Commit.** Build a redeemScript that carries the inscription envelope as dead
   code, then pay to `P2SH(hash160(redeemScript))`.
2. **Reveal.** Spend that output, pushing `<signature> <redeemScript>` in the
   `scriptSig`. The envelope is now permanently on-chain.

The envelope itself is **ord-compatible**:

```
<pubkey> OP_CHECKSIG
OP_FALSE OP_IF
  "ord"
  01 <content-type>
  05 <metadata>            (optional, repeatable)
  OP_0
  <body chunk> ...         (≤520 bytes each)
OP_ENDIF
```

When the output is spent, `OP_FALSE OP_IF … OP_ENDIF` is skipped as dead code, and
`<pubkey> OP_CHECKSIG` authorizes the spend. Payloads larger than one standard
redeemScript are split across multiple inputs and reassembled in order.

## Inscription numbering

Inscription serial numbers are **not** stored on-chain. They are assigned
off-chain by a deterministic indexer that walks the chain in canonical order
(block height, then transaction index, then input index), exactly like `ord`. Any
two indexers that see the same chain assign the same numbers, so the ordering is
reproducible by anyone.

## Repository layout

```
src/
  envelope.js   Inscription envelope encoder/decoder (ord-compatible)
  builder.js    P2SH commit/reveal transaction builder
  vergetx.js    Verge transaction serialization + legacy sighash
  indexer.js    Deterministic inscription extraction and numbering
  networks.js   Verge network parameters (from Verge Core)
  rpc.js        Verge node RPC client
  mint.js       Provably-fair mint (commit-reveal)
  server.js     Web service (payment requests, mint, collection API)
  cli.js        Command-line interface
web/            Front-end single-page app (vanilla JS, no build step)
spec/           Protocol specification
```

## Getting started

```bash
npm install
npm test        # run the test suite
npm run web     # start the local web service
```

You'll need a Verge full node with RPC enabled to broadcast inscriptions. See the
spec in [`spec/`](spec/) for protocol details.

## Principles

1. **No consensus change**, ever.
2. **Standard-relay only**: self-propagating, no cooperative miner needed.
3. **Reproducible indexer**: inscriptions are a deterministic function of chain data.
4. **Non-custodial**: the protocol never holds user funds or keys.
5. **Honest disclosure**: inscriptions are permanent, public data, even on a
   privacy-focused chain. Users are told this before they inscribe.

## Acknowledgements

Verginals stands on the shoulders of the inscription movement started by
[Casey Rodarmor](https://github.com/casey) with Ordinals, and the Doginals work
that showed how to do it without Taproot. Thanks to the Verge project and
community for building the chain this runs on.

## Built by

[@TheWeb3Frog](https://x.com/TheWeb3Frog). Contributions welcome, see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE) © the Verginals contributors.
