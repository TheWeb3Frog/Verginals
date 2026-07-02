// Verge RPC layer: turns real chain data into the node-agnostic shape src/indexer.js eats.
// Two halves, kept apart on purpose (mirrors the pure/IO split the rest of the project uses):
//   1. Pure decoders (xvgToUnits, extractRedeemScript, decodeTx, decodeBlock), no network,
//      fully unit-testable against fixture JSON.
//   2. RpcClient (JSON-RPC over HTTP) + VergeChain (fetch + prevout resolution + caching).
//
// Verge Core must run with `txindex=1` and `server=1` (RPC on 20102 mainnet / per networks.js).
// getblock verbosity=2 gives full vin/vout but NOT input amounts, so VergeChain resolves each
// prevout's value via getrawtransaction (cached by outpoint).

const http = require('http');
const { COIN } = require('./networks');

// --- pure decoders -----------------------------------------------------------------------

/**
 * Convert an RPC amount (XVG as a JSON number, ≤6 decimals) to atomic units (1e-6 XVG).
 * Note: the indexer does offset math in JS numbers, so values above ~9e9 XVG (after ×COIN
 * they pass 2^53) lose precision. That ceiling is far above any realistic carrier output;
 * full-supply ordinal numbering (spec §7) would need BigInt and is out of scope for v0.
 */
function xvgToUnits(value) {
  return Math.round(Number(value) * COIN);
}

/**
 * Pull the redeemScript out of a P2SH input's scriptSig. A P2SH spend's scriptSig is push-only,
 * ending with the redeemScript as its last pushed element ([...args, redeemScript]). We return
 * that last data push. Returns null for an empty/absent scriptSig. A non-P2SH scriptSig (e.g.
 * P2PKH's [sig, pubkey]) returns its last item harmlessly: parseInscriptionScript finds no
 * envelope. `scriptSig` is the verbose-RPC `{ hex }` form.
 */
function extractRedeemScript(scriptSig) {
  const hex = scriptSig && typeof scriptSig.hex === 'string' ? scriptSig.hex : null;
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  let i = 0;
  let last = null;
  while (i < buf.length) {
    const op = buf[i];
    if (op === 0x00) {
      last = Buffer.alloc(0);
      i += 1;
    } else if (op <= 0x4b) {
      last = buf.subarray(i + 1, i + 1 + op);
      i += 1 + op;
    } else if (op === 0x4c) {
      const len = buf[i + 1];
      last = buf.subarray(i + 2, i + 2 + len);
      i += 2 + len;
    } else if (op === 0x4d) {
      const len = buf[i + 1] | (buf[i + 2] << 8);
      last = buf.subarray(i + 3, i + 3 + len);
      i += 3 + len;
    } else if (op === 0x4e) {
      const len = buf.readUInt32LE(i + 1);
      last = buf.subarray(i + 5, i + 5 + len);
      i += 5 + len;
    } else {
      i += 1; // non-push opcode (not expected in a push-only scriptSig)
    }
  }
  return last && last.length ? last : null;
}

/**
 * Decode one verbose RPC transaction into the indexer shape:
 *   { txid, ins: [{ txid, vout, value, inscriptionScript }], outs: [{ value }] }
 * Coinbase inputs are skipped (no prevout, carry no inscription). `prevValues` maps
 * "txid:vout" → atomic units for every non-coinbase input.
 */
function decodeTx(tx, prevValues) {
  const ins = [];
  for (const vin of tx.vin) {
    if (vin.coinbase !== undefined) continue;
    const key = `${vin.txid}:${vin.vout}`;
    const value = prevValues.get(key);
    if (value === undefined) {
      throw new Error(`missing prevout value for ${key} (input of ${tx.txid})`);
    }
    ins.push({
      txid: vin.txid,
      vout: vin.vout,
      value,
      inscriptionScript: extractRedeemScript(vin.scriptSig),
    });
  }
  const outs = tx.vout.map((o) => ({ value: xvgToUnits(o.value), address: addressOf(o.scriptPubKey) }));
  return { txid: tx.txid, ins, outs };
}

