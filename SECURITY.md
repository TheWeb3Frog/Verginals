# Security Policy

## Reporting a vulnerability

If you find a security issue in Verginals, please report it privately. **Do not
open a public GitHub issue for security problems.**

Email: **abuse@verginals.com**

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if you have one).
- Any relevant transaction IDs, addresses, or logs.

We aim to acknowledge reports within 72 hours and will keep you updated as we
work on a fix. Responsible disclosure is appreciated: give us a reasonable
window to patch before publishing details.

## Scope

Verginals is an **application-layer protocol** on the Verge (XVG) blockchain. It
introduces **no consensus change**. In-scope reports include:

- Flaws in the inscription envelope encoder/decoder (`src/envelope.js`).
- Flaws in the transaction builder or signing path (`src/builder.js`, `src/vergetx.js`).
- Determinism bugs in the indexer that would let two nodes disagree on inscription
  numbering (`src/indexer.js`).
- Issues in the mint fairness scheme (commit-reveal) that would break provable fairness.
- Web-service issues (`src/server.js`, `web/`) such as injection, key exposure, or
  anything that could move or leak funds.

## Out of scope

- The security of the Verge network itself (report those to the Verge project).
- The fact that inscriptions are **permanent, public data** on a public chain. This
  is by design and is disclosed to users before they inscribe.

## Non-custodial by design

Verginals never takes custody of user funds and never holds user private keys for
inscriptions the user controls. Any report suggesting otherwise is treated as high
severity.
