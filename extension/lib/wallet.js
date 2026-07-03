// Wallet controller: ties the encrypted vault (vault.js) to the signer (verge.js) and the chain via
// ElectrumX (electrum.js). This is the object the background service worker holds. The decrypted
// private key lives ONLY in this instance's memory while unlocked, and is dropped on lock().
//
// Data path (fully decentralized: the VPS is NOT in the wallet's safety loop):
//   - UTXOs + balance + broadcast     -> Verge public ElectrumX servers over WSS (electrum.js).
//   - which UTXO carries which Verginal-> derived IN-BROWSER from chain data (inscriptions.js), by
//                                         tracing each sat's lineage back to a reveal. No server call.
//   - signing                         -> on-device (verge.js). No key or address ever leaves the box.
// The Verginals backend is used only for OPTIONAL, best-effort display niceties (inscription number);
// its absence can never hide a balance or make a spend unsafe.

import * as verge from './verge.js';
import * as vault from './vault.js';
import * as bip39 from './bip39.js';
import * as bip32 from './bip32.js';
import { ElectrumClient } from './electrum.js';
import { InscriptionDetector } from './inscriptions.js';

const DEFAULT_API = 'https://verginals.com';

// BIP-44 account path for Verge (SLIP-44 coin type 77): the first external receiving key. New wallets
// are seed-phrase (BIP-39) based and derive their single address from here; legacy WIF-imported
// wallets keep working via the vault meta.type branch below.
const DERIVATION_PATH = "m/44'/77'/0'/0/0";

// A block height at or below the first Verginal reveal (genesis #0 is at 9295203). Used ONLY to bound
// the in-browser "prove this coin is ordinary XVG" ancestry walk: any tx below this height predates
// the collection and cannot carry an inscription. Conservative (lower is always safe); never raise it
// above the true genesis height or a real carrier could be misread as spendable.
const COLLECTION_ERA_HEIGHT = 9290000;

export class Wallet {
  constructor({ apiBase = DEFAULT_API, network = verge.NETWORKS.mainnet, electrum } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.network = network;
    this.electrum = electrum || new ElectrumClient();
    this.detector = new InscriptionDetector(this.electrum, { eraHeight: COLLECTION_ERA_HEIGHT });
    this._priv = null;      // Uint8Array(32) while unlocked, else null
    this._address = null;   // cached P2PKH address string
  }

  get isUnlocked() { return this._priv !== null; }
  get address() { return this._address; }

  // --- lifecycle -----------------------------------------------------------
  async exists() { return vault.hasVault(); }

  /**
   * Create a brand-new wallet from a fresh BIP-39 recovery phrase. Returns the address AND the
   * mnemonic so the UI can show it ONCE for the user to write down; it is never returned again after
   * this call (recover it only via revealMnemonic with the passphrase).
   * @param {string} passphrase
   * @param {number} [strength=128]  128 -> 12 words, 256 -> 24 words
   */
  async create(passphrase, strength = 128) {
    const mnemonic = await bip39.generateMnemonic(strength);
    const { address } = await this._initFromMnemonic(mnemonic, passphrase);
    return { address, mnemonic };
  }

  /** Import an existing wallet from a BIP-39 recovery phrase (12/24 words). */
  async importMnemonic(mnemonic, passphrase) {
    if (!(await bip39.validateMnemonic(mnemonic))) throw new Error('invalid recovery phrase');
    return this._initFromMnemonic(mnemonic, passphrase);
  }

  /** Import a legacy single-key wallet from a WIF string (no recovery phrase; back up the WIF). */
  async importWIF(wif, passphrase) {
    const { privateKey, network } = await verge.wifToPrivateKey(wif);
    if (network) this.network = network;
    const address = await verge.addressFromPrivate(privateKey, this.network);
    const v = await vault.createVault(wif, passphrase, { type: 'wif', address, network: this.network.name, createdAt: Date.now() });
    await vault.saveVault(v);
    this._priv = privateKey;
    this._address = address;
    return { address };
  }