/** Best-effort owner address of an output from its verbose scriptPubKey (null if undecodable). */
function addressOf(scriptPubKey) {
  if (!scriptPubKey) return null;
  if (typeof scriptPubKey.address === 'string') return scriptPubKey.address;
  if (Array.isArray(scriptPubKey.addresses) && scriptPubKey.addresses.length) return scriptPubKey.addresses[0];
  return null;
}

/** Every prevout a verbose block needs resolved (deduplicated, coinbase excluded). */
function prevoutRefs(block) {
  const seen = new Set();
  const refs = [];
  for (const tx of block.tx) {
    for (const vin of tx.vin) {
      if (vin.coinbase !== undefined) continue;
      const key = `${vin.txid}:${vin.vout}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ txid: vin.txid, vout: vin.vout, key });
    }
  }
  return refs;
}

/** Decode a verbose block into { height, txs } ready for Indexer.processBlock. */
function decodeBlock(block, prevValues) {
  return { height: block.height, txs: block.tx.map((tx) => decodeTx(tx, prevValues)) };
}

// --- JSON-RPC transport ------------------------------------------------------------------

class RpcClient {
  constructor({ host = '127.0.0.1', port = 20102, user, pass, timeout = 30_000 } = {}) {
    this.host = host;
    this.port = port;
    this.auth = user != null ? `${user}:${pass}` : undefined;
    this.timeout = timeout;
    this._id = 0;
  }

  call(method, params = []) {
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++this._id, method, params });
    const options = {
      host: this.host,
      port: this.port,
      method: 'POST',
      path: '/',
      auth: this.auth,
      headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) },
      timeout: this.timeout,
    };
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`RPC ${method}: bad JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
          if (parsed.error) {
            return reject(new Error(`RPC ${method}: ${parsed.error.message} (code ${parsed.error.code})`));
          }
          resolve(parsed.result);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`RPC ${method}: timeout after ${this.timeout}ms`)));
      req.write(body);
      req.end();
    });
  }
}

// --- chain access: fetch + decode + prevout resolution -----------------------------------

class VergeChain {
  constructor(client) {
    this.client = client;
    this.valueCache = new Map(); // "txid:vout" -> atomic units
  }

  getBlockCount() {
    return this.client.call('getblockcount');
  }

  getBlockHash(height) {
    return this.client.call('getblockhash', [height]);
  }

  getBlock(hash, verbosity = 2) {
    return this.client.call('getblock', [hash, verbosity]);
  }

  getRawTransaction(txid, verbose = true) {
    return this.client.call('getrawtransaction', [txid, verbose]);
  }

  sendRawTransaction(hex) {
    return this.client.call('sendrawtransaction', [hex]);
  }

  /** Resolve (and cache) one prevout's value in atomic units. Needs txindex=1 on the node. */
  async resolvePrevValue(txid, vout) {
    const key = `${txid}:${vout}`;
    if (this.valueCache.has(key)) return this.valueCache.get(key);
    const raw = await this.getRawTransaction(txid, true);
    const out = raw.vout[vout];
    if (!out) throw new Error(`prevout ${key} not found in ${txid}`);
    const value = xvgToUnits(out.value);
    this.valueCache.set(key, value);
    return value;
  }

  /** Fetch block at `height`, resolve all prevout values, return the decoded block. */
  async fetchDecodedBlock(height) {
    const hash = await this.getBlockHash(height);
    const block = await this.getBlock(hash, 2);
    const prevValues = new Map();
    for (const ref of prevoutRefs(block)) {
      prevValues.set(ref.key, await this.resolvePrevValue(ref.txid, ref.vout));
    }
    return decodeBlock(block, prevValues);
  }
}

module.exports = {
  xvgToUnits,
  addressOf,
  extractRedeemScript,
  decodeTx,
  decodeBlock,
  prevoutRefs,
  RpcClient,
  VergeChain,
};
