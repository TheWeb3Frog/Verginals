// Verge network parameters, sourced from vergecurrency/verge src/chainparams.cpp + amount.h.
// Shaped for bitcoinjs-lib's `network` object so address / bech32 / WIF derivation works.
// Verge advertises SegWit v0 (bech32 "vg") but never serializes witnesses (see src/vergetx.js),
// so inscriptions use P2SH/scriptSig, never P2WSH or tapscript.

const COIN = 1_000_000; // amount.h: 6 decimals, atomic unit = 0.000001 XVG
const MAX_MONEY_XVG = 16_555_000_000;
const MAX_UNITS = BigInt(MAX_MONEY_XVG) * BigInt(COIN); // ordinal space = 1.6555e16

const mainnet = {
  name: 'verge',
  messagePrefix: '\x18Verge Signed Message:\n',
  bech32: 'vg',
  // bip32 versions are not defined in our source extract; fill from Verge before HD use.
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 30, // 0x1E -> 'D...' addresses
  scriptHash: 33, // 0x21
  wif: 158, // 0x9E
  port: 21102,
  magic: Buffer.from([0xf7, 0xa7, 0x7e, 0xff]),
  targetSpacing: 30,
};

const testnet = {
  name: 'verge-testnet',
  messagePrefix: '\x18Verge Signed Message:\n',
  bech32: 'vt',
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 115, // 0x73
  scriptHash: 198, // 0xC6
  wif: 243, // 0xF3
  port: 21104,
  magic: Buffer.from([0xcd, 0xf2, 0xc0, 0xef]),
  targetSpacing: 45,
};

// Standardness limits we must stay inside (from the Bitcoin Core base Verge forked).
// NB: Verge never serializes segwit witnesses (see src/vergetx.js), so inscriptions live in a
// P2SH redeemScript revealed in the scriptSig. That redeemScript is pushed as ONE stack element,
// so it must be ≤ MAX_SCRIPT_ELEMENT_SIZE (520).
const limits = {
  MAX_SCRIPT_ELEMENT_SIZE: 520,
  MAX_STANDARD_P2SH_SCRIPT_SIZE: 520, // redeemScript revealed in scriptSig (one push)
  MAX_STANDARD_TX_WEIGHT: 400_000,
};

module.exports = { COIN, MAX_MONEY_XVG, MAX_UNITS, mainnet, testnet, limits };
