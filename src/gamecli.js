#!/usr/bin/env node
'use strict';
// Verginals Arena admin CLI: create/start/resolve tournaments off the public HTTP surface (run on
// the server over SSH, the same trust model as launchpad curation). The provably-fair beacon is a
// real Verge block hash; anyone can re-derive a round's result from (beacon, submitted loadouts).
//
//   node src/gamecli.js tournament list
//   node src/gamecli.js tournament show <id>
//   node src/gamecli.js tournament create <8|16|32> [name...]
//   node src/gamecli.js tournament start <id>       # beacon = current best block hash
//   node src/gamecli.js tournament resolve <id>     # resolve the current round with a fresh beacon
//   node src/gamecli.js tournament trophy <id> <inscriptionId>
//
// HARDENING TODO (not blocking): commit a FUTURE block height when a round is scheduled and use
// that block's hash, so the operator cannot pick resolution timing. The store already accepts any
// beacon, so this is a source swap with no logic change.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { RpcClient, VergeChain } = require('./rpc');
const { GameStore } = require('./gamestore');

const NETWORK = (process.env.VERGINALS_NETWORK || 'mainnet') === 'testnet' ? 'testnet' : 'mainnet';
const DATA_DIR = process.env.VERGINALS_DATA_DIR || path.join(__dirname, '..', 'data');

function loadRpcCreds() {
  let user = process.env.VERGINALS_RPC_USER;
  let pass = process.env.VERGINALS_RPC_PASS;
  const host = process.env.VERGINALS_RPC_HOST || '127.0.0.1';
  const port = Number(process.env.VERGINALS_RPC_PORT || (NETWORK === 'mainnet' ? 20103 : 20102));
  if (!user || !pass) {
    const defaultConf = NETWORK === 'mainnet'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'VERGE', 'VERGE.conf')
      : path.join(os.homedir(), 'verge-testnet', '.VERGE', 'VERGE.conf');
    const conf = process.env.VERGINALS_RPC_CONF || defaultConf;
    try {
      const text = fs.readFileSync(conf, 'utf8');
      const grab = (k) => (text.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
      user = user || grab('rpcuser');
      pass = pass || grab('rpcpassword');
    } catch (_) { /* leave undefined */ }
  }
  return { host, port, user, pass };
}

function openStore() {
  const gdir = path.join(DATA_DIR, 'game');
  fs.mkdirSync(gdir, { recursive: true });
  return new GameStore({ dataDir: gdir }).load();
}

/** The current best block hash, used as the round beacon. */
async function bestBlockBeacon() {
  const chain = new VergeChain(new RpcClient(loadRpcCreds()));
  const height = await chain.getBlockCount();
  const hash = await chain.getBlockHash(height);
  return { height, hash };
}

async function main() {
  const [, , group, cmd, ...args] = process.argv;
  if (group !== 'tournament') {
    console.error('usage: node src/gamecli.js tournament <list|show|create|start|resolve|trophy> ...');
    process.exit(2);
  }
  const store = openStore();

  if (cmd === 'list') {
    for (const t of store.listTournaments()) console.log(`${t.id}  ${t.status.padEnd(12)} ${t.players}/${t.size}  ${t.name}${t.championAddress ? '  champion=' + t.championAddress : ''}`);
    return;
  }
  if (cmd === 'show') {
    console.log(JSON.stringify(store.getTournament(args[0]), null, 2));
    return;
  }
  if (cmd === 'create') {
    const size = Number(args[0]);
    const name = args.slice(1).join(' ') || undefined;
    const t = store.createTournament({ name, size });
    console.log(`created ${t.id} (${t.size} players, registering): ${t.name}`);
    return;
  }
  if (cmd === 'start') {
    const { height, hash } = await bestBlockBeacon();
    const t = store.startTournament(args[0], hash);
    console.log(`started ${t.id} with beacon block ${height} (${hash.slice(0, 16)}...), round 1 of ${t.rounds.length ? Math.log2(t.size) : '?'} laid out`);
    return;
  }
  if (cmd === 'resolve') {
    const { height, hash } = await bestBlockBeacon();
    const before = store.getTournament(args[0]);
    if (!before) { console.error('no such tournament'); process.exit(1); }
    const t = store.resolveTournamentRound(args[0], hash);
    if (t.status === 'ended') console.log(`resolved final with beacon block ${height}: CHAMPION = ${t.championAddress}`);
    else console.log(`resolved round ${before.currentRound} with beacon block ${height}; now on round ${t.currentRound}`);
    return;
  }
  if (cmd === 'trophy') {
    const t = store.setTrophy(args[0], args[1]);
    console.log(`trophy for ${t.id} set to ${t.trophyInscriptionId}`);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
