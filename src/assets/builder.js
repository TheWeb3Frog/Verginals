'use strict';
// Verge Assets: transaction builders (ASSETS-PLAN §2.2).
//
// These produce a PLAN, not a signed transaction: the exact outputs to create, in order, plus the
// OP_RETURN payload. Funding and signing stay with the caller (the node wallet, or the project's own
// builder.js), which keeps every rule here pure and testable.
//
// The ordering rule is the whole job. Edicts address outputs by INDEX, so the plan decides the final
// output order and derives the indices from it. Getting this wrong sends someone's balance to the
// wrong recipient, and no amount of testing downstream would catch it.
//
// Invariants every builder upholds:
//   - the OP_RETURN is always LAST, so it can never occupy an index an edict points at;
//   - every output meant to carry a balance holds at least the dust minimum;
//   - the caller is told explicitly which output receives the unassigned remainder (spec §3), since
//     that is where anything not covered by an edict will land.

const cbor = require('../cbor');
const codec = require('./codec');

const DUST_UNITS = 100000; // 0.1 XVG, matching pricing.js

function assertDust(outputs, dust) {
  outputs.forEach((o, i) => {
    if (o.carriesAsset && o.value < dust) {
      throw new Error(`output ${i} holds ${o.value} units, below the ${dust}-unit dust minimum for an asset output`);
    }
  });
}

/**
 * Transfer: move assets to recipients.
 *
 * @param {Array} recipients [{ address, value, assets: [{ assetRef, amount }] }]
 *   `amount: 0` on an asset means "all of the pooled balance" (spec §4.1).
 * @param {Object} [opts] { changeAddress, changeValue, dustUnits }
 * @returns {{ outputs, opReturn, remainderOutput, edicts }}
 */
function buildTransfer(recipients, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('at least one recipient is required');

  const outputs = recipients.map((r) => ({
    address: r.address,
    value: r.value != null ? r.value : dust,
    carriesAsset: Array.isArray(r.assets) && r.assets.length > 0,
  }));

  // Change, when present, sits after the recipients and before the OP_RETURN.
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesAsset: false, isChange: true });
  }

  // Indices are fixed now, so edicts can safely reference them.
  const edicts = [];
  recipients.forEach((r, i) => {
    for (const a of r.assets || []) edicts.push({ assetRef: a.assetRef, amount: a.amount, output: i });
  });
  if (edicts.length === 0) throw new Error('a transfer with no asset edict is just an ordinary send');

  assertDust(outputs, dust);
  const opReturn = codec.encodeEdicts(edicts); // throws if the batch cannot fit in 83 bytes
  outputs.push({ value: 0, isOpReturn: true, data: opReturn });

  return {
    outputs,
    opReturn,
    edicts,
    // Anything not named by an edict lands here (spec §3). Callers must understand this: it is
    // usually the first recipient, which is rarely what you want for leftovers.
    remainderOutput: 0,
  };
}

/**
 * Mint from an open mint.
 *
 * @param {number} assetRef
 * @param {Object} recipient { address, value }
 * @param {Object} [opts] { proofIndex, changeAddress, changeValue, dustUnits }
 */
function buildMint(assetRef, recipient, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;
  if (!recipient || !recipient.address) throw new Error('a mint needs a recipient address');

  const outputs = [{
    address: recipient.address,
    value: recipient.value != null ? recipient.value : dust,
    carriesAsset: true, // the minted amount lands here via the default assignment
  }];
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesAsset: false, isChange: true });
  }
  assertDust(outputs, dust);

  const opReturn = codec.encodeMint(assetRef, opts.proofIndex != null ? opts.proofIndex : null);
  outputs.push({ value: 0, isOpReturn: true, data: opReturn });
  return { outputs, opReturn, remainderOutput: 0 };
}

/**
 * Publish a state checkpoint (spec §8). Permissionless: anyone may publish, and that is the point.
 */
function buildCheckpoint(height, root, opts = {}) {
  const outputs = [];
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesAsset: false, isChange: true });
  }
  const opReturn = codec.encodeCheckpoint(height, root);
  outputs.push({ value: 0, isOpReturn: true, data: opReturn });
  return { outputs, opReturn };
}

/**
 * Etch a new asset. The rich payload rides in an inscription (spec §1), so this returns the CBOR
 * body for the existing inscription pipeline to carry, plus the output that receives the premine.
 *
 * @param {Object} asset { ticker, name, divisibility, supply, premine, terms, allowlistRoot, royalty, parent, metadataRef }
 * @param {Object} recipient { address, value } receives the premine
 */
function buildEtch(asset, recipient, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;
  const ticker = String(asset.ticker || '').toUpperCase();
  if (!/^[A-Z0-9]{1,26}$/.test(ticker)) throw new Error('ticker must be 1..26 characters of A-Z0-9');
  const divisibility = Number(asset.divisibility || 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) {
    throw new Error('divisibility must be an integer between 0 and 6 (COIN is 1e6)');
  }
  const supply = Number(asset.supply || 0);
  const premine = Number(asset.premine || 0);
  if (!Number.isInteger(supply) || supply <= 0) throw new Error('supply must be a positive integer of atomic units');
  if (!Number.isInteger(premine) || premine < 0 || premine > supply) throw new Error('premine cannot exceed supply');
  if (asset.terms && premine >= supply) {
    throw new Error('an open mint with the whole supply premined can never mint: lower the premine or drop the terms');
  }
  if (!recipient || !recipient.address) throw new Error('an etch needs a recipient for the premine');

  // Short CBOR keys, exactly as the spec tabulates them, so the payload stays small.
  const body = { t: ticker, n: asset.name || ticker, d: divisibility, s: supply, p: premine };
  if (asset.terms) {
    const m = { a: Number(asset.terms.amount || 0) };
    if (asset.terms.cap != null) m.c = Number(asset.terms.cap);
    if (asset.terms.openHeight != null) m.h0 = Number(asset.terms.openHeight);
    if (asset.terms.closeHeight != null) m.h1 = Number(asset.terms.closeHeight);
    if (!(m.a > 0)) throw new Error('mint terms need a positive amount per mint');
    body.m = m;
  }
  if (asset.allowlistRoot) {
    if (!Buffer.isBuffer(asset.allowlistRoot) || asset.allowlistRoot.length !== 32) {
      throw new Error('allowlistRoot must be 32 bytes');
    }
    body.a = asset.allowlistRoot;
  }
  if (asset.royalty) {
    const bps = Number(asset.royalty.bps || 0);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('royalty bps must be between 0 and 10000');
    if (!asset.royalty.address) throw new Error('a royalty needs a payout address');
    body.r = { b: bps, x: asset.royalty.address };
  }
  if (asset.metadataRef) body.i = asset.metadataRef;
  if (asset.parent) body.k = asset.parent;

  const outputs = [{
    address: recipient.address,
    value: recipient.value != null ? recipient.value : dust,
    carriesAsset: premine > 0,
  }];
  assertDust(outputs, dust);

  return {
    contentType: 'application/vnd.verge-asset+cbor',
    body: cbor.encode(body),
    outputs,
    premineOutput: 0,
    ticker,
  };
}

module.exports = { DUST_UNITS, buildTransfer, buildMint, buildCheckpoint, buildEtch };
