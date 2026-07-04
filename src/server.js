#!/usr/bin/env node
'use strict';
// Verginals web server: a zero-dependency HTTP API + static host for the inscribe/explore UI.
// It reuses the proven core: buildPlan/revealFromPlan + buildFundingTx (builder.js), the Indexer,
// and the Verge RPC layer (rpc.js). File uploads arrive as base64 inside JSON bodies.
//
//   node src/server.js                 # listens on :3400 (override with PORT)
//
// RPC creds: env VERGINALS_RPC_HOST/PORT/USER/PASS, else parsed from a VERGE.conf
// (VERGINALS_RPC_CONF, default ~/verge-testnet/.VERGE/VERGE.conf).
//
// Inscribe flow (PAYMENT REQUEST: pay from any Verge wallet, no node/extension needed):
//   1. POST /api/quote -> buildPlan with an ephemeral inscription key, mint an ephemeral P2PKH
//      "deposit" address, importaddress it watch-only, and return ONE payment request (address +
//      total + verge: URI). The server keeps both ephemeral keys; the user keeps their own wallet.
//   2. user pays the single total to the deposit address from their wallet (QR / verge: link).
//   3. GET /api/job/:id polls listunspent(0) on the deposit address. Once funded it builds and
//      broadcasts the funding/commit tx (deposit -> N P2SH commit outputs) then the reveal tx
//      (N commit outputs -> carrier at the user's destination), chaining on the unconfirmed commit.
// Confirmation happens naturally (the node mines it); /api/inscriptions indexes confirmed blocks.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const bitcoin = require('bitcoinjs-lib');
const { COIN } = require('./networks');
const { Indexer, decodeMetadata } = require('./indexer');
const { bufferToParentId, parentIdToBuffer } = require('./envelope');

