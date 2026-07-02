# Contributing to Verginals

Thanks for your interest. Verginals is a community protocol for inscriptions on
the Verge (XVG) blockchain. Contributions of all kinds are welcome: code, docs,
tooling, indexers, wallets, and art.

## Ground rules

- **No consensus change, ever.** Verginals lives entirely at the application layer.
  Proposals that require a fork of Verge are out of scope.
- **Standard-relay only.** Anything we broadcast must propagate under standard node
  policy, with no cooperative miner required.
- **Determinism first.** Inscription numbering must be a reproducible function of
  chain data. Any change to the indexer needs to preserve that two independent nodes
  reach the same result.
- **Never commit secrets.** No private keys, RPC credentials, `.env` files, wallet
  files, or the mint fairness seed. See `.gitignore` and `SECURITY.md`.

## Development

```bash
npm install
npm test        # run the test suite
npm run web     # run the local web service
```

Tests live alongside the modules they cover. Please add or update tests for any
behavior change, and keep `npm test` green.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; one logical change per PR.
3. Describe **what** changed and **why** in the PR body.
4. Make sure `npm test` passes.

## Reporting bugs

Open a GitHub issue with steps to reproduce. For anything security-sensitive,
follow `SECURITY.md` instead and email **abuse@verginals.com** privately.

## Code of conduct

Be respectful. See `CODE_OF_CONDUCT.md`.
