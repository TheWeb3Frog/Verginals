#!/usr/bin/env node
'use strict';
// Verginals CLI: `list` (index the chain) and `mint` (commit/reveal an inscription).
// Pure helpers (parseArgs, inferContentType, buildPlan, revealFromPlan) are exported and
// unit-tested; the command handlers below add the file/RPC I/O around them.
//
//   verginals list   [--from H] [--to H] [--json]
//   verginals mint commit --file <path> [--content-type CT] [--network testnet|mainnet]
//                         [--amount UNITS] [--key WIF] [--out PLAN]
//   verginals mint reveal --plan <plan.json> --to <address> --utxo <txid:vout> [--utxo ...]
//                         [--fee UNITS] [--broadcast]
//
// RPC creds come from flags or env: VERGINALS_RPC_HOST/PORT/USER/PASS.

const fs = require('fs');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const { mainnet, testnet, COIN } = require('./networks');
const { Indexer } = require('./indexer');
const { ECPair, toBitcoinjsNetwork, buildInscriptionScripts, p2shFor, buildReveal } = require('./builder');
const { RpcClient, VergeChain } = require('./rpc');

// --- arg parsing -------------------------------------------------------------------------

/**
 * Minimal flag parser. `--k v` sets k=v; a repeated flag collects into an array; a `--flag`
 * with no following value (or before another flag) is boolean true. Bare tokens go to `_`.
 */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      const val = next != null && !next.startsWith('--') ? (i++, next) : true;
      if (key in out.flags) {
        out.flags[key] = [].concat(out.flags[key], val);
      } else {
        out.flags[key] = val;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

// --- content type ------------------------------------------------------------------------

const CT_BY_EXT = {
  '.txt': 'text/plain;charset=utf-8',
  '.md': 'text/markdown;charset=utf-8',
  '.html': 'text/html;charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/** Guess a MIME type from a filename extension; default application/octet-stream. */
function inferContentType(file) {
  return CT_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// --- network -----------------------------------------------------------------------------

function pickNetwork(name) {
  const params = name === 'mainnet' ? mainnet : testnet;
  return { name: name === 'mainnet' ? 'mainnet' : 'testnet', params, network: toBitcoinjsNetwork(params) };
}

// --- pure inscription planning -----------------------------------------------------------

/**
 * Build a reveal "plan": the redeemScript(s) + commit address(es) + the key that authorizes
 * the reveal, serialized so funding can happen out of band before `revealFromPlan`.
 * `metadata` (optional Buffer) is ord tag-5 CBOR embedded on the first input's envelope.
 * `parent` (optional Buffer) is the ord tag-3 parent inscription id (see parentIdToBuffer).
 * @returns {{network, contentType, file, wif, inputs: [{redeemScript, address, amount}]}}
 */
function buildPlan({ body, contentType, networkName = 'testnet', amount, wif, file = null, metadata, parent }) {
  const { name, network } = pickNetwork(networkName);
  const signer = wif ? ECPair.fromWIF(wif, network) : ECPair.makeRandom({ network });
  const pubkey = Buffer.from(signer.publicKey);
  const scripts = buildInscriptionScripts({ pubkey, contentType, body, metadata, parent });
  return {
    network: name,
    contentType,
    file,
    wif: signer.toWIF(),
    inputs: scripts.map((rs) => ({
      redeemScript: rs.toString('hex'),
      address: p2shFor(rs, network).address,
      amount,
    })),
  };
}

/**
 * Build and sign the reveal transaction from a plan + the funded commit UTXOs.
 * `utxos` are "txid:vout" strings in the SAME order as plan.inputs (i.e. body order).
 * `values` (optional) overrides per-input funding in units, when the real UTXO value
 * has been resolved on-chain it takes precedence over the plan's `--amount` estimate.
 * The child carrier output (the inscription's home) goes to `to` and receives
 * sum(commit inputs) − fee.
 *
 * `parent` (optional) makes this a parented mint (spec §10.3): the collection-parent's P2PKH
 * carrier is appended as the LAST input and re-emitted, unchanged in value, as output 1 to
 * `parent.address` (the operator's parent-holding address). It is signed with `parent.wif`, a
 * different key than the reveal wif. The fee still comes entirely from the commit inputs, so the
 * parent value passes straight through; parent.value MUST exceed `fee` so the parent lands in
 * output 1 (not swept to the child at offset 0). Does not broadcast.
 *   parent = { txid, vout, value, wif, address }
 * @returns {{hex, txid, tx, outputValue, parentOut}}
 */
function revealFromPlan({ plan, utxos, to, fee, values, parent }) {
  const { network } = pickNetwork(plan.network);
  const signer = ECPair.fromWIF(plan.wif, network);
  if (utxos.length !== plan.inputs.length) {
    throw new Error(`expected ${plan.inputs.length} --utxo (one per commit input), got ${utxos.length}`);
  }
  const inputs = plan.inputs.map((inp, i) => {
    const [txid, voutStr] = utxos[i].split(':');
    if (!txid || voutStr === undefined) throw new Error(`bad --utxo "${utxos[i]}" (want txid:vout)`);
    return {
      txid,
      vout: Number(voutStr),
      value: values && values[i] != null ? values[i] : inp.amount,
      redeemScript: Buffer.from(inp.redeemScript, 'hex'),
    };
  });
  const commitIn = inputs.reduce((s, i) => s + i.value, 0);
  const outputValue = commitIn - fee; // child carrier = commit inputs minus the miner fee
  if (outputValue <= 0) {
    throw new Error(`fee ${fee} ≥ total funded ${commitIn}; fund more or lower --fee`);
  }
  const outputs = [{ address: to, value: outputValue }];
  if (parent) {
    if (!(parent.value > fee)) {
      throw new Error(`parent carrier ${parent.value} must exceed reveal fee ${fee} to survive as output 1`);
    }
    const parentSigner = ECPair.fromWIF(parent.wif, network);
    inputs.push({ txid: parent.txid, vout: parent.vout, value: parent.value, p2pkh: true, signer: parentSigner });
    outputs.push({ address: parent.address, value: parent.value }); // carry the parent forward unchanged
  }
  const { hex, txid, tx } = buildReveal({ network, inputs, outputs, signer });
  const parentOut = parent ? { txid, vout: 1, value: parent.value } : null;
  return { hex, txid, tx, outputValue, parentOut };
}

// --- formatting --------------------------------------------------------------------------

const fmtXVG = (units) => (units / COIN).toFixed(6);

const PRIVACY_NOTICE =
  'NOTE: Verginals inscriptions are PUBLIC and PERMANENT on-chain data, the opposite of\n' +
  'Verge\'s privacy design. Anything you inscribe is visible forever to everyone. (spec §9)';

// --- RPC plumbing ------------------------------------------------------------------------

function rpcFromEnv(flags) {
  return new RpcClient({
    host: flags.host || process.env.VERGINALS_RPC_HOST || '127.0.0.1',
    port: Number(flags.port || process.env.VERGINALS_RPC_PORT || 20102),
    user: flags.rpcuser || process.env.VERGINALS_RPC_USER,
    pass: flags.rpcpassword || process.env.VERGINALS_RPC_PASS,
  });
}

// --- command: list -----------------------------------------------------------------------

async function cmdList(flags) {
  const chain = new VergeChain(rpcFromEnv(flags));
  const tip = await chain.getBlockCount();
  const from = Number(flags.from ?? 0);
  const to = Number(flags.to ?? tip);
  const idx = new Indexer();
  for (let h = from; h <= to; h++) {
    idx.processBlock(await chain.fetchDecodedBlock(h));
    if (h % 500 === 0 || h === to) process.stderr.write(`\rscanning ${h}/${to}`);
  }
  process.stderr.write('\n');

  const list = idx.list();
  if (flags.json) {
    console.log(JSON.stringify({ from, to, digest: idx.digest(), inscriptions: list }, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log(`no inscriptions in blocks ${from}..${to}`);
  } else {
    for (const i of list) {
      console.log(`#${i.number}  ${i.id}  ${i.contentType || 'n/a'}  ${i.bodySize}B  @ ${i.location}`);
    }
  }
  console.log(`digest: ${idx.digest()}`);
}

// --- command: mint commit ----------------------------------------------------------------

function cmdMintCommit(flags) {
  if (!flags.file || flags.file === true) throw new Error('mint commit: --file <path> is required');
  const body = fs.readFileSync(flags.file);
  const contentType =
    typeof flags['content-type'] === 'string' ? flags['content-type'] : inferContentType(flags.file);
  const networkName = flags.network === 'mainnet' ? 'mainnet' : 'testnet';
  const amount = Number(flags.amount ?? 300_000); // per-input commit funding (units)

  const plan = buildPlan({
    body,
    contentType,
    networkName,
    amount,
    wif: typeof flags.key === 'string' ? flags.key : undefined,
    file: path.basename(flags.file),
  });
  const planPath = typeof flags.out === 'string' ? flags.out : `${flags.file}.verginals-plan.json`;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  console.log(PRIVACY_NOTICE);
  console.log('');
  console.log(`content-type : ${contentType}`);
  console.log(`body size    : ${body.length} bytes`);
  console.log(`network      : ${plan.network}`);
  console.log(`commit inputs: ${plan.inputs.length}`);
  plan.inputs.forEach((inp, i) => {
    console.log(`  [${i}] fund ${fmtXVG(inp.amount)} XVG -> ${inp.address}`);
  });
  console.log('');
  console.log(`plan written : ${planPath}`);
  console.log('  ⚠ this file contains the reveal PRIVATE KEY (wif); keep it safe, do not commit.');
  console.log('');
  console.log('Next: fund each address above (e.g. node wallet `sendtoaddress`), then:');
  const utxoFlags = plan.inputs.map(() => '--utxo <txid:vout>').join(' ');
  console.log(`  verginals mint reveal --plan ${planPath} --to <address> ${utxoFlags} --broadcast`);
}

// --- command: mint reveal ----------------------------------------------------------------

async function cmdMintReveal(flags) {
  if (!flags.plan || flags.plan === true) throw new Error('mint reveal: --plan <plan.json> is required');
  if (!flags.to || flags.to === true) throw new Error('mint reveal: --to <address> is required');
  const plan = JSON.parse(fs.readFileSync(flags.plan, 'utf8'));
  const utxos = flags.utxo === undefined ? [] : [].concat(flags.utxo);
  const fee = Number(flags.fee ?? 100_000);

  // Resolve each funded UTXO's real value on-chain so the carrier output / fee math
  // reflects what was actually sent (the plan's --amount is only an estimate). If the
  // node is unreachable, fall back to the plan amounts.
  const chain = new VergeChain(rpcFromEnv(flags));
  let values;
  try {
    values = await Promise.all(
      utxos.map((u) => {
        const [txid, voutStr] = u.split(':');
        return chain.resolvePrevValue(txid, Number(voutStr));
      })
    );
  } catch (e) {
    console.error(`warn: could not resolve UTXO values via RPC (${e.message}); using plan --amount`);
    values = undefined;
  }

  const { hex, txid, outputValue } = revealFromPlan({ plan, utxos, to: flags.to, fee, values });
  console.error(`reveal txid   : ${txid}`);
  console.error(`carrier output: ${fmtXVG(outputValue)} XVG -> ${flags.to}`);
  console.error(`fee           : ${fmtXVG(fee)} XVG`);

  if (flags.broadcast) {
    const sent = await chain.sendRawTransaction(hex);
    console.error(`broadcast ok  : ${sent}`);
  } else {
    console.error('(dry run: pass --broadcast to publish; raw tx hex on stdout)');
  }
  console.log(hex);
}

// --- dispatch ----------------------------------------------------------------------------

const USAGE = `verginals <command>

  list   [--from H] [--to H] [--json]
  mint commit --file <path> [--content-type CT] [--network testnet|mainnet] [--amount UNITS] [--key WIF] [--out PLAN]
  mint reveal --plan <plan.json> --to <address> --utxo <txid:vout> [--utxo ...] [--fee UNITS] [--broadcast]

RPC creds: --host --port --rpcuser --rpcpassword  or  env VERGINALS_RPC_HOST/PORT/USER/PASS`;

async function main(argv) {
  const { _, flags } = parseArgs(argv);
  const [cmd, sub] = _;
  if (cmd === 'list') return cmdList(flags);
  if (cmd === 'mint' && sub === 'commit') return cmdMintCommit(flags);
  if (cmd === 'mint' && sub === 'reveal') return cmdMintReveal(flags);
  console.log(USAGE);
  process.exitCode = cmd ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, inferContentType, pickNetwork, buildPlan, revealFromPlan };