  async _initFromMnemonic(mnemonic, passphrase) {
    const seed = await bip39.mnemonicToSeed(mnemonic, '');
    const priv = await bip32.derivePrivateKey(seed, DERIVATION_PATH);
    const address = await verge.addressFromPrivate(priv, this.network);
    const v = await vault.createVault(mnemonic, passphrase, {
      type: 'mnemonic', path: DERIVATION_PATH, address, network: this.network.name, createdAt: Date.now(),
    });
    await vault.saveVault(v);
    this._priv = priv;
    this._address = address;
    return { address };
  }

  /** Unlock the stored vault; loads the private key into memory (mnemonic OR legacy WIF). */
  async unlock(passphrase) {
    const v = await vault.loadVault();
    if (!v) throw new Error('no wallet: create or import first');
    const secret = await vault.openVault(v, passphrase); // throws 'wrong passphrase'
    const type = v.meta?.type || 'wif'; // vaults created before the type tag are WIF
    if (type === 'mnemonic') {
      const seed = await bip39.mnemonicToSeed(secret, '');
      this._priv = await bip32.derivePrivateKey(seed, v.meta?.path || DERIVATION_PATH);
      this._address = v.meta?.address || (await verge.addressFromPrivate(this._priv, this.network));
    } else {
      const { privateKey, network } = await verge.wifToPrivateKey(secret);
      if (network) this.network = network;
      this._priv = privateKey;
      this._address = v.meta?.address || (await verge.addressFromPrivate(privateKey, this.network));
    }
    return { address: this._address };
  }

  /** Drop the private key from memory. */
  lock() {
    if (this._priv) this._priv.fill(0);
    this._priv = null;
  }

  /**
   * Reveal the recovery phrase for backup. Requires passphrase re-entry (never uses the in-memory
   * copy silently). Throws for legacy WIF wallets, which have no phrase.
   */
  async revealMnemonic(passphrase) {
    const v = await vault.loadVault();
    if (!v) throw new Error('no wallet');
    if ((v.meta?.type || 'wif') !== 'mnemonic') throw new Error('this wallet was imported from a WIF and has no recovery phrase');
    return vault.openVault(v, passphrase); // returns the mnemonic
  }

  /**
   * Export the private key as WIF (requires passphrase re-entry). For mnemonic wallets this derives
   * the key at the wallet's path; for legacy WIF wallets it returns the stored WIF.
   */
  async exportWIF(passphrase) {
    const v = await vault.loadVault();
    if (!v) throw new Error('no wallet');
    const secret = await vault.openVault(v, passphrase);
    if ((v.meta?.type || 'wif') === 'mnemonic') {
      const seed = await bip39.mnemonicToSeed(secret, '');
      const priv = await bip32.derivePrivateKey(seed, v.meta?.path || DERIVATION_PATH);
      return verge.privateKeyToWIF(priv, this.network);
    }
    return secret; // already a WIF
  }

  /** Whether the stored wallet has a recovery phrase (false for legacy WIF imports). */
  async hasMnemonic() {
    const v = await vault.loadVault();
    return !!v && (v.meta?.type || 'wif') === 'mnemonic';
  }

  _requireUnlocked() {
    if (!this.isUnlocked) throw new Error('wallet is locked');
  }

  /** Sign a text message (Verge magic hash); returns base64 signature. */
  async signMessage(message) {
    this._requireUnlocked();
    return verge.signMessage(message, this._priv);
  }

  // --- backend I/O (OPTIONAL display enrichment only; never in the safety path) --------------
  async _post(path, obj) {
    const res = await fetch(this.apiBase + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `POST ${path} failed (${res.status})`);
    return body;
  }

