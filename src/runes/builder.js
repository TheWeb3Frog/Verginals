'use strict';
// Verge Runes: transaction builders (RUNES-PLAN §2.2).
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
const tickers = require('./tickers');

const DUST_UNITS = 100000; // 0.1 XVG, matching pricing.js

function assertDust(outputs, dust) {
  outputs.forEach((o, i) => {
    if (o.carriesRune && o.value < dust) {
      throw new Error(`output ${i} holds ${o.value} units, below the ${dust}-unit dust minimum for a rune output`);
    }
  });
}

/**
 * Transfer: move runes to recipients.
 *
 * @param {Array} recipients [{ address, value, runes: [{ runeRef, amount }] }]
 *   `amount: 0` on a rune means "all of the pooled balance" (spec §4.1).
 * @param {Object} [opts] { changeAddress, changeValue, dustUnits }
 * @returns {{ outputs, opReturn, remainderOutput, edicts }}
 */
function buildTransfer(recipients, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('at least one recipient is required');

  const outputs = recipients.map((r) => ({
    address: r.address,
    value: r.value != null ? r.value : dust,
    carriesRune: Array.isArray(r.runes) && r.runes.length > 0,
  }));

  // Change, when present, sits after the recipients and before the OP_RETURN.
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesRune: false, isChange: true });
  }

  // Indices are fixed now, so edicts can safely reference them.
  const edicts = [];
  recipients.forEach((r, i) => {
    for (const a of r.runes || []) edicts.push({ runeRef: a.runeRef, amount: a.amount, output: i });
  });
  if (edicts.length === 0) throw new Error('a transfer with no rune edict is just an ordinary send');

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
 * The mint price is a TRANSACTION FEE, not an output (spec §2.2). So there is nothing to add to the
 * plan for it: the caller must fund the transaction so that inputs minus outputs reaches
 * `mintPrice`, and the miner of the block receives it. That is reported back rather than assumed,
 * because a wallet that funds this the ordinary way pays the relay minimum and the mint is ignored.
 *
 * @param {number} runeRef
 * @param {Object} recipient { address, value }
 * @param {Object} [opts] { mintPrice, proofIndex, changeAddress, changeValue, dustUnits }
 */
function buildMint(runeRef, recipient, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;
  if (!recipient || !recipient.address) throw new Error('a mint needs a recipient address');

  const outputs = [{
    address: recipient.address,
    value: recipient.value != null ? recipient.value : dust,
    carriesRune: true, // the minted amount lands here via the default assignment
  }];
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesRune: false, isChange: true });
  }
  assertDust(outputs, dust);

  const mintPrice = Number(opts.mintPrice || 0);
  if (!Number.isInteger(mintPrice) || mintPrice < 0) throw new Error('mintPrice must be a whole number of atomic units');

  const opReturn = codec.encodeMint(runeRef, opts.proofIndex != null ? opts.proofIndex : null);
  outputs.push({ value: 0, isOpReturn: true, data: opReturn });
  return { outputs, opReturn, remainderOutput: 0, mintPrice, feeIsThePrice: true };
}

/**
 * Publish a state checkpoint (spec §8). Permissionless: anyone may publish, and that is the point.
 */
function buildCheckpoint(height, root, opts = {}) {
  const outputs = [];
  if (opts.changeAddress) {
    outputs.push({ address: opts.changeAddress, value: opts.changeValue || 0, carriesRune: false, isChange: true });
  }
  const opReturn = codec.encodeCheckpoint(height, root);
  outputs.push({ value: 0, isOpReturn: true, data: opReturn });
  return { outputs, opReturn };
}

/**
 * Etch a new rune. The rich payload rides in an inscription (spec §1), so this returns the CBOR
 * body for the existing inscription pipeline to carry, plus the output that receives the premine.
 *
 * Two things here are not metadata and will invalidate the etching if they are wrong:
 *
 *   `lock`  the ticker price, sent to a P2SH CLTV output of THIS transaction (spec §7.2). Not
 *           optional: an etching with no valid lock is ignored by the indexer and the ticker stays
 *           free. It is an output of the etching itself so that recovery needs no stored state.
 *
 *   `terms.price`  what each mint must pay in transaction fee. Permanent from this moment, which is
 *           why the protocol does not pick it: a constant fixed in XVG is a moving number in
 *           dollars, and the etcher is the one who knows what their own mint is worth today.
 *
 * @param {Object} rune { ticker, name, divisibility, supply, premine, terms, lock, allowlistRoot, parent, metadataRef }
 * @param {Object} recipient { address, value } receives the premine
 */
