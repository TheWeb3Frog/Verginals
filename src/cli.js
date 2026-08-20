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
const { mainnet, testnet, regtest, COIN } = require('./networks');
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
  // regtest is opt-in by exact name: anything unrecognised still falls back to testnet, so a typo
  // can never silently point mainnet-shaped work at a local test chain.
  if (name === 'regtest') return { name: 'regtest', params: regtest, network: toBitcoinjsNetwork(regtest) };
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
 *
 * `pay` (optional) adds one P2PKH input of the caller's, and spends it into `pay.outputs`, with
 * anything left over returned to `pay.change`. A rune etching needs this: the ticker price has to
 * be locked in the SAME transaction as the etching (RUNES-SPEC-v0 §7.2), and it is far more than a
 * commit ever carries, so it cannot come out of the inscription's own funding. Inert when absent, so
 * an ordinary inscription reveal is byte for byte what it always was.
 *   pay = { txid, vout, value, wif, change, outputs: [{ address, value }] }
 * @returns {{hex, txid, tx, outputValue, parentOut}}
 */
function revealFromPlan({ plan, utxos, to, fee, values, parent, pay, notBefore }) {
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
  if (pay) {
    const spend = (pay.outputs || []).reduce((s, o) => s + o.value, 0);
    const change = pay.value - spend;
    if (change < 0) {
      throw new Error(`pay input ${pay.value} cannot cover ${spend} of extra outputs`);
    }
    inputs.push({
      txid: pay.txid, vout: pay.vout, value: pay.value, p2pkh: true,
      signer: ECPair.fromWIF(pay.wif, network),
    });
    for (const o of pay.outputs || []) outputs.push({ address: o.address, value: o.value });
    // Change last, so the carrier stays at index 0 and the lock keeps a fixed place behind it.
    if (change > 0) outputs.push({ address: pay.change, value: change });
  }
  // notBefore is a block height this reveal may not be mined at or below, and it exists for the one
  // case where timing costs money rather than patience: an etching mined under the activation height
  // is not a rune, while its ticker deposit still went into a real locked output.
  const { hex, txid, tx } = buildReveal({ network, inputs, outputs, signer, notBefore });
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

  const notBefore = flags['not-before'] == null ? undefined : Number(flags['not-before']);
  const { hex, txid, outputValue } = revealFromPlan({ plan, utxos, to: flags.to, fee, values, notBefore });
  console.error(`reveal txid   : ${txid}`);
  if (notBefore) {
    console.error(`not before    : block ${notBefore + 1} (locktime ${notBefore}, sequences non-final)`);
    console.error('                a node will refuse this with "non-final" until then, which is the point');
  }
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
  mint reveal --plan <plan.json> --to <address> --utxo <txid:vout> [--utxo ...] [--fee UNITS]
              [--not-before HEIGHT] [--broadcast]
              --not-before H makes the reveal unminable at or below block H, so an etching cannot
              land under the activation height and lock its deposit for nothing.
  unlock --wif <WIF> --locktime <UNIX> --to <address> [--txid <etch txid>] [--fee UNITS] [--broadcast]
         Reopen a locked ticker price. Save the WIF, the locktime and the etch txid when you etch:
         Verge has no address index, so the txid is what makes this one lookup instead of a rescan.

RPC creds: --host --port --rpcuser --rpcpassword  or  env VERGINALS_RPC_HOST/PORT/USER/PASS`;

/**
 * Reopen a locked ticker price (RUNES-SPEC-v0 §7.2).
 *
 * The command an etcher runs four years after they made their coin. It needs three things they were
 * told to save, and the reason it needs the ETCH TXID is worth stating: Verge has no address index,
 * so no node can be asked "what sits at this address". The etching transaction, on the other hand,
 * is one lookup and it contains the locked output by construction. Without the txid the only route
 * left is importaddress with a rescan, which works and takes a long time.
 */
async function cmdUnlock(flags) {
  const recover = require('./runes/recover');
  const { name, network } = pickNetwork(flags.network || 'mainnet');
  const wif = flags.wif;
  const locktime = Number(flags.locktime);
  const to = flags.to;
  const fee = Number(flags.fee || 200000);
  if (!wif || !locktime || !to) throw new Error('need --wif, --locktime and --to');

  const { address, redeemScript } = recover.lockAddress({ locktime, wif, network });
  console.log(`network   ${name}`);
  console.log(`lock      ${address}`);
  console.log(`opens     ${new Date(locktime * 1000).toISOString()}`);

  const client = rpcFromEnv(flags);
  const info = await client.call('getblockchaininfo');
  const open = recover.isOpen(locktime, info.mediantime);
  console.log(`chain     median time past ${info.mediantime} -> ${open ? 'OPEN' : 'STILL LOCKED'}`);
  if (!open) {
    const left = locktime - info.mediantime;
    throw new Error(`still locked for about ${Math.ceil(left / 86400)} more day(s). `
      + 'The chain judges this by median time past, which trails the clock by around an hour.');
  }

  // Find the locked output. The etch transaction holds it, so one lookup is enough.
  let utxos = [];
  if (flags.txid) {
    const tx = await client.call('getrawtransaction', [flags.txid, true]);
    utxos = tx.vout
      .filter((o) => ((o.scriptPubKey || {}).addresses || []).includes(address))
      .map((o) => ({ txid: flags.txid, vout: o.n, value: Math.round(Number(o.value) * COIN) }));
    if (!utxos.length) throw new Error(`no output paying ${address} in ${flags.txid}`);
  } else {
    // No txid saved: fall back to the node's own view, which needs the address watched first.
    const unspent = await client.call('listunspent', [1, 9999999, [address]]);
    utxos = unspent.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(Number(u.amount) * COIN) }));
    if (!utxos.length) {
      throw new Error(`nothing found at ${address}. Either pass --txid <etch transaction>, or import `
        + `the address watch-only and rescan first:\n  verge-cli importaddress ${address} lock true`);
    }
  }
  const total = utxos.reduce((s, u) => s + u.value, 0);
  console.log(`locked    ${fmtXVG(total)} XVG in ${utxos.length} output(s)`);

  const unlock = recover.buildUnlock({ wif, locktime, utxos, to, fee, network });
  console.log(`unlock    ${unlock.txid}  ->  ${fmtXVG(unlock.value)} XVG to ${to}`);
  if (!flags.broadcast) {
    console.log('\n(dry run) add --broadcast to send it. The raw transaction:');
    console.log(unlock.hex);
    return;
  }
  const sent = await client.call('sendrawtransaction', [unlock.hex]);
  console.log(`sent      ${sent}`);
}

async function main(argv) {
  const { _, flags } = parseArgs(argv);
  const [cmd, sub] = _;
  if (cmd === 'list') return cmdList(flags);
  if (cmd === 'mint' && sub === 'commit') return cmdMintCommit(flags);
  if (cmd === 'mint' && sub === 'reveal') return cmdMintReveal(flags);
  if (cmd === 'unlock') return cmdUnlock(flags);
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
