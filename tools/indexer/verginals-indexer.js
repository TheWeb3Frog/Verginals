#!/usr/bin/env node
'use strict';
/**
 * A standalone Verginals indexer.
 *
 * Point it at a Verge node and it builds the inscription index itself, from blocks, and serves the
 * read API a wallet needs. It exists so nobody has to call verginals.com to know what is on the
 * Verge chain, which matters for two reasons:
 *
 *   PRIVACY. The hosted /api/inscriptions/at works by the wallet sending us its own outpoints. On a
 *   privacy chain that is the wrong shape: it tells a third party which coins a user holds. Running
 *   this locally, or mirroring its snapshot, means that question is answered on the user's own
 *   machine and nothing leaves it.
 *
 *   INDEPENDENCE. A wallet that depends on one server inherits that server's downtime, its
 *   operator's goodwill, and its operator's word about what the chain says. None of those should be
 *   load-bearing when the data is public and the rules are written down.
 *
 * The indexing core (src/indexer.js) is the same file the hosted service runs, and it is pure: feed
 * it decoded blocks and it produces identical output every time. That determinism is the whole
 * point of spec/VERGINALS-SPEC-v0.md §6, and /digest below lets you prove you agree with anyone
 * else's instance without trusting them.
 *
 * Requirements: a Verge node (26.5.0 or later) with `txindex=1` and RPC enabled.
 *
 * Usage:
 *   node tools/indexer/verginals-indexer.js \
 *     --rpc-user USER --rpc-pass PASS \
 *     [--rpc-host 127.0.0.1] [--rpc-port 20102] \
 *     [--from 9290000] [--port 3401] [--state ./verginals-index.json] [--once]
 *     [--runes] [--runes-from HEIGHT]
 *
 * Every flag also reads from an env var: VERGINALS_RPC_USER, VERGINALS_RPC_PASS, VERGINALS_RPC_HOST,
 * VERGINALS_RPC_PORT, VERGINALS_INDEX_FROM, VERGINALS_INDEXER_PORT, VERGINALS_INDEX_STATE.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { IndexService, ReorgTooDeep } = require('../../src/indexservice');
const { RpcClient, VergeChain } = require('../../src/rpc');

// --- configuration ------------------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const CFG = {
  rpcHost: flag('rpc-host', process.env.VERGINALS_RPC_HOST || '127.0.0.1'),
  rpcPort: Number(flag('rpc-port', process.env.VERGINALS_RPC_PORT || 20102)),
  rpcUser: flag('rpc-user', process.env.VERGINALS_RPC_USER || ''),
  rpcPass: flag('rpc-pass', process.env.VERGINALS_RPC_PASS || ''),
  // The first Verginals reveal is well above this. Starting at 0 works and wastes hours; starting
  // too late silently misses inscriptions, so this default is the safe one for the live collection.
  from: Number(flag('from', process.env.VERGINALS_INDEX_FROM || 9290000)),
  port: Number(flag('port', process.env.VERGINALS_INDEXER_PORT || 3401)),
  state: flag('state', process.env.VERGINALS_INDEX_STATE || path.join(process.cwd(), 'verginals-index.json')),
  once: has('once'),
  pollMs: Number(flag('poll-ms', 20000)),
  // Verge Runes ride inside inscriptions (RUNES-SPEC-v0 §1), so the same scan can build both
  // ledgers for almost nothing. Off by default: the protocol is not launched, and an index nobody
  // reads is still a promise to keep it correct.
  runes: has('runes'),
  runesFrom: Number(flag('runes-from', process.env.VERGINALS_RUNES_FROM || 0)) || null,
};

if (!CFG.rpcUser || !CFG.rpcPass) {
  console.error('need --rpc-user and --rpc-pass (or VERGINALS_RPC_USER / VERGINALS_RPC_PASS).');
  console.error('They are the rpcuser/rpcpassword from your VERGE.conf.');
  process.exit(2);
}

const client = new RpcClient({
  host: CFG.rpcHost, port: CFG.rpcPort, user: CFG.rpcUser, pass: CFG.rpcPass,
});
const chain = new VergeChain(client);

/**
 * The index is cheap to hold and expensive to rebuild: a cold start walks every block from `from`
 * to the tip, which is minutes, and a wallet backend that does that on every restart is a wallet
 * backend people turn off. Nothing here holds inscription bodies, only their hashes, so the file
 * stays small.
 *
 * Saving is driven by the service, which calls back every time it takes an internal snapshot. Those
 * are the same heights the old loop saved at, and tying the two together means the file on disk and
 * the state a reorg rewinds to are always the same thing.
 */
const svc = new IndexService({
  chain,
  from: CFG.from,
  runes: CFG.runes,
  runesFrom: CFG.runesFrom,
  onSnapshot: (h) => { save(); process.stdout.write(`  indexed to ${h}\r`); },
});
const indexer = svc.inscriptions;