/** Decode tag-3 parent claims (buffers) from a reveal into inscription-id strings, best-effort. */
function parentClaims(reveal) {
  return (reveal.parents || [])
    .map((b) => {
      try {
        return bufferToParentId(b);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}
const { RpcClient, VergeChain, extractRedeemScript, xvgToUnits } = require('./rpc');
const { buildPlan, revealFromPlan, inferContentType, pickNetwork } = require('./cli');
const { ECPair, buildFundingTx } = require('./builder');
const { MintController } = require('./mint');

const PORT = Number(process.env.PORT || 3400);
// Bind to loopback by default so a public deployment is reachable ONLY through the reverse proxy
// (which terminates HTTPS and forwards X-Forwarded-For). Binding to 0.0.0.0 would expose the app
// directly on PUBLIC_IP:PORT, bypassing HTTPS and the proxy-based rate limiting. Override with
// VERGINALS_HOST=0.0.0.0 only if you deliberately want the app reachable without a proxy.
const HOST = process.env.VERGINALS_HOST || '127.0.0.1';
const WEB_DIR = path.join(__dirname, '..', 'web');
// Persistent state root. Jobs hold THROWAWAY private keys and the mint state holds the fairness
// seed + inventory, neither may live in os.tmpdir(), which the OS purges (that once wiped jobs,
// i.e. private keys). Keep DATA_DIR on real disk and out of version control (see .gitignore).
const DATA_DIR = process.env.VERGINALS_DATA_DIR || path.join(__dirname, '..', 'data');
const JOB_DIR = path.join(DATA_DIR, 'jobs');
// Serve-blocklist: on-chain data is immutable, but we can refuse to *serve* flagged content from our
// own endpoints (e.g. after a valid CSAM/DMCA report). Edit <DATA_DIR>/blocklist.json to update live.
const { Blocklist } = require('./blocklist');
const blocklist = new Blocklist(process.env.VERGINALS_BLOCKLIST || path.join(DATA_DIR, 'blocklist.json'));
// Alpha Verginals collection (images/ + designs.json + metadata.json + collection_manifest.json).
// When present, the mint endpoints turn on; otherwise the server is inscribe/explore only.
const COLLECTION_DIR = process.env.VERGINALS_COLLECTION_DIR || path.join(__dirname, '..', 'verginals');
// Single source of truth for the chain this server operates on. It pins three things that MUST
// agree: the RPC backend we talk to, the addresses we generate, and the network /api/quote accepts.
// Defaults to mainnet; set VERGINALS_NETWORK=testnet to point at the dev testnet Docker node.
const NETWORK = (process.env.VERGINALS_NETWORK || 'mainnet') === 'testnet' ? 'testnet' : 'mainnet';
const INDEX_FROM = Number(process.env.VERGINALS_INDEX_FROM || (NETWORK === 'mainnet' ? 9290000 : 125800));
const MAX_BODY = 8 * 1024 * 1024; // 8 MB JSON cap

const toXVG = (units) => units / COIN;
const toUnits = (xvg) => Math.round(Number(xvg) * COIN);

// Optional operator service fee. It's added to the total the user pays and paid to YOUR address as
// an extra output of the funding tx. Hard-capped at 5 XVG and only active when BOTH a positive fee
// and a valid fee address (VERGINALS_FEE_ADDRESS) are configured; otherwise no fee is charged.
const SERVICE_FEE_CAP_XVG = 5;
const SERVICE_FEE_XVG = Math.min(SERVICE_FEE_CAP_XVG, Math.max(0, Number(process.env.VERGINALS_SERVICE_FEE_XVG || 0)));
const FEE_ADDRESS = (process.env.VERGINALS_FEE_ADDRESS || '').trim();
let SERVICE_FEE_UNITS = 0; // resolved at startup once we can validate the address for this network
function initServiceFee() {
  if (SERVICE_FEE_XVG <= 0 || !FEE_ADDRESS) return;
  try {
    bitcoin.address.toOutputScript(FEE_ADDRESS, pickNetwork(NETWORK).network);
    SERVICE_FEE_UNITS = toUnits(SERVICE_FEE_XVG);
  } catch (_) {
    console.warn(`VERGINALS_FEE_ADDRESS is not a valid ${NETWORK} address, service fee DISABLED`);
  }
}

// --- RPC credentials ---------------------------------------------------------------------

function loadRpcCreds() {
  let user = process.env.VERGINALS_RPC_USER;
  let pass = process.env.VERGINALS_RPC_PASS;
  const host = process.env.VERGINALS_RPC_HOST || '127.0.0.1';
  // Mainnet talks to the local Verge-Qt node (RPC on 20103 so it never clashes with the testnet
  // Docker node published on 20102); testnet keeps the original Docker defaults.
  const port = Number(process.env.VERGINALS_RPC_PORT || (NETWORK === 'mainnet' ? 20103 : 20102));
  if (!user || !pass) {
    const defaultConf =
      NETWORK === 'mainnet'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'VERGE', 'VERGE.conf')
        : path.join(os.homedir(), 'verge-testnet', '.VERGE', 'VERGE.conf');
    const conf = process.env.VERGINALS_RPC_CONF || defaultConf;
    try {
      const text = fs.readFileSync(conf, 'utf8');
      const grab = (k) => (text.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
      user = user || grab('rpcuser');
      pass = pass || grab('rpcpassword');
    } catch (_) {
      /* leave undefined; calls will fail with a clear RPC error */
    }
  }
  return { host, port, user, pass };
}

const creds = loadRpcCreds();
const client = new RpcClient(creds);
const chain = new VergeChain(client);

// --- job persistence (server-side; holds the ephemeral inscription + deposit WIFs) ---------
// A "job" is one payment-request lifecycle. It contains private keys for two THROWAWAY keys
// (the inscription reveal key and the deposit key that briefly receives the user's payment),
// never the user's own wallet keys. Keep these files off version control.

fs.mkdirSync(JOB_DIR, { recursive: true });

function saveJob(job) {
  fs.writeFileSync(path.join(JOB_DIR, job.id + '.json'), JSON.stringify(job));
}
function loadJob(id) {
  if (!/^[a-f0-9]{16,64}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(JOB_DIR, id + '.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// --- incremental indexer service ---------------------------------------------------------

const indexer = new Indexer();
let lastScanned = INDEX_FROM - 1;
let scanning = null; // promise mutex

async function syncIndex() {
  if (scanning) return scanning;
  scanning = (async () => {
    const tip = await chain.getBlockCount();
    for (let h = lastScanned + 1; h <= tip; h++) {
      indexer.processBlock(await chain.fetchDecodedBlock(h));
      lastScanned = h;
    }
    return tip;
  })();
  try {
    return await scanning;
  } finally {
    scanning = null;
  }
}

/**
 * Get a reveal tx in verbose form even when txindex isn't built yet. Mempool txs and (with
 * txindex) any tx resolve via plain getrawtransaction. For a CONFIRMED tx the node forgot
 * (no txindex), we ask the wallet: gettransaction knows the blockhash, and getrawtransaction
 * with an explicit blockhash reads it straight from that block. So the user's own inscriptions
 * (reveal tx pays their wallet → ismine) are always reachable, txindex or not.
 */
async function getRevealVerbose(txid) {
  try {
    return await chain.getRawTransaction(txid, true);
  } catch (_) {
    /* not in mempool and no txindex, try the wallet path below */
  }
  let wtx;
  try {
    wtx = await client.call('gettransaction', [txid]);
  } catch (_) {
    return null;
  }
  if (!wtx || !wtx.blockhash) return null;
  try {
    return await client.call('getrawtransaction', [txid, true, wtx.blockhash]);
  } catch (_) {
    return null;
  }
}

/** Fetch the inscription body straight from its reveal tx (scripts only; no value resolution). */
async function fetchInscriptionBody(txid) {
  const raw = await getRevealVerbose(txid);
  if (!raw) return null;
  const ins = raw.vin.map((vin) => ({ inscriptionScript: extractRedeemScript(vin.scriptSig) }));
  return Indexer.extractReveal({ ins }); // { contentType, body } | null
}

// --- HTTP helpers ------------------------------------------------------------------------

// Baseline security headers for every response (defence-in-depth; a public deployment should also
// sit behind HTTPS via a reverse proxy). Same-origin by default; the UI never calls cross-origin.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};
function writeHead(res, status, headers) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  writeHead(res, status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// 451 Unavailable For Legal Reasons: the item stays on-chain, but this instance refuses to serve it.
// no-store so that removing it from the blocklist takes effect immediately (never cached as blocked).
function send451(res) {
  writeHead(res, 451, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('451 Unavailable For Legal Reasons: this content has been blocked from being served by verginals.com. It remains permanently on the Verge blockchain and is outside our control.');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Modest CSP for the app shell: scripts/styles are same-origin files (no inline JS); the QR widget
// injects inline SVG, and images may be data: URIs (file previews), so allow those.
const HTML_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";

function serveStatic(res, file) {
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full)) {
    writeHead(res, 404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const ext = path.extname(full).toLowerCase();
  const headers = { 'content-type': STATIC_TYPES[ext] || 'application/octet-stream' };
  if (ext === '.html') headers['content-security-policy'] = HTML_CSP;
  writeHead(res, 200, headers);
  fs.createReadStream(full).pipe(res);
}

// --- API handlers ------------------------------------------------------------------------

async function handleInfo(res) {
  const tip = await chain.getBlockCount();
  sendJSON(res, 200, { network: NETWORK, tip, indexFrom: INDEX_FROM, indexedThrough: lastScanned });
}

/** Decode a request body's content (text or base64 file) into bytes + MIME + filename. */
function decodeContent(b) {
  let body, contentType, filename;
  if (b.kind === 'text') {
    if (typeof b.text !== 'string' || b.text.length === 0) throw new Error('text is required');
    body = Buffer.from(b.text, 'utf8');
    contentType = 'text/plain;charset=utf-8';
    filename = null;
  } else if (b.kind === 'file') {
    if (typeof b.dataBase64 !== 'string' || !b.dataBase64) throw new Error('dataBase64 is required');
    body = Buffer.from(b.dataBase64, 'base64');
    if (body.length === 0) throw new Error('decoded file is empty');
    filename = typeof b.filename === 'string' ? b.filename : 'file.bin';
    contentType = b.contentType || inferContentType(filename);
  } else {
    throw new Error('kind must be "text" or "file"');
  }
  return { body, contentType, filename };
}

// Fee suggestions (relayfee ~0.2 XVG/kB on testnet). A P2SH reveal input is ~600 bytes; the
// funding tx is 1 P2PKH input (~150 B) + N P2SH outputs (~32 B each) + ~12 B overhead.
const FEE_RATE_XVG_PER_KB = 0.2;
const feeForBytes = (bytes) => Math.max(0.2, Math.ceil(bytes / 1000) * FEE_RATE_XVG_PER_KB);
const suggestRevealFeeXVG = (numInputs) => feeForBytes(numInputs * 600);
const suggestSplitFeeXVG = (numInputs) => feeForBytes(150 + numInputs * 32 + 12);
// Minimum value (units) an output must hold to be spendable and safe to relay. The carrier that
// returns the inscription must clear this, otherwise the reveal can be rejected as dust or the
// inscription lands on a utxo too small to move later.
const DUST_UNITS = 100000; // 0.1 XVG

/** Derive the P2PKH address for a bitcoinjs network + ECPair. */
function p2pkhAddress(signer, network) {
  return bitcoin.payments.p2pkh({ pubkey: Buffer.from(signer.publicKey), network }).address;
}

const VALID_ADDR = /^[a-km-zA-HJ-NP-Z1-9]{25,40}$/; // base58 sanity check; node validates for real

/**
 * POST /api/quote: build a plan + deposit address and return a single payment request.
 * The user pays ONE total to the deposit address from their own Verge wallet; the server then
 * drives the commit + reveal when GET /api/job/:id sees the payment.
 */
// Lightweight per-IP rate limit for the expensive endpoint (each quote imports a watch-only
// address into the wallet, so a flood would bloat it). In-memory sliding window; for a real
// public deployment put a reverse proxy / WAF in front too.
const QUOTE_WINDOW_MS = Number(process.env.VERGINALS_QUOTE_WINDOW_MS || 60_000);
const QUOTE_MAX = Number(process.env.VERGINALS_QUOTE_MAX || 10);
const quoteHits = new Map(); // ip -> [timestamps]
// Behind a reverse proxy (nginx/Caddy) the socket peer is always 127.0.0.1, which would collapse
// every visitor into one rate-limit bucket. Only trust X-Forwarded-For when explicitly told we sit
// behind a proxy we control (VERGINALS_TRUST_PROXY=1); trusting it otherwise lets any client spoof
// their IP and evade the limit. The proxy must set: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
const TRUST_PROXY = process.env.VERGINALS_TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function allowQuote(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (quoteHits.get(ip) || []).filter((t) => now - t < QUOTE_WINDOW_MS);
  hits.push(now);
  quoteHits.set(ip, hits);
  if (quoteHits.size > 5000) quoteHits.clear(); // crude unbounded-growth guard
  return hits.length <= QUOTE_MAX;
}

/**
 * Validate a caller-supplied destination address for THIS network, or throw. Shared by /api/quote
 * and /api/mint so a wrong-network / malformed "to" is rejected before anything irreversible.
 */
function requireDestination(to, network) {
  if (!to) throw new Error('a destination Verge address ("to") is required');
  if (!VALID_ADDR.test(to)) throw new Error('destination address looks invalid');
  try {
    bitcoin.address.toOutputScript(to, network);
  } catch (_) {
    throw new Error(`destination is not a valid ${NETWORK} Verge address`);
  }
}

/**
 * Core of a payment request: build the inscription plan for `body`, mint an ephemeral watch-only
 * deposit address, persist a job, and return the client-facing payment request. Shared by the
 * free-form inscribe flow (/api/quote) and the Alpha Verginals mint (/api/mint). `mint` is attached
 * to the job (and drives confirmMinted on payout) when this is a collection mint. An explicit `id`
 * lets the mint reserve a collection number under the same job id before the plan is built.
 */
async function createPaymentJob({ id, body, contentType, filename, to, amountPerInput, networkName, network, mint, metadata, parent }) {
  const plan = buildPlan({ body, contentType, networkName, amount: amountPerInput, file: filename, metadata, parent });
  const numInputs = plan.inputs.length;
  const parented = parent != null;

  // Ephemeral deposit key (P2PKH). The node watches its address; the server holds the key only
  // long enough to consolidate the single payment into the commit outputs.
  const depositKey = ECPair.makeRandom({ network });
  const depositWif = depositKey.toWIF();
  const depositAddress = p2pkhAddress(depositKey, network);

  const splitFee = toUnits(suggestSplitFeeXVG(numInputs));
  // A parented reveal adds one P2PKH parent input (~150B) and one carry-forward output (~34B).
  const revealFee = toUnits(suggestRevealFeeXVG(numInputs) + (parented ? feeForBytes(150 + 34) : 0));
  const serviceFee = SERVICE_FEE_UNITS; // operator fee (0 unless configured); paid in the funding tx
  const commitTotal = amountPerInput * numInputs;
  const total = commitTotal + splitFee + serviceFee; // what the user must pay to the deposit address
  const carrier = commitTotal - revealFee; // returns to the user's destination (the inscription's home)
  if (carrier < DUST_UNITS) throw new Error('per-input amount too low: the returned inscription would be dust, raise it');

  await client.call('importaddress', [depositAddress, 'verginals:' + crypto.randomBytes(4).toString('hex'), false]);

  const jobId = id || crypto.randomBytes(16).toString('hex');
  const job = {
    id: jobId, status: 'awaiting_payment', createdAt: Date.now(),
    networkName, to, contentType, bodySize: body.length, numInputs,
    perInput: amountPerInput, splitFee, revealFee, serviceFee,
    feeAddress: serviceFee > 0 ? FEE_ADDRESS : null, total, carrier,
    depositAddress, depositWif, plan,
    splitTxid: null, revealTxid: null, location: null, error: null,
    mint: mint || null, // { number, name } when this job mints an Alpha Verginal
    // Parented mints spend the collection root's carrier in the reveal (spec §10). We record only
    // the marker + root id here; the operator's parent KEY lives in server config, never in job
    // files (it is a persistent secret, not a throwaway job key), and the live tip is resolved at
    // payout time from parent-tip.json / the chain index.
    parented: parented, parentId: parented ? PARENT_ID : null,
  };
  saveJob(job);

  const totalXVG = toXVG(total);
  const response = {
    jobId,
    network: plan.network,
    contentType, filename, bodySize: body.length, numInputs,
    depositAddress,
    totalXVG,
    paymentURI: `verge:${depositAddress}?amount=${totalXVG}&label=${mint ? 'AlphaVerginal-' + mint.number : 'Verginal'}`,
    to,
    breakdown: {
      commitXVG: toXVG(commitTotal),
      splitFeeXVG: toXVG(splitFee),
      revealFeeXVG: toXVG(revealFee),
      serviceFeeXVG: toXVG(serviceFee),
      carrierReturnedXVG: toXVG(carrier),
      netCostXVG: toXVG(splitFee + revealFee + serviceFee),
    },
  };
  return { job, response };
}

async function handleQuote(req, res) {
  if (!allowQuote(req)) return sendJSON(res, 429, { error: 'too many requests, please wait a minute' });
  const raw = await readBody(req);
  const b = JSON.parse(raw.toString('utf8') || '{}');
  const amountPerInput = toUnits(b.amountPerInputXVG != null ? b.amountPerInputXVG : 1);
  if (!(amountPerInput > 0)) throw new Error('amountPerInputXVG must be > 0');
  const to = typeof b.to === 'string' ? b.to.trim() : '';

  // This server is pinned to one network (NETWORK). Reject a mismatched client selection up front
  // rather than failing deep inside the payout after the user has already paid.
  const requested = b.network === 'mainnet' ? 'mainnet' : b.network === 'testnet' ? 'testnet' : NETWORK;
  if (requested !== NETWORK) {
    throw new Error(`this server is running on ${NETWORK}; it cannot inscribe on ${requested}`);
  }
  const networkName = NETWORK;
  const { network } = pickNetwork(networkName);
  requireDestination(to, network);

  const { body, contentType, filename } = decodeContent(b);
  const { response } = await createPaymentJob({ body, contentType, filename, to, amountPerInput, networkName, network });
  sendJSON(res, 200, response);
}

// --- Alpha Verginals mint --------------------------------------------------------------------
// A mint is just an inscription of one specific collection image, assigned in a committed-fair
// random order. It reuses the entire payment/inscription pipeline (same service fee, same job flow).
let mintCtl = null; // MintController when a collection is loaded, else null

// Default deposit sizing for a mint (per commit input, XVG). Enough to cover the reveal fee and
// leave a small carrier that returns to the minter as the inscription-bearing UTXO.
const MINT_PER_INPUT_XVG = Number(process.env.VERGINALS_MINT_PER_INPUT_XVG || 1);
// How long a reserved-but-unpaid number is held before the reaper vets it for release.
const MINT_RESERVE_TTL_MS = Number(process.env.VERGINALS_MINT_RESERVE_TTL_MS || 30 * 60 * 1000);

function initMint() {
  try {
    if (!fs.existsSync(path.join(COLLECTION_DIR, 'designs.json'))) {
      console.log('Mint: no collection found: mint endpoints disabled (set VERGINALS_COLLECTION_DIR)');
      return;
    }
    mintCtl = new MintController({ collectionDir: COLLECTION_DIR, dataDir: path.join(DATA_DIR, 'mint') }).load();
  } catch (e) {
    mintCtl = null;
    console.warn('Mint: failed to load collection: ' + e.message);
  }
}

// --- collection-parent (tag-3 membership) ----------------------------------------------------
// When a collection root is configured, every mint after it carries the root's inscription id in
// envelope tag 3 AND its reveal spends the root's carrier utxo, so membership is verifiable
// on-chain (spec §10). The operator holds the parent key persistently (unlike the throwaway job
// keys); the carrier is re-emitted, unchanged in value, to the same operator address each mint, so
// the tip never depletes. Mints serialize through a single parent utxo, so only ONE reveal may
// spend the tip at a time (see withParentLock). Parenting stays OFF unless BOTH the root id and its
// key are configured, in which case mints are "genesis" items (no tag 3), exactly as before.
const PARENT_ID = (process.env.VERGINALS_PARENT_ID || '').trim();
const PARENT_TIP_PATH = path.join(DATA_DIR, 'mint', 'parent-tip.json');
let parentCfg = null; // { id, wif, key, address, parentBuf } when parenting is enabled

function initParent() {
  // Load the operator's parent key FIRST, so its P2PKH carrier address is known even before the
  // root exists. Step A is a chicken-and-egg: you inscribe the root TO this address (so the operator
  // controls the carrier the mints will carry forward), but PARENT_ID only exists after that reveal.
  let wif = process.env.VERGINALS_PARENT_WIF;
  if (!wif) {
    try {
      wif = fs.readFileSync(path.join(DATA_DIR, 'mint', 'parent.wif'), 'utf8').trim();
    } catch (_) {
      /* no key file; handled below */
    }
  }
  let key = null;
  let address = null;
  if (wif) {
    try {
      const { network } = pickNetwork(NETWORK);
      key = ECPair.fromWIF(wif, network);
      address = p2pkhAddress(key, network);
    } catch (e) {
      console.warn('Parent: failed to load parent key: ' + e.message);
    }
  }

  if (!PARENT_ID) {
    console.log(
      'Parent: no VERGINALS_PARENT_ID set; mints are genesis items (no tag 3).' +
        (address ? ` To start a collection, inscribe the root manifest TO ${address}, then set VERGINALS_PARENT_ID=<rootTxid>i0.` : '')
    );
    return;
  }
  if (!/^[0-9a-fA-F]{64}i\d+$/.test(PARENT_ID)) {
    console.warn(`Parent: VERGINALS_PARENT_ID "${PARENT_ID}" is malformed; parenting DISABLED`);
    return;
  }
  if (!key) {
    console.warn('Parent: VERGINALS_PARENT_ID set but no parent key (VERGINALS_PARENT_WIF or data/mint/parent.wif); parenting DISABLED');
    return;
  }
  parentCfg = { id: PARENT_ID, wif, key, address, parentBuf: parentIdToBuffer(PARENT_ID) };
  console.log(`Parent: parenting ENABLED, root ${PARENT_ID}, carrier held at ${address}`);
}

function loadParentTip() {
  try {
    return JSON.parse(fs.readFileSync(PARENT_TIP_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}
function saveParentTip(tip) {
  fs.mkdirSync(path.dirname(PARENT_TIP_PATH), { recursive: true });
  fs.writeFileSync(PARENT_TIP_PATH, JSON.stringify(tip));
}

// Is an outpoint still spendable (present in the utxo set OR the mempool)? gettxout with the
// includeMempool flag returns null once it has been spent or never existed.
async function isUnspent(txid, vout) {
  try {
    const out = await client.call('gettxout', [txid, vout, true]);
    return out != null;
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the live parent tip to spend for the next mint, healing after a dropped/reorged reveal.
 * Priority: (1) the saved optimistic tip if it is still unspent (covers the fast unconfirmed
 * carry-forward chain the indexer hasn't caught up to); (2) the parent's current CONFIRMED location
 * from the chain index (authoritative after a reorg drops an unconfirmed tip); else null (the
 * operator must seed the tip once the root is inscribed). Value is resolved on-chain so it is exact.
 */
async function resolveParentTip() {
  if (!parentCfg) return null;
  const saved = loadParentTip();
  if (saved && (await isUnspent(saved.txid, saved.vout))) {
    const value = await chain.resolvePrevValue(saved.txid, saved.vout);
    return { txid: saved.txid, vout: saved.vout, value };
  }
  // Saved tip is gone (never seeded, or dropped by a reorg): fall back to the confirmed index.
  try {
    await syncIndex();
    const rec = indexer.inscriptions.get(parentCfg.id);
    if (rec && rec.location && rec.location !== 'burned') {
      const [txid, voutStr] = rec.location.split(':');
      const vout = Number(voutStr);
      if (await isUnspent(txid, vout)) {
        const value = await chain.resolvePrevValue(txid, vout);
        const healed = { txid, vout, value };
        saveParentTip(healed);
        return healed;
      }
    }
  } catch (_) {
    /* index not ready; caller handles a null tip */
  }
  return null;
}

// Serialize parent-spending reveals: only one reveal may consume/advance the single parent tip at a
// time, so concurrent mints can't both spend it (which would make one reveal a double-spend).
let parentLock = Promise.resolve();
function withParentLock(fn) {
  const run = parentLock.then(fn, fn);
  parentLock = run.then(() => {}, () => {});
  return run;
}

async function handleMintStatus(res) {
  if (!mintCtl) return sendJSON(res, 200, { enabled: false });
  sendJSON(res, 200, Object.assign(
    { enabled: true, parented: !!parentCfg, parentId: parentCfg ? parentCfg.id : null },
    mintCtl.status()
  ));
}

/** POST /api/mint { to }: reserve the next fair-order Verginal and return its payment request. */
async function handleMint(req, res) {
  if (!mintCtl) return sendJSON(res, 404, { error: 'minting is not enabled on this server' });
  if (!allowQuote(req)) return sendJSON(res, 429, { error: 'too many requests, please wait a minute' });
  const raw = await readBody(req);
  const b = JSON.parse(raw.toString('utf8') || '{}');
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  const { network } = pickNetwork(NETWORK);
  requireDestination(to, network);

  // Reserve a number FIRST (its image size fixes the plan/fees), then build the payment job under
  // the same job id so the reaper can tie an unpaid reservation back to its deposit.
  const jobId = crypto.randomBytes(16).toString('hex');
  const assignment = mintCtl.reserve(jobId);
  if (!assignment) return sendJSON(res, 200, Object.assign({ soldOut: true }, mintCtl.status()));

  try {
    const body = fs.readFileSync(mintCtl.imagePath(assignment.number));
    const contentType = mintCtl.manifest.media_type || 'image/webp';
    // Inscribe each Alpha's traits on-chain as ord tag-5 CBOR metadata, so the image and its
    // attributes travel together permanently and generic ordinals explorers can render them.
    const metadata = mintCtl.metadataCbor(assignment.number);
    const { response } = await createPaymentJob({
      id: jobId, body, contentType, filename: assignment.filename, to,
      amountPerInput: toUnits(MINT_PER_INPUT_XVG), networkName: NETWORK, network,
      mint: { number: assignment.number, name: assignment.name }, metadata,
      // Bind the mint to the collection root when parenting is enabled (else a genesis item).
      parent: parentCfg ? parentCfg.parentBuf : undefined,
    });
    sendJSON(res, 200, Object.assign(response, {
      verginal: {
        number: assignment.number,
        name: assignment.name,
        house: assignment.house,
        attributes: assignment.attributes,
        imageUrl: `/api/collection/image/${assignment.number}`,
      },
      commitment: mintCtl.commitment,
      status: mintCtl.status(),
    }));
  } catch (e) {
    mintCtl.release(assignment.number); // roll the reservation back if the job couldn't be built
    throw e;
  }
}

/** GET /api/collection/image/:n, serve a collection image locally (reveal preview before/at mint). */
function handleCollectionImage(res, nStr) {
  if (!mintCtl) return (writeHead(res, 404, { 'content-type': 'text/plain' }), res.end('minting disabled'));
  const n = Number(nStr);
  if (Number.isInteger(n) && blocklist.isNumberBlocked(n)) return send451(res);
  const file = Number.isInteger(n) ? mintCtl.imagePath(n) : null;
  if (!file || !fs.existsSync(file)) return (writeHead(res, 404, { 'content-type': 'text/plain' }), res.end('no such verginal'));
  writeHead(res, 200, {
    'content-type': mintCtl.manifest.media_type || 'image/webp',
    'cache-control': 'public, max-age=31536000',
  });
  fs.createReadStream(file).pipe(res);
}

/**
 * Release reservations that have gone stale AND whose deposit never received the payment. Only the
 * server can check funding, so the pure controller defers to this. Funded-but-not-yet-driven jobs
 * are left alone (they'll complete); genuinely abandoned ones return their number to the pool.
 */
async function reapMintReservations() {
  if (!mintCtl) return;
  for (const { number, jobId } of mintCtl.staleReservations(MINT_RESERVE_TTL_MS)) {
    const job = loadJob(jobId);
    if (!job) {
      mintCtl.release(number);
      continue;
    }
    if (job.status === 'done') continue; // already minted (confirmMinted should have cleared it)
    try {
      const utxos = await client.call('listunspent', [0, 9999999, [job.depositAddress]]);
      const received = utxos.reduce((s, u) => s + toUnits(u.amount), 0);
      if (received < job.total) mintCtl.release(number); // truly unpaid → free the number
    } catch (_) {
      /* leave it; retry next cycle */
    }
  }
}

// Per-job processing mutex so concurrent polls don't double-broadcast the commit/reveal.
const processing = new Set();

/**
 * GET /api/job/:id, poll a payment request. Detects the deposit payment (0-conf) and, once
 * funded, builds + broadcasts the commit (funding) tx then the reveal tx.
 */
async function handleJob(res, id) {
  const job = loadJob(id);
  if (!job) return sendJSON(res, 404, { error: 'unknown or expired job' });
  if (job.status === 'done' || job.status === 'error') {
    return sendJSON(res, 200, jobView(job));
  }
  if (processing.has(id)) return sendJSON(res, 200, { ...jobView(job), status: 'funding' });

  // Look for the user's payment (including unconfirmed) to the deposit address.
  const utxos = await client.call('listunspent', [0, 9999999, [job.depositAddress]]);
  const received = utxos.reduce((s, u) => s + toUnits(u.amount), 0);
  if (received < job.total) {
    return sendJSON(res, 200, { ...jobView(job), receivedXVG: toXVG(received), requiredXVG: toXVG(job.total) });
  }

  processing.add(id);
  try {
    await drivePayout(job, utxos);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    saveJob(job);
  } finally {
    processing.delete(id);
  }
  return sendJSON(res, 200, jobView(job));
}

/** Build + broadcast the commit (funding) tx, then the reveal tx, mutating + persisting `job`. */
async function drivePayout(job, depositUtxos) {
  const { network } = pickNetwork(job.networkName);
  const depositKey = ECPair.fromWIF(job.depositWif, network);
  const depositTotal = depositUtxos.reduce((s, u) => s + toUnits(u.amount), 0);

  // 1) Commit/funding tx: spend the deposit UTXO(s) into the N P2SH commit outputs (+ the operator
  //    service-fee output, if configured). The implicit remainder is the miner fee (= splitFee).
  const commitOutputs = job.plan.inputs.map((inp) => ({ address: inp.address, value: job.perInput }));
  if (job.serviceFee > 0 && job.feeAddress) {
    commitOutputs.push({ address: job.feeAddress, value: job.serviceFee });
  }
  const fundingFee = depositTotal - job.perInput * job.numInputs - (job.serviceFee || 0); // implicit remainder
  if (fundingFee < 0) throw new Error('insufficient deposit to cover commit outputs');
  const funding = buildFundingTx({
    network,
    inputs: depositUtxos.map((u) => ({ txid: u.txid, vout: u.vout, value: toUnits(u.amount) })),
    outputs: commitOutputs,
    signer: depositKey,
  });
  job.splitTxid = await chain.sendRawTransaction(funding.hex);

  // 2) Reveal tx: spend the (unconfirmed) commit outputs into the carrier at the user's address.
  const revealUtxos = job.plan.inputs.map((_, i) => `${job.splitTxid}:${i}`);
  const values = job.plan.inputs.map(() => job.perInput);

  if (job.parented && parentCfg) {
    // Parented mint: append the collection root's carrier as the last reveal input and re-emit it
    // as output 1, so membership is verifiable on-chain (spec §10). Only one reveal may spend the
    // single parent tip at a time, so serialize the tip read + broadcast + advance under the lock.
    await withParentLock(async () => {
      const tip = await resolveParentTip();
      if (!tip) throw new Error('parent tip unavailable (root not inscribed or index not ready); cannot mint a parented item yet');
      const reveal = revealFromPlan({
        plan: job.plan, utxos: revealUtxos, to: job.to, fee: job.revealFee, values,
        parent: { txid: tip.txid, vout: tip.vout, value: tip.value, wif: parentCfg.wif, address: parentCfg.address },
      });
      job.revealTxid = await chain.sendRawTransaction(reveal.hex);
      // Advance the tip only after the broadcast is accepted, so a rejected reveal leaves the tip
      // untouched for the next mint (and the reconciler) to reuse.
      saveParentTip(reveal.parentOut); // { txid: revealTxid, vout: 1, value: tip.value }
    });
  } else {
    const reveal = revealFromPlan({ plan: job.plan, utxos: revealUtxos, to: job.to, fee: job.revealFee, values });
    job.revealTxid = await chain.sendRawTransaction(reveal.hex);
  }
  job.location = `${job.revealTxid}:0`;
  job.status = 'done';
  saveJob(job);

  // If this was an Alpha Verginals mint, lock the number in as permanently minted now that the
  // reveal is broadcast (moves it out of the reserved pool so it can never be assigned again).
  if (job.mint && mintCtl) {
    try {
      mintCtl.confirmMinted(job.mint.number, { revealTxid: job.revealTxid, owner: job.to });
    } catch (_) {
      /* non-fatal: the inscription is already on-chain; state will reconcile from the index */
    }
  }
}

/** Public view of a job (never leaks the private keys). */
function jobView(job) {
  return {
    jobId: job.id,
    status: job.status,
    contentType: job.contentType,
    bodySize: job.bodySize,
    numInputs: job.numInputs,
    to: job.to,
    depositAddress: job.depositAddress,
    totalXVG: toXVG(job.total),
    splitTxid: job.splitTxid,
    revealTxid: job.revealTxid,
    location: job.location,
    carrierReturnedXVG: toXVG(job.carrier),
    serviceFeeXVG: toXVG(job.serviceFee || 0),
    netCostXVG: toXVG(job.splitFee + job.revealFee + (job.serviceFee || 0)),
    error: job.error,
  };
}

/**
 * Scan the mempool for inscription reveals that haven't been mined yet, so a fresh inscription
 * shows up as "pending" the instant it's broadcast (before any block confirms it). Works without
 * txindex; mempool txs are always queryable. `confirmedTxids` skips ones already indexed.
 */
async function mempoolInscriptions(confirmedTxids) {
  let txids;
  try {
    txids = await client.call('getrawmempool', []);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const txid of txids.slice(0, 200)) {
    if (confirmedTxids.has(txid)) continue;
    let raw;
    try {
      raw = await chain.getRawTransaction(txid, true);
    } catch (_) {
      continue;
    }
    const ins = raw.vin.map((v) => ({ inscriptionScript: extractRedeemScript(v.scriptSig) }));
    const reveal = Indexer.extractReveal({ ins });
    if (!reveal) continue;
    const spk = raw.vout && raw.vout[0] && raw.vout[0].scriptPubKey;
    out.push({
      number: null, // unnumbered until mined (ordinal numbers come from confirmed block order)
      id: txid + 'i0',
      contentType: reveal.contentType ? reveal.contentType.toString('utf8') : null,
      metadata: decodeMetadata(reveal.metadata),
      parents: parentClaims(reveal), // raw tag-3 claims; verification needs the confirmed index
      parent: null, // not yet verifiable until mined and indexed
      children: [],
      bodySize: reveal.body.length,
      bodyHash: null,
      genesisHeight: null,
      location: txid + ':0',
      ownerAddress: spk ? spk.address || (spk.addresses && spk.addresses[0]) || null : null,
      txid,
      confirmations: 0,
      status: 'pending',
    });
  }
  return out;
}

/**
 * Inscriptions the user created through this server, reconstructed from the job files on disk.
 * The reveal tx pays the user's own wallet, so gettransaction reports live confirmations WITHOUT
 * txindex, these show up immediately even while the full-chain index is still building. Each
 * txid already covered by `skipTxids` (the chain index) is skipped to avoid duplicates.
 */
async function myInscriptions(skipTxids, tip) {
  const out = [];
  const seen = new Set();
  let files;
  try {
    files = fs.readdirSync(JOB_DIR).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return out;
  }
  for (const f of files) {
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), 'utf8'));
    } catch (_) {
      continue;
    }
    if (!job || job.status !== 'done' || job.networkName !== NETWORK) continue;
    const txid = job.revealTxid;
    if (!txid || seen.has(txid) || skipTxids.has(txid)) continue;
    seen.add(txid);
    let confirmations = 0;
    let height = null;
    try {
      const wtx = await client.call('gettransaction', [txid]);
      confirmations = Math.max(0, Number(wtx.confirmations) || 0);
      // Verge's gettransaction omits blockheight; derive it from the tip when confirmed.
      if (wtx.blockheight != null) height = wtx.blockheight;
      else if (confirmations > 0 && tip != null) height = tip - confirmations + 1;
    } catch (_) {
      /* wallet doesn't know it (yet), still surface it from the job data as pending */
    }
    // Recover on-chain metadata (traits) from the job's own redeemScripts, so an operator sees the
    // same tag-5 data on a pending mint that everyone else will see once it is mined.
    let jobMeta = [];
    let jobParents = [];
    try {
      const ins = (job.plan.inputs || []).map((i) => ({ inscriptionScript: Buffer.from(i.redeemScript, 'hex') }));
      const rv = Indexer.extractReveal({ ins });
      if (rv) {
        jobMeta = decodeMetadata(rv.metadata);
        jobParents = parentClaims(rv);
      }
    } catch (_) {
      /* malformed/absent plan: leave metadata empty */
    }
    out.push({
      number: null, // ordinal numbers come from the confirmed chain index
      id: txid + 'i0',
      contentType: job.contentType || null,
      metadata: jobMeta,
      parents: jobParents, // raw tag-3 claims; verification needs the confirmed index
      parent: null,
      children: [],
      bodySize: job.bodySize != null ? job.bodySize : null,
      bodyHash: null,
      genesisHeight: height,
      location: job.location || txid + ':0',
      ownerAddress: job.to || null, // the carrier output (vout 0) is the user's destination
      txid,
      confirmations,
      status: confirmations > 0 ? 'confirmed' : 'pending',
      mine: true,
    });
  }
  return out;
}

// The full inscription list is the SAME for every visitor, so build it once and cache it rather
// than re-scanning the chain + mempool on each request (a public deployment would otherwise hammer
// the node). Concurrent requests coalesce onto a single in-flight build; stale data is served
// immediately while a refresh runs in the background.
const INSCRIPTIONS_TTL = Number(process.env.VERGINALS_CACHE_MS || 10_000);
// Operator's own job files are a pre-index buffer (they surface inscriptions this server just made,
// before txindex reaches them). They're operator-centric: gettransaction only reports confirmations
// for destinations this node's wallet owns, so they're OFF by default for a public deployment.
const SHOW_OPERATOR_JOBS = process.env.VERGINALS_SHOW_JOBS === '1';
let inscriptionsCache = null; // { at, payload }
let inscriptionsBuilding = null;

async function buildInscriptionsPayload() {
  const tip = await chain.getBlockCount();
  // Source of truth = the full-chain index (every inscriber). Needs txindex; tolerate it not being
  // built yet so mempool reveals (and, for the operator, job-file entries) still render.
  let confirmed = [];
  let indexReady = true;
  try {
    await syncIndex();
    confirmed = indexer.list().map((i) => ({
      number: i.number,
      id: i.id,
      contentType: i.contentType,
      metadata: i.metadata || [],
      parents: i.parents || [], // every tag-3 claim (verified or not)
      parent: i.parent || null, // effective (verified) collection parent
      children: i.children || [], // verified child inscription ids
      bodySize: i.bodySize,
      bodyHash: i.bodyHash,
      genesisHeight: i.genesisHeight,
      location: i.location,
      ownerAddress: i.ownerAddress || null,
      txid: i.id.replace(/i0$/, ''),
      confirmations: Math.max(1, tip - i.genesisHeight + 1),
      status: 'confirmed',
      mine: false,
    }));
  } catch (_) {
    indexReady = false; // txindex still catching up
  }
  const known = new Set(confirmed.map((c) => c.txid));
  let mine = [];
  if (SHOW_OPERATOR_JOBS) {
    mine = await myInscriptions(known, tip);
    mine.forEach((m) => known.add(m.txid));
  }
  const pending = await mempoolInscriptions(known);
  const list = confirmed.concat(mine, pending);
  const pendingCount = list.filter((i) => i.status === 'pending').length;
  return {
    indexFrom: INDEX_FROM,
    indexedThrough: lastScanned,
    tip,
    indexReady,
    count: list.length,
    confirmedCount: list.length - pendingCount,
    pendingCount,
    inscriptions: list,
  };
}

async function getInscriptionsPayload() {
  const fresh = inscriptionsCache && Date.now() - inscriptionsCache.at < INSCRIPTIONS_TTL;
  if (fresh) return inscriptionsCache.payload;
  if (!inscriptionsBuilding) {
    inscriptionsBuilding = buildInscriptionsPayload()
      .then((payload) => {
        inscriptionsCache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inscriptionsBuilding = null;
      });
  }
  // Serve stale immediately if we have any; otherwise wait for the first build.
  if (inscriptionsCache) return inscriptionsCache.payload;
  return inscriptionsBuilding;
}

/** Re-shape a payload to only the inscriptions currently held by one of `owners` (comma list). */
function filterByOwner(payload, ownerParam) {
  const owners = new Set(
    String(ownerParam)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!owners.size) return payload;
  const inscriptions = payload.inscriptions.filter((i) => i.ownerAddress && owners.has(i.ownerAddress));
  const pendingCount = inscriptions.filter((i) => i.status === 'pending').length;
  return {
    ...payload,
    owner: [...owners],
    count: inscriptions.length,
    confirmedCount: inscriptions.length - pendingCount,
    pendingCount,
    inscriptions,
  };
}

async function handleInscriptions(res, owner) {
  const payload = await getInscriptionsPayload();
  sendJSON(res, 200, owner ? filterByOwner(payload, owner) : payload);
}

async function handleContent(res, txid) {
  if (!/^[a-f0-9]{64}$/.test(txid)) {
    writeHead(res, 400, { 'content-type': 'text/plain' });
    return res.end('bad txid');
  }
  // Cheapest check first: a flagged txid is refused before we even fetch it from the chain.
  if (blocklist.isTxidBlocked(txid)) return send451(res);
  const reveal = await fetchInscriptionBody(txid);
  if (!reveal) {
    writeHead(res, 404, { 'content-type': 'text/plain' });
    return res.end('no inscription in tx');
  }
  // Content-hash check: blocks the same flagged bytes wherever they were inscribed, not just one tx.
  const bodyHash = crypto.createHash('sha256').update(reveal.body).digest('hex');
  if (blocklist.isHashBlocked(bodyHash)) return send451(res);
  // The inscribed content-type is attacker-chosen bytes. Keep only characters valid in a MIME type
  // and cap the length so it can never smuggle control chars into the response header (defence in
  // depth; Node already rejects CR/LF) or bloat it. Fall back to octet-stream if nothing usable.
  const rawCt = reveal.contentType ? reveal.contentType.toString('utf8') : '';
  const ct = (rawCt.replace(/[^\w.+/;=\- ]/g, '').trim().slice(0, 150)) || 'application/octet-stream';
  // Inscribed content is UNTRUSTED and its type is attacker-chosen (e.g. text/html with a script).
  // Sandbox it so the browser can't execute it as active content in our origin, and nosniff so it
  // can't be reinterpreted. This mirrors how GitHub serves user content from an isolated context.
  writeHead(res, 200, {
    'content-type': ct,
    'cache-control': 'public, max-age=31536000',
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
    'content-disposition': 'inline',
  });
  res.end(reveal.body);
}

// --- wallet API (browser-extension backend) ----------------------------------------------
// This Verge node (v0.17) has no scantxoutset and no address index, so there is no way to ask
// "what UTXOs does an arbitrary address have" out of the box. Instead we track a wallet's address
// as watch-only (importaddress with rescan=false = instant for a freshly created address that has
// no history) and then serve its coins via listunspent. Addresses with pre-existing history would
// need a one-time rescan; that is a deliberate, separate action, not this fast path.

/** Build "txid:vout" -> {id, contentType, number} from the indexer's confirmed inscriptions. */
function inscriptionLocationMap() {
  const map = new Map();
  for (const i of indexer.list()) {
    if (i.location && i.location.includes(':')) {
      map.set(i.location, { id: i.id, contentType: i.contentType, number: i.number });
    }
  }
  return map;
}

/**
 * POST /api/inscriptions/at { outpoints: ["txid:vout", ...] } -> for each outpoint that currently
 * holds a Verginal, return { id, number, contentType }. Read-only overlay used by the light wallet
 * (which fetches its UTXOs from ElectrumX, not from this node) so it can flag which coins carry an
 * inscription and must never be auto-spent for fee/change. No node RPC, no address tracking: this
 * only consults the in-memory indexer by outpoint.
 */
async function handleInscriptionsAt(req, res) {
  if (!allowQuote(req)) return sendJSON(res, 429, { error: 'too many requests, please wait a minute' });
  const raw = await readBody(req);
  let b;
  try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  const outpoints = Array.isArray(b.outpoints) ? b.outpoints : [];
  if (outpoints.length > 500) return sendJSON(res, 400, { error: 'too many outpoints (max 500)' });
  const locs = inscriptionLocationMap();
  const found = {};
  for (const op of outpoints) {
    if (typeof op !== 'string' || !/^[0-9a-fA-F]{64}:\d+$/.test(op)) continue;
    const hit = locs.get(op);
    if (hit) found[op] = hit;
  }
  return sendJSON(res, 200, { inscriptions: found });
}

/** POST /api/wallet/watch {address} -> import the address watch-only (no rescan). */
async function handleWalletWatch(req, res) {
  if (!allowQuote(req)) return sendJSON(res, 429, { error: 'too many requests, please wait a minute' });
  const raw = await readBody(req);
  const b = JSON.parse(raw.toString('utf8') || '{}');
  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!VALID_ADDR.test(address)) return sendJSON(res, 400, { error: 'invalid address' });
  try {
    await client.call('importaddress', [address, 'wallet:' + address.slice(0, 8), false]);
    return sendJSON(res, 200, { watched: true, address });
  } catch (e) {
    // Idempotent: an address the node already knows (own key, or already watched) is fine.
    if (/already (contains|have|imported)|code -4/i.test(e.message)) {
      return sendJSON(res, 200, { watched: true, address, alreadyKnown: true });
    }
    return sendJSON(res, 400, { error: e.message });
  }
}

/** GET /api/wallet/utxos?address=... -> spendable coins, each flagged if it carries a Verginal. */
async function handleWalletUtxos(res, address) {
  if (!VALID_ADDR.test(address)) return sendJSON(res, 400, { error: 'invalid address' });
  try {
    const utxos = await client.call('listunspent', [0, 9999999, [address]]);
    const locs = inscriptionLocationMap();
    let total = 0;
    const out = utxos.map((u) => {
      const units = xvgToUnits(u.amount);
      total += units;
      return {
        txid: u.txid,
        vout: u.vout,
        value: units,
        confirmations: u.confirmations,
        // A UTXO that carries a Verginal must NEVER be auto-spent for fee/change by the wallet.
        inscription: locs.get(`${u.txid}:${u.vout}`) || null,
      };
    });
    return sendJSON(res, 200, { address, total, utxos: out });
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
}

/** POST /api/wallet/broadcast {rawtx} -> mempool-accept check, then relay. */
async function handleWalletBroadcast(req, res) {
  if (!allowQuote(req)) return sendJSON(res, 429, { error: 'too many requests, please wait a minute' });
  const raw = await readBody(req);
  const b = JSON.parse(raw.toString('utf8') || '{}');
  const rawtx = typeof b.rawtx === 'string' ? b.rawtx.trim() : '';
  if (!/^[0-9a-fA-F]{40,}$/.test(rawtx)) return sendJSON(res, 400, { error: 'invalid rawtx hex' });
  try {
    const test = await client.call('testmempoolaccept', [[rawtx]]);
    const r = Array.isArray(test) ? test[0] : null;
    if (!r || !r.allowed) {
      const reason = (r && (r['reject-reason'] || r.rejectReason)) || 'not accepted';
      return sendJSON(res, 400, { error: 'rejected: ' + reason });
    }
    const txid = await client.call('sendrawtransaction', [rawtx]);
    return sendJSON(res, 200, { txid });
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
}

// --- router ------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && (p === '/privacy' || p === '/privacy.html')) return serveStatic(res, 'privacy.html');
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) return serveStatic(res, p.slice(1));
    if (req.method === 'GET' && p === '/vendor/qrcode.js') return serveStatic(res, 'vendor/qrcode.js');
    if (req.method === 'GET' && (p === '/favicon.svg' || p === '/favicon.ico')) return serveStatic(res, 'favicon.svg');
    if (req.method === 'GET' && p === '/api/info') return await handleInfo(res);
    if (req.method === 'POST' && p === '/api/quote') return await handleQuote(req, res);
    if (req.method === 'POST' && p === '/api/mint') return await handleMint(req, res);
    if (req.method === 'GET' && p === '/api/mint/status') return await handleMintStatus(res);
    if (req.method === 'GET' && p.startsWith('/api/collection/image/')) return handleCollectionImage(res, p.slice('/api/collection/image/'.length));
    if (req.method === 'GET' && p.startsWith('/api/job/')) return await handleJob(res, p.slice('/api/job/'.length));
    if (req.method === 'GET' && p === '/api/inscriptions') return await handleInscriptions(res, url.searchParams.get('owner'));
    if (req.method === 'GET' && p.startsWith('/api/content/')) return await handleContent(res, p.slice('/api/content/'.length));
    if (req.method === 'POST' && p === '/api/inscriptions/at') return await handleInscriptionsAt(req, res);
    if (req.method === 'POST' && p === '/api/wallet/watch') return await handleWalletWatch(req, res);
    if (req.method === 'GET' && p === '/api/wallet/utxos') return await handleWalletUtxos(res, url.searchParams.get('address') || '');
    if (req.method === 'POST' && p === '/api/wallet/broadcast') return await handleWalletBroadcast(req, res);
    writeHead(res, 404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

// Job files hold ephemeral (throwaway) keys and the uploaded content; prune old ones so a busy
// public server doesn't accumulate them forever. Paid/failed jobs are short-lived; still-awaiting
// jobs are kept much longer because deleting one whose deposit key could still receive a late
// payment would strand those funds.
const JOB_DONE_TTL_MS = Number(process.env.VERGINALS_JOB_TTL_MS || 7 * 24 * 3600 * 1000);
const JOB_AWAIT_TTL_MS = Number(process.env.VERGINALS_JOB_AWAIT_TTL_MS || 30 * 24 * 3600 * 1000);
function cleanupJobs() {
  let files;
  try {
    files = fs.readdirSync(JOB_DIR);
  } catch (_) {
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(JOB_DIR, f);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_) {
      continue;
    }
    const ttl = job.status === 'done' || job.status === 'error' ? JOB_DONE_TTL_MS : JOB_AWAIT_TTL_MS;
    if (now - (job.createdAt || 0) > ttl) {
      try {
        fs.unlinkSync(full);
        removed++;
      } catch (_) {
        /* ignore */
      }
    }
  }
  if (removed) console.log(`cleanup: removed ${removed} expired job file(s)`);
}

initServiceFee();
initMint();
initParent();

server.listen(PORT, HOST, () => {
  console.log(`Verginals web UI  →  http://${HOST}:${PORT}`);
  console.log(`Network ${NETWORK.toUpperCase()}  (set VERGINALS_NETWORK=testnet for the dev node)`);
  console.log(`RPC ${creds.host}:${creds.port}  user=${creds.user ? creds.user : '(none)'}`);
  console.log(`Data dir ${DATA_DIR}`);
  console.log(`Indexing inscriptions from height ${INDEX_FROM} (set VERGINALS_INDEX_FROM to change)`);
  console.log(
    SERVICE_FEE_UNITS > 0
      ? `Service fee ${toXVG(SERVICE_FEE_UNITS)} XVG → ${FEE_ADDRESS}`
      : 'Service fee disabled (set VERGINALS_SERVICE_FEE_XVG + VERGINALS_FEE_ADDRESS to enable, ≤ 5 XVG)',
  );
  console.log(
    mintCtl
      ? `Mint ${mintCtl.manifest.name}: ${mintCtl.mintedCount()}/${mintCtl.supply} minted · commitment ${mintCtl.commitment.slice(0, 16)}…`
      : 'Mint disabled (no collection loaded)',
  );
  cleanupJobs();
  setInterval(cleanupJobs, 3600 * 1000).unref();
  reapMintReservations();
  setInterval(reapMintReservations, 5 * 60 * 1000).unref();
});