  /**
   * Fetch UTXOs from ElectrumX, then tag which ones carry a Verginal by tracing each sat's lineage
   * IN-BROWSER (inscriptions.js). No server is consulted for safety.
   * Each entry: { txid, vout, value(units), height, inscription, inscriptionStatus }, where
   * `inscription` is: an object {id,contentType,parents} if it carries a Verginal; null if it is
   * confirmed ordinary XVG; or undefined if detection could not decide (fetch/depth limit). Undefined
   * is FAIL-SAFE: such coins are excluded from every spend, but still counted in the TOTAL balance.
   */
  async getUtxos() {
    this._requireUnlocked();
    const raw = await this.electrum.listUnspent(this._address);
    if (!raw.length) return [];
    const utxos = await this.detector.annotate(raw);
    // Best-effort: decorate carried inscriptions with their collection number for display. Any
    // failure here is swallowed; it never changes `inscription` (the safety field) or the balance.
    try {
      const carriers = utxos.filter((u) => u.inscription);
      if (carriers.length) {
        const r = await this._post('/api/inscriptions/at', { outpoints: carriers.map((u) => `${u.txid}:${u.vout}`) });
        const overlay = r.inscriptions || {};
        for (const u of carriers) {
          const info = overlay[`${u.txid}:${u.vout}`];
          if (info && info.number != null) u.inscription.number = info.number;
        }
      }
    } catch { /* offline / VPS down: display shows the inscription without a number, spends unaffected */ }
    return utxos;
  }

  /**
   * Fetch a Verginal's raw content (image/text bytes) for display, addressed by its inscription id
   * "<revealTxid>iN". Fully client-side (inscriptions.js reads the reveal tx envelope). Returns the
   * content type plus a base64 body, since chrome.runtime messaging is JSON and cannot carry a
   * Uint8Array across the boundary. Display-only: never touches keys, balances, or spends.
   */
  /**
   * Recent transaction history for this address (display-only), most recent first. Each entry is
   * { txid, height } where height <= 0 means still unconfirmed (mempool). ElectrumX returns the raw
   * list; we sort and cap it here. No amounts/direction: the popup links each txid to the explorer.
   */
  async getHistory(limit = 30) {
    this._requireUnlocked();
    const rows = await this.electrum.getHistory(this._address);
    const rank = (h) => (h && h > 0 ? h : Number.MAX_SAFE_INTEGER); // unconfirmed floats to the top
    return rows
      .slice()
      .sort((a, b) => rank(b.height) - rank(a.height))
      .slice(0, limit)
      .map((r) => ({ txid: r.tx_hash, height: r.height }));
  }

  async getInscriptionContent(id) {
    const { contentType, body } = await this.detector.getContent(id);
    let bin = '';
    for (let i = 0; i < body.length; i++) bin += String.fromCharCode(body[i]);
    return { contentType, base64: btoa(bin) };
  }

  /**
   * FAST balance: total atomic units + UTXO count from a single ElectrumX call, WITHOUT running
   * inscription detection. This is what the popup renders first so the number never blocks on the
   * (potentially multi-second, first-run-only) ancestry traces. It is display-only: it says how much
   * XVG the address holds, never which coins are spendable. Use getBalance() for the safety split.
   */
  async getTotalBalance() {
    this._requireUnlocked();
    const raw = await this.electrum.listUnspent(this._address);
    return { total: raw.reduce((a, u) => a + u.value, 0), count: raw.length };
  }

  /**
   * Balance summary in atomic units. `total` is ALWAYS the full ElectrumX balance (never gated by
   * inscription status). `spendable` is only coins confirmed non-inscription; `unknown` are coins we
   * could not classify (excluded from spends for safety); `inscriptions` are the Verginal carriers.
   */
  async getBalance() {
    const utxos = await this.getUtxos();
    const total = utxos.reduce((a, u) => a + u.value, 0);
    const spendable = utxos.filter((u) => u.inscription === null).reduce((a, u) => a + u.value, 0);
    const unknown = utxos.filter((u) => u.inscription === undefined).reduce((a, u) => a + u.value, 0);
    const inscriptions = utxos.filter((u) => u.inscription);
    return { total, spendable, unknown, inscriptions };
  }

  async broadcast(hex) {
    const txid = await this.electrum.broadcast(hex);
    return { txid };
  }