function save() {
  const tmp = `${CFG.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(svc.toJSON()));
  fs.renameSync(tmp, CFG.state);
}

function load() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CFG.state, 'utf8')); } catch (_) { return false; }
  const r = svc.load(raw);
  if (!r.ok) console.error(`${r.reason}. Rebuilding.`);
  return r.ok;
}

/**
 * Catch up, and survive the chain changing its mind.
 *
 * A reorg deeper than the service can rewind is not something to retry: every poll would fail the
 * same way. It is reported once, loudly, with the one action that fixes it.
 */
async function sync() {
  try {
    const tip = await svc.sync();
    save();
    return tip;
  } catch (e) {
    if (e instanceof ReorgTooDeep) {
      console.error(`\n${e.message}\n  rm ${CFG.state}  and start again.`);
      process.exit(3);
    }
    throw e;
  }
}

// --- the read API -------------------------------------------------------------------------------

const json = (res, code, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // Anyone may read this: it is public chain data, and a wallet calling from a page needs it.
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 512 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && (p === '/' || p === '/status')) {
      const tip = await chain.getBlockCount().catch(() => null);
      return json(res, 200, {
        from: CFG.from,
        scannedThrough: svc.scannedThrough,
        tip,
        synced: tip !== null && tip - svc.scannedThrough < 2,
        count: indexer.inscriptions.size,
        digest: indexer.digest(),
        // How many times the chain changed its mind under us, and how far back we could still
        // repair it from. Both belong in a health check: an index that has never noticed a reorg
        // and an index that cannot notice one look identical from the outside.
        reorgsRepaired: svc.reorgs,
        trailDepth: svc.trail.depth,
        runes: CFG.runes ? { count: svc.runes.runes.size, tickers: svc.runes.tickers.size } : null,
      });
    }

    // The reproducibility digest. Equal hashes at the same height mean equal state, which is the
    // whole proof that you do not need anyone else.
    //
    // Without ?height, this answers for the tip you personally reached, which is fine for a health
    // check and useless for comparison: two instances are never at the same tip, and the digest
    // covers state that keeps moving. Compare at a checkpoint instead.
    if (req.method === 'GET' && p === '/digest') {
      const want = url.searchParams.get('height');
      const range = indexer.checkpointRange();
      if (want !== null) {
        const h = Number(want);
        if (!Number.isInteger(h) || h <= 0 || h % range.interval !== 0) {
          return json(res, 400, { error: `height must be a multiple of ${range.interval}`, checkpoints: range });
        }
        const digest = indexer.checkpointAt(h);
        // 404 rather than an empty digest: "I have not reached that height" and "we disagree" must
        // never look the same to whoever is comparing us.
        if (!digest) return json(res, 404, { error: 'no checkpoint at that height yet', height: h, checkpoints: range });
        return json(res, 200, { height: h, digest, checkpoints: range });
      }
      return json(res, 200, {
        height: svc.scannedThrough,
        count: indexer.inscriptions.size,
        digest: indexer.digest(),
        checkpoints: range,
        spec: 'spec/VERGINALS-SPEC-v0.md §6',
      });
    }

    if (req.method === 'GET' && p === '/inscriptions') {
      return json(res, 200, { height: svc.scannedThrough, count: indexer.inscriptions.size, inscriptions: indexer.list() });
    }

    // The whole outpoint -> number map. Small enough to ship to a client whole, which is the shape
    // that leaks nothing: the wallet never has to say which coins it is asking about.
    if (req.method === 'GET' && p === '/snapshot') {
      const at = {};
      for (const i of indexer.list()) at[i.location] = i.number;
      const digest = indexer.digest();
      return json(res, 200, { height: svc.scannedThrough, count: indexer.inscriptions.size, digest, at }, {
        etag: `W/"${svc.scannedThrough}-${digest.slice(0, 16)}"`,
        'cache-control': 'public, max-age=30',
      });
    }

    // Wire-compatible with the hosted POST /api/inscriptions/at, so a wallet can be pointed at this
    // instance by changing one base URL.
    if (req.method === 'POST' && p === '/inscriptions/at') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch (_) { return json(res, 400, { error: 'invalid JSON' }); }
      const outpoints = Array.isArray(body.outpoints) ? body.outpoints : [];
      if (outpoints.length > 500) return json(res, 400, { error: 'too many outpoints (max 500)' });
      const byLocation = new Map(indexer.list().map((i) => [i.location, i]));
      const found = {};
      for (const o of outpoints) {
        const hit = byLocation.get(String(o));
        if (hit) found[o] = { id: hit.id, number: hit.number, contentType: hit.contentType };
      }
      return json(res, 200, { height: svc.scannedThrough, found });
    }

    return json(res, 404, { error: 'not found', routes: ['/status', '/digest', '/inscriptions', '/snapshot', 'POST /inscriptions/at'] });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

// --- boot ---------------------------------------------------------------------------------------

(async () => {
  const resumed = load();
  console.log(`Verginals indexer · node ${CFG.rpcHost}:${CFG.rpcPort} · from height ${CFG.from}`);
  console.log(resumed ? `resumed from ${CFG.state} at height ${svc.scannedThrough}` : 'no usable state file, scanning from scratch');

  const t0 = Date.now();
  const tip = await sync();
  console.log(`indexed to ${svc.scannedThrough} (tip ${tip}) in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`${indexer.inscriptions.size} inscriptions · digest ${indexer.digest()}`);

  if (CFG.once) {
    console.log('--once given, exiting.');
    return;
  }

  server.listen(CFG.port, () => console.log(`serving on http://127.0.0.1:${CFG.port}`));
  setInterval(() => {
    sync().catch((e) => console.error('sync failed:', e.message));
  }, CFG.pollMs);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