function buildEtch(rune, recipient, opts = {}) {
  const dust = opts.dustUnits != null ? opts.dustUnits : DUST_UNITS;

  // Separators are display only (spec §7.1). The name may arrive either already spaced, the way
  // somebody typed it into a box, or bare with an explicit mask; either way the IDENTITY and the
  // PRICE are the bare name, so both are computed from it and the mask rides along as `x`.
  const typed = String(rune.ticker || '');
  const ticker = tickers.bareTicker(typed);
  if (!/^[A-Z0-9]{1,26}$/.test(ticker)) throw new Error('ticker must be 1..26 characters of A-Z0-9');
  const spacers = tickers.normalizeSpacers(ticker, rune.spacers != null
    ? Number(rune.spacers)
    : tickers.spacersFromDisplay(typed));
  const divisibility = Number(rune.divisibility || 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) {
    throw new Error('divisibility must be an integer between 0 and 6 (COIN is 1e6)');
  }
  const supply = Number(rune.supply || 0);
  const premine = Number(rune.premine || 0);
  if (!Number.isInteger(supply) || supply <= 0) throw new Error('supply must be a positive integer of atomic units');
  if (!Number.isInteger(premine) || premine < 0 || premine > supply) throw new Error('premine cannot exceed supply');
  if (rune.terms && premine >= supply) {
    throw new Error('an open mint with the whole supply premined can never mint: lower the premine or drop the terms');
  }
  if (!recipient || !recipient.address) throw new Error('an etch needs a recipient for the premine');

  // Short CBOR keys, exactly as the spec tabulates them, so the payload stays small.
  const body = { t: ticker, n: rune.name || ticker, d: divisibility, s: supply, p: premine };
  if (spacers) body.x = spacers;   // omitted entirely when there is nothing to render
  if (rune.terms) {
    const m = { a: Number(rune.terms.amount || 0) };
    if (rune.terms.cap != null) m.c = Number(rune.terms.cap);
    if (rune.terms.openHeight != null) m.h0 = Number(rune.terms.openHeight);
    if (rune.terms.closeHeight != null) m.h1 = Number(rune.terms.closeHeight);
    if (rune.terms.price != null) {
      const price = Number(rune.terms.price);
      if (!Number.isInteger(price) || price < 0) throw new Error('the mint price must be a whole number of atomic units');
      // Refused here rather than left to fail at mint time, because the etching is permanent and
      // this mistake would only surface once somebody tried to mint and their node said no.
      if (price > tickers.MAX_MINT_PRICE) {
        throw new Error(`a mint price of ${price / 1e6} XVG cannot be paid by an ordinary wallet: `
          + `Verge Core refuses any transaction fee above ${tickers.ABSURD_FEE_UNITS / 1e6} XVG, and `
          + `the relay fee stacks on top of the price. The ceiling is ${tickers.MAX_MINT_PRICE / 1e6} XVG`);
      }
      if (price > 0) m.f = price;
    }
    if (!(m.a > 0)) throw new Error('mint terms need a positive amount per mint');
    body.m = m;
  }
  if (rune.allowlistRoot) {
    if (!Buffer.isBuffer(rune.allowlistRoot) || rune.allowlistRoot.length !== 32) {
      throw new Error('allowlistRoot must be 32 bytes');
    }
    body.a = rune.allowlistRoot;
  }
  if (rune.metadataRef) body.i = rune.metadataRef;
  if (rune.parent) body.k = rune.parent;

  const outputs = [{
    address: recipient.address,
    value: recipient.value != null ? recipient.value : dust,
    carriesRune: premine > 0,
  }];

  // The ticker price. `l` publishes the two numbers a recovery tool needs, and the output beside it
  // is the money. Both live in this transaction, so an indexer replaying blocks can check the
  // payment with nothing else in front of it.
  const price = tickers.priceOf(ticker);
  let lockScript = null;
  // An etching with no lock is ignored by every indexer and the ticker stays free (§7.2), so
  // building one is never what a caller meant: they would broadcast a reveal, pay its fee, and own
  // nothing. Refused by default rather than returned, since the plan itself looks perfectly healthy
  // and the mistake only shows up as an absence, days later, with the money already spent.
  if (!rune.lock && !opts.unpaid) {
    throw new Error(`etching ${ticker} needs a price lock: without one the ticker is not claimed and `
      + `the reveal fee buys nothing. Pass { lock: { locktime, pubkey } }, or opts.unpaid to build `
      + 'the payload alone.');
  }
  if (rune.lock) {
    const redeem = tickers.lockRedeemScript(rune.lock.locktime, rune.lock.pubkey);
    lockScript = tickers.p2shScriptPubKey(redeem);
    const key = Buffer.isBuffer(rune.lock.pubkey) ? rune.lock.pubkey : Buffer.from(String(rune.lock.pubkey), 'hex');
    body.l = { t: Number(rune.lock.locktime), k: key };
    outputs.push({
      value: price,
      scriptPubKey: lockScript,
      redeemScript: redeem,
      carriesRune: false,
      isPriceLock: true,
    });
  }

  assertDust(outputs, dust);

  return {
    contentType: 'application/vnd.verge-rune+cbor',
    body: cbor.encode(body),
    outputs,
    premineOutput: 0,
    ticker,                                            // the identity, always bare
    display: tickers.displayTicker(ticker, spacers),   // what a wallet should show
    spacers,
    price,
    lockScriptPubKey: lockScript,
  };
}

module.exports = { DUST_UNITS, buildTransfer, buildMint, buildCheckpoint, buildEtch };
