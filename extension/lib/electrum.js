// ElectrumX client over WebSocket Secure (browser-native; no raw TCP, MV3-safe).
//
// Verified live against electrumx-verge.cloud:50004 (ElectrumX 1.19.0, protocol 1.4):
//   - balance/UTXO `value` is reported in the SAME atomic units as our COIN (1e6). A known 3 XVG
//     carrier returned value: 3000000. So no scaling is applied here.
//   - the WSS interface delivers exactly one JSON-RPC object per WebSocket message.
//
// This client is stateless w.r.t. user secrets: it only ever sends a scripthash (a hash of the
// public output script) or an already-signed raw transaction. It never sees a private key, and the
// server never learns which address maps to which user beyond the scripthash it is queried with.

import * as verge from './verge.js';

export const DEFAULT_SERVERS = [
  'wss://electrumx-verge.cloud:50004',
];

/** Electrum scripthash for a P2PKH address = reverse(sha256(scriptPubKey)) as hex. */
export async function addressToScripthash(address) {
  const spk = await verge.p2pkhScript(address);
  const h = await verge.sha256(spk);
  const rev = new Uint8Array(h.length);
  for (let i = 0; i < h.length; i++) rev[i] = h[h.length - 1 - i];
  return verge.bytesToHex(rev);
}

export class ElectrumClient {
  constructor({ servers = DEFAULT_SERVERS, timeout = 15000 } = {}) {
    this.servers = servers.slice();
    this.timeout = timeout;
    this.ws = null;
    this.url = null;
    this._id = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._connecting = null;
  }

  get connected() { return this.ws && this.ws.readyState === 1; }

  /** Connect to the first reachable server. Idempotent while a socket is open/connecting. */
  connect() {
    if (this.connected) return Promise.resolve(this.url);
    if (this._connecting) return this._connecting;
    this._connecting = this._connectAny().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connectAny() {
    let lastErr;
    for (const url of this.servers) {
      try {
        await this._open(url);
        // ElectrumX requires the client to negotiate protocol via server.version BEFORE any other
        // request, else it replies "use server.version to identify client". Do it as part of connect.
        await this.serverVersion();
        this.url = url;
        return url;
      } catch (e) {
        lastErr = e;
        this.close();
      }
    }
    throw new Error(`no ElectrumX server reachable: ${lastErr ? lastErr.message : 'unknown'}`);
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return reject(e); }
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('connect timeout')); }, this.timeout);
      ws.onopen = () => {
        clearTimeout(to);
        this.ws = ws;
        ws.onmessage = (ev) => this._onMessage(ev);
        ws.onclose = () => this._onClose();
        ws.onerror = () => {};
        resolve();
      };
      ws.onerror = (e) => { clearTimeout(to); reject(new Error('ws error connecting to ' + url)); };
    });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (msg && msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))));
      else resolve(msg.result);
    }
    // Subscription notifications (no id) are ignored: we poll on demand instead.
  }

  _onClose() {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    this._pending.clear();
    this.ws = null;
  }

  async _rpc(method, params = []) {
    if (!this.connected) await this.connect();
    const id = ++this._id;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`${method} timed out`)); }, this.timeout);
      this._pending.set(id, { resolve, reject, timer });
      try { this.ws.send(payload); } catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  close() { if (this.ws) { try { this.ws.close(); } catch {} } this.ws = null; }

  // --- high-level API ------------------------------------------------------
  async serverVersion(client = 'verginals-wallet', proto = '1.4') {
    return this._rpc('server.version', [client, proto]);
  }

  /** UTXOs for an address -> [{ txid, vout, value(units), height }]. */
  async listUnspent(address) {
    const sh = await addressToScripthash(address);
    const rows = await this._rpc('blockchain.scripthash.listunspent', [sh]);
    return (rows || []).map((r) => ({ txid: r.tx_hash, vout: r.tx_pos, value: r.value, height: r.height }));
  }

  /** { confirmed, unconfirmed } in atomic units. */
  async getBalance(address) {
    const sh = await addressToScripthash(address);
    return this._rpc('blockchain.scripthash.get_balance', [sh]);
  }

  /** Confirmed/mempool history for an address. */
  async getHistory(address) {
    const sh = await addressToScripthash(address);
    return this._rpc('blockchain.scripthash.get_history', [sh]);
  }

  /** Raw transaction hex (verbose=false) or decoded (verbose=true). */
  async getTransaction(txid, verbose = false) {
    return this._rpc('blockchain.transaction.get', [txid, verbose]);
  }

  /** Broadcast a signed raw tx; returns the txid on success (throws with node's reject reason). */
  async broadcast(rawHex) {
    return this._rpc('blockchain.transaction.broadcast', [rawHex]);
  }
}
