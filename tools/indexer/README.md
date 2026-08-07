# Running your own Verginals indexer

Everything a wallet needs to know about Verginals is on the Verge chain. This runs the index
yourself so you never have to ask verginals.com, or anyone else, what the chain says.

Two reasons that matters, and the first is the one that should decide it.

**Privacy.** The hosted `POST /api/inscriptions/at` works by the wallet sending its own outpoints to
a server, which then answers which of them carry an inscription. On a privacy chain that is the
wrong shape: it tells a third party which coins a user holds. Running this locally, or mirroring its
`/snapshot`, means that question is answered on the user's own machine and nothing leaves it.

**Independence.** A wallet that depends on one server inherits that server's downtime, its
operator's goodwill, and its operator's word about what is on chain. None of those should be
load-bearing when the data is public and the rules are written down.

## What you need

- A Verge node, 26.5.0 or later, with `txindex=1` and RPC enabled
- Node.js 18 or later
- No database, no other services

## Run it

```bash
git clone https://github.com/TheWeb3Frog/Verginals.git
cd Verginals
node tools/indexer/verginals-indexer.js --rpc-user USER --rpc-pass PASS --rpc-port 20102
```

`USER` and `PASS` are the `rpcuser` and `rpcpassword` from your `VERGE.conf`. Every flag also reads
from an environment variable, listed at the top of `verginals-indexer.js`.

| flag | default | what it does |
|---|---|---|
| `--rpc-host` / `--rpc-port` | `127.0.0.1` / `20102` | where your node listens |
| `--from` | `9290000` | first block to scan. The Alpha collection starts above this |
| `--port` | `3401` | where this serves its HTTP API |
| `--state` | `./verginals-index.json` | index checkpoint, so a restart resumes |
| `--once` | off | scan to the tip, print the digest, exit |
| `--poll-ms` | `20000` | how often to look for new blocks |

A cold scan from height 9290000 to a tip around 9387000 takes about **four minutes** and produces a
state file of a few hundred kilobytes. Nothing here stores inscription bodies, only their hashes, so
the file stays small. After that it resumes from the checkpoint in under a second.

## What it serves

| route | what you get |
|---|---|
| `GET /status` | height, tip, whether it is caught up, count, digest |
| `GET /digest` | the §6 reproducibility digest at the height reached |
| `GET /inscriptions` | every inscription: number, id, content type, body hash, location |
| `GET /snapshot` | the whole `outpoint -> number` map, about 90 KB, with an ETag |
| `POST /inscriptions/at` | `{"outpoints":["txid:vout", ...]}`, max 500, wire-compatible with the hosted API |

`POST /inscriptions/at` takes the same request and returns the same shape as
`https://verginals.com/api/inscriptions/at`, so a wallet already written against the hosted service
can be pointed at your own instance by changing one base URL.

For a wallet, prefer `/snapshot`. At 90 KB it is small enough to hold whole, it revalidates in one
conditional request, and it means the wallet never has to name the coins it is asking about, not
even to its own backend.

## Proving you agree with everyone else

`spec/VERGINALS-SPEC-v0.md` §6 fixes the processing order and defines a digest over the canonical
state: `sha256` of `number|id|contentType|bodyHash|location` for every inscription, in number order,
newline joined. Two indexers at the same height that agree on that hash agree on everything.

**Compare at a checkpoint height, never at your tips.** Two instances are almost never at the same
tip, and the digest covers state that keeps moving: an inscription's location changes every time its
coin is spent. So "your latest against my latest" tells you nothing either way.

Checkpoints are every 1000 blocks, and each one is the state after that block is processed:

```bash
curl -s "http://127.0.0.1:3401/digest?height=9387000"
curl -s "https://verginals.com/api/index/digest?height=9387000"
```

Without `?height` you get the digest at whatever tip that instance has reached, which is useful as a
health check and useless for comparison.

`GET /digest` also returns a `checkpoints` block with the interval and the first and latest heights
it can answer for. Two instances intersect those ranges and compare at the highest common height. An
instance that has not reached a height answers **404**, never an empty digest, so a caller can tell
"not there yet" apart from "we disagree".

Once your checkpoints match the hosted one, you have proved your implementation and you can stop
calling the hosted API entirely. That is the point of this directory.

### For a wallet offering a choice of servers

If you let users pick between instances, have the wallet compare a common checkpoint across two or
three of them and warn on a mismatch, rather than leaving the user to decide who to believe. They
have no way to evaluate that; the hash does it for them. It turns the list into a choice about
latency and uptime instead of a choice about trust.

## If they do not match

The rules that decide the outcome are §2 (the envelope), §5 (identity and location), and §6
(determinism), in that order of likelihood. The usual causes:

- **different `--from`**: inscription numbers are assigned in scan order, so a different start
  height renumbers everything. The state file refuses to resume across a changed `--from` for this
  reason, but two separate instances will happily disagree.
- **a node without `txindex`**: prevout values cannot be resolved, so the location tracking in §5
  goes wrong.
- **malformed envelopes**: v0 ignores them rather than numbering them (no "cursed" negatives, §6.2).
  An implementation that assigns them numbers will drift from the first bad one onward.

## Writing your own instead

`src/indexer.js` is deliberately pure and node-agnostic: you hand it decoded blocks and it returns
identical output every time. It has no network, no disk and no clock. If you would rather write your
own in another language, that file plus §2, §5 and §6 of the spec is the whole contract, and the
digest above is how you check yourself against it.