  // --- signing -------------------------------------------------------------
  /**
   * Transfer one inscription (identified by its carrier "txid:vout") to `toAddress`, funding fee
   * from spendable UTXOs. Ordinal-safe (carrier is input 0 + output 0). Broadcasts and returns txid.
   * @param {Object} p
   * @param {string} p.carrierOutpoint  "txid:vout" of the inscription UTXO
   * @param {string} p.toAddress
   * @param {number} [p.feePerKb=200000]  0.2 XVG/kB min relay
   * @param {boolean} [p.broadcast=true]
   */
  async transferInscription({ carrierOutpoint, toAddress, feePerKb = 200000, broadcast = true }) {
    this._requireUnlocked();
    if (!/^[a-fA-F0-9]{64}:\d+$/.test(carrierOutpoint)) throw new Error('bad carrier outpoint');
    const [ctxid, cvoutStr] = carrierOutpoint.split(':');
    const cvout = Number(cvoutStr);

    const utxos = await this.getUtxos();
    const carrier = utxos.find((u) => u.txid === ctxid && u.vout === cvout);
    if (!carrier) throw new Error('carrier UTXO not found for this wallet');
    if (!carrier.inscription) throw new Error('refusing: that UTXO carries no inscription');

    // Only fund from coins we KNOW are not inscriptions (inscription === null). Unknown (undefined,
    // overlay was unreachable) coins are excluded so we can never burn an untagged Verginal for fee.
    const funders = utxos
      .filter((u) => !(u.txid === ctxid && u.vout === cvout) && u.inscription === null)
      .map((u) => ({ ...u, privateKey: this._priv }));

    const built = await verge.buildInscriptionTransfer({
      carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value, privateKey: this._priv },
      funders,
      toAddress,
      changeAddress: this._address,
      feePerKb,
      time: Math.floor(Date.now() / 1000),
    });

    if (!broadcast) return { hex: built.hex, txid: built.txid, size: built.size };
    const { txid } = await this.broadcast(built.hex);
    return { txid: txid || built.txid, hex: built.hex, size: built.size };
  }

  /**
   * Plain send of spendable XVG to `toAddress` (never touches inscription UTXOs).
   * @param {Object} p { toAddress, amount(units), feePerKb, broadcast }
   */
  async send({ toAddress, amount, feePerKb = 200000, broadcast = true }) {
    this._requireUnlocked();
    const utxos = await this.getUtxos();
    // Spend ONLY coins explicitly confirmed non-inscription (=== null); never unknown/inscription.
    const spendable = utxos.filter((u) => u.inscription === null).map((u) => ({ ...u, privateKey: this._priv }));

    // Greedy selection over spendable UTXOs.
    spendable.sort((a, b) => b.value - a.value);
    const inputs = [];
    let total = 0;
    const dust = 100000;
    for (const u of spendable) {
      inputs.push(u);
      total += u.value;
      const estSize = 14 + inputs.length * 148 + 2 * 34;
      const fee = Math.max(feePerKb, Math.ceil((estSize / 1000) * feePerKb));
      if (total >= amount + fee) break;
    }
    const estSize = 14 + inputs.length * 148 + 2 * 34;
    const fee = Math.max(feePerKb, Math.ceil((estSize / 1000) * feePerKb));
    if (total < amount + fee) throw new Error(`insufficient spendable funds: need ${amount + fee}, have ${total}`);

    const outputs = [{ address: toAddress, value: amount }];
    const change = total - amount - fee;
    if (change >= dust) outputs.push({ address: this._address, value: change });

    const built = await verge.buildAndSignP2PKH({
      inputs: inputs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, privateKey: this._priv })),
      outputs,
      time: Math.floor(Date.now() / 1000),
    });
    if (!broadcast) return { hex: built.hex, txid: built.txid, size: built.size };
    const { txid } = await this.broadcast(built.hex);
    return { txid: txid || built.txid, hex: built.hex, size: built.size };
  }
}

export { verge, vault };
