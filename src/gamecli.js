#!/usr/bin/env node
'use strict';
// Verginals Arena admin CLI: a thin HTTP client for the running server's admin endpoints. The
// server is the SOLE writer of the game store, so tournament create/start/resolve go through it
// (never a process that writes game.json behind the server's back). Run on the VPS over SSH; the
// admin token gates every mutation.
//
//   VERGINALS_GAME_ADMIN_TOKEN=... node src/gamecli.js tournament create <8|16|32> [name...]
//   node src/gamecli.js tournament list
//   node src/gamecli.js tournament show <id>
//   ... tournament start <id>            # beacon = current best block hash (server-side)
//   ... tournament resolve <id>          # resolves a round; auto-mints trophies on the final
//   ... tournament mint-trophies <id>    # re-run trophy minting (e.g. after funding the promo wallet)
//   ... tournament trophy <id> <champion|runnerUp> <inscriptionId>   # record a hand-minted trophy
//   ... tournament trophy-art <id> [outdir]   # write the trophy SVGs locally for preview
//
// Env: VERGINALS_GAME_URL (default http://127.0.0.1:3400), VERGINALS_GAME_ADMIN_TOKEN,
// VERGINALS_COLLECTION_DIR (for trophy-art image embedding).

const path = require('path');
const fs = require('fs');
const { MintController } = require('./mint');
const { buildTrophySVG } = require('./trophy');

const BASE = process.env.VERGINALS_GAME_URL || 'http://127.0.0.1:3400';
const TOKEN = process.env.VERGINALS_GAME_ADMIN_TOKEN || '';
const COLLECTION_DIR = process.env.VERGINALS_COLLECTION_DIR || path.join(__dirname, '..', 'verginals');

async function api(method, p, body, admin) {
  const headers = { 'content-type': 'application/json' };
  if (admin) {
    if (!TOKEN) throw new Error('set VERGINALS_GAME_ADMIN_TOKEN for admin commands');
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function main() {
  const [, , group, cmd, ...args] = process.argv;
  if (group !== 'tournament') {
    console.error('usage: node src/gamecli.js tournament <list|show|create|start|resolve|mint-trophies|trophy|trophy-art> ...');
    process.exit(2);
  }

  if (cmd === 'list') {
    const { tournaments } = await api('GET', '/api/game/tournaments');
    for (const t of tournaments) console.log(`${t.id}  ${t.status.padEnd(12)} ${t.players}/${t.size}  ${t.name}${t.championAddress ? '  champion=' + t.championAddress : ''}`);
    return;
  }
  if (cmd === 'show') {
    const { tournament } = await api('GET', `/api/game/tournament/${args[0]}`);
    console.log(JSON.stringify(tournament, null, 2));
    return;
  }
  if (cmd === 'create') {
    const t = await api('POST', '/api/game/admin/tournament/create', { size: Number(args[0]), name: args.slice(1).join(' ') || undefined }, true);
    console.log(`created ${t.id} (${t.size} players, ${t.status}): ${t.name}`);
    return;
  }
  if (cmd === 'start') {
    const r = await api('POST', '/api/game/admin/tournament/start', { tournamentId: args[0] }, true);
    console.log(`started ${r.tournament.id} with beacon block ${r.beaconHeight}, round 1 laid out`);
    return;
  }
  if (cmd === 'resolve') {
    const r = await api('POST', '/api/game/admin/tournament/resolve', { tournamentId: args[0] }, true);
    const t = r.tournament;
    if (t.status === 'ended') console.log(`resolved final (beacon block ${r.beaconHeight}): CHAMPION = ${t.championAddress}; trophies = ${JSON.stringify(t.trophies)}`);
    else console.log(`resolved a round (beacon block ${r.beaconHeight}); now on round ${t.currentRound}`);
    return;
  }
  if (cmd === 'mint-trophies') {
    const r = await api('POST', '/api/game/admin/tournament/mint-trophies', { tournamentId: args[0] }, true);
    console.log(`trophies: ${JSON.stringify(r.tournament.trophies)}`);
    return;
  }
  if (cmd === 'trophy') {
    const r = await api('POST', '/api/game/admin/tournament/trophy', { tournamentId: args[0], place: args[1], inscriptionId: args[2] }, true);
    console.log(`recorded ${args[1]} trophy: ${JSON.stringify(r.trophies)}`);
    return;
  }
  if (cmd === 'trophy-art') {
    const { tournament: t } = await api('GET', `/api/game/tournament/${args[0]}`);
    if (!t || t.status !== 'ended' || !t.championAddress) { console.error('tournament has no champion yet'); process.exit(1); }
    const finalRound = t.rounds[t.rounds.length - 1];
    const fm = finalRound && finalRound.matches[0];
    const runnerUpAddr = fm ? (fm.winner === fm.p1 ? fm.p2 : fm.p1) : null;
    const mint = new MintController({ collectionDir: COLLECTION_DIR, dataDir: path.join(__dirname, '..', 'data', 'mint') }).load();
    const dateISO = new Date(t.endedAt || Date.now()).toISOString().slice(0, 10);
    const outdir = args[1] || path.join(__dirname, '..', 'data', 'game', 'trophies');
    fs.mkdirSync(outdir, { recursive: true });
    for (const w of [{ place: 'CHAMPION', address: t.championAddress, suffix: 'champion' }, { place: 'RUNNER-UP', address: runnerUpAddr, suffix: 'runner-up' }]) {
      if (!w.address) continue;
      const part = t.participants.find((p) => p.address === w.address);
      if (!part || part.verginal == null) { console.warn(`skip ${w.place}: no Verginal on record`); continue; }
      const item = mint.byNumber.get(Number(part.verginal));
      if (!item) { console.warn(`skip ${w.place}: Verginal #${part.verginal} not in the collection`); continue; }
      const img = fs.readFileSync(path.join(COLLECTION_DIR, 'images', item.filename));
      const mime = item.filename.endsWith('.png') ? 'image/png' : item.filename.endsWith('.gif') ? 'image/gif' : 'image/webp';
      const svg = buildTrophySVG({ number: part.verginal, house: part.house || item.house, imageDataUri: `data:${mime};base64,${img.toString('base64')}`, tournamentName: t.name, dateISO, place: w.place });
      const out = path.join(outdir, `${t.id}-${w.suffix}.svg`);
      fs.writeFileSync(out, svg);
      console.log(`${w.place}: ${out} (${Buffer.byteLength(svg)} bytes) -> ${w.address} (Verginals #${part.verginal})`);
    }
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
