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

// BIP-44 account path for Verge (SLIP-44 coin type 77): external receiving keys. A seed-phrase wallet
// can hold many independent addresses; each is the receiving key at index i on this branch. Index 0 is
// the classic single address, so wallets created before multi-account keep the exact same address.
const DERIVATION_PATH = "m/44'/77'/0'/0/0";
const accountPath = (i) => `m/44'/77'/0'/0/${i}`;

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
    this._priv = null;      // Uint8Array(32) of the ACTIVE account while unlocked, else null
    this._address = null;   // cached P2PKH address of the active account

    // Keyring state (multi-wallet). Held only while unlocked:
    this._keyring = null;   // { v, activeWalletId, wallets: [...] } (vaults stay encrypted at rest)
    this._pass = null;      // passphrase kept in memory so new wallets/accounts encrypt under the same key
    this._seeds = new Map(); // walletId -> decrypted secret (mnemonic or WIF), for deriving accounts on switch
  }

  get isUnlocked() { return this._priv !== null; }
  get address() { return this._address; }

  // --- keyring helpers -----------------------------------------------------
  _requireKeyringUnlocked() {
    if (!this._pass || !this._keyring) throw new Error('wallet is locked');
  }

  _wallet(id, kr = this._keyring) {
    const w = (kr && kr.wallets || []).find((x) => x.id === id);
    if (!w) throw new Error('wallet not found');
    return w;
  }

  _nextWalletId() {
    const ids = new Set((this._keyring.wallets || []).map((w) => w.id));
    let n = 1;
    while (ids.has('w' + n)) n++;
    return 'w' + n;
  }

  async _save() { await vault.saveKeyring(this._keyring); }

  // Load the keyring into memory, migrating a legacy single vault the first time it is seen.
  async _loadKeyring() {
    if (this._keyring) return this._keyring;
    let kr = await vault.loadKeyring();
    if (!kr) {
      const legacy = await vault.loadVault();
      if (legacy) {
        const type = legacy.meta?.type || 'wif';
        kr = {
          v: 1,
          activeWalletId: 'w1',
          wallets: [{
            id: 'w1',
            label: 'Wallet 1',
            type,
            vault: legacy,
            network: legacy.meta?.network || this.network.name,
            createdAt: legacy.meta?.createdAt || Date.now(),
            activeAccount: 0,
            accounts: [{ index: 0, label: 'Account 1', address: legacy.meta?.address || null }],
          }],
        };
        await vault.saveKeyring(kr);
      }
    }
    this._keyring = kr;
    return kr;
  }

  // Derive an account's { priv, address } from its wallet's in-memory secret (requires unlocked).
  async _deriveAccount(wlt, index) {
    const secret = this._seeds.get(wlt.id);
    if (secret == null) throw new Error('wallet is locked');
    if (wlt.type === 'mnemonic') {
      const seed = await bip39.mnemonicToSeed(secret, '');
      const priv = await bip32.derivePrivateKey(seed, accountPath(index));
      const address = await verge.addressFromPrivate(priv, this.network);
      return { priv, address };
    }
    const { privateKey } = await verge.wifToPrivateKey(secret); // WIF wallets have a single account
    const address = await verge.addressFromPrivate(privateKey, this.network);
    return { priv: privateKey, address };
  }

  // Point _priv/_address at the keyring's active wallet+account, refreshing the cached address.
  async _activate() {
    const kr = this._keyring;
    let wlt = kr.wallets.find((w) => w.id === kr.activeWalletId) || kr.wallets[0];
    if (!wlt) throw new Error('no wallet');
    kr.activeWalletId = wlt.id;
    let idx = wlt.activeAccount ?? 0;
    if (!wlt.accounts.some((a) => a.index === idx)) idx = wlt.accounts[0].index;
    wlt.activeAccount = idx;
    const { priv, address } = await this._deriveAccount(wlt, idx);
    if (this._priv) this._priv.fill(0);
    this._priv = priv;
    this._address = address;
    // Backfill any account address left null by a legacy migration.
    const acct = wlt.accounts.find((a) => a.index === idx);
    if (acct && acct.address !== address) { acct.address = address; await this._save(); }
  }

  // --- lifecycle -----------------------------------------------------------
  async exists() { return (await vault.hasKeyring()) || (await vault.hasVault()); }

  /**
   * Create the FIRST wallet from a fresh BIP-39 recovery phrase. Establishes the keyring passphrase.
   * Returns the address AND the mnemonic so the UI can show it ONCE; it is never returned again after
   * this call (recover it only via revealMnemonic with the passphrase). Use addWallet() once unlocked
   * to add further wallets.
   * @param {string} passphrase
   * @param {number} [strength=128]  128 -> 12 words, 256 -> 24 words
   */
  async create(passphrase, strength = 128) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    const mnemonic = await bip39.generateMnemonic(strength);
    this._pass = passphrase;
    this._keyring = { v: 1, activeWalletId: null, wallets: [] };
    const { walletId, address } = await this._addMnemonicWallet(mnemonic, 'Wallet 1');
    this._keyring.activeWalletId = walletId;
    await this._save();
    await this._activate();
    return { address, mnemonic };
  }

  /** Import the FIRST wallet from a BIP-39 recovery phrase (12/24 words), establishing the passphrase. */
  async importMnemonic(mnemonic, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    if (!(await bip39.validateMnemonic(mnemonic))) throw new Error('invalid recovery phrase');
    this._pass = passphrase;
    this._keyring = { v: 1, activeWalletId: null, wallets: [] };
    const clean = mnemonic.trim().replace(/\s+/g, ' ');
    const { walletId, address } = await this._addMnemonicWallet(clean, 'Wallet 1');
    this._keyring.activeWalletId = walletId;
    await this._save();
    await this._activate();
    return { address };
  }

  /** Import the FIRST wallet from a WIF private key (no recovery phrase; back up the WIF). */
  async importWIF(wif, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    this._pass = passphrase;
    this._keyring = { v: 1, activeWalletId: null, wallets: [] };
    const { walletId, address } = await this._addWifWallet(wif, 'Wallet 1');
    this._keyring.activeWalletId = walletId;
    await this._save();
    await this._activate();
    return { address };
  }

  // Encrypt a fresh mnemonic wallet into the keyring (does not switch to it). Requires _pass set.
  async _addMnemonicWallet(mnemonic, label) {
    const id = this._nextWalletId();
    const seed = await bip39.mnemonicToSeed(mnemonic, '');
    const priv = await bip32.derivePrivateKey(seed, accountPath(0));
    const address = await verge.addressFromPrivate(priv, this.network);
    priv.fill(0);
    const v = await vault.createVault(mnemonic, this._pass, { type: 'mnemonic', network: this.network.name, createdAt: Date.now() });
    this._keyring.wallets.push({
      id, label, type: 'mnemonic', vault: v, network: this.network.name, createdAt: Date.now(),
      activeAccount: 0, accounts: [{ index: 0, label: 'Account 1', address }],
    });
    this._seeds.set(id, mnemonic);
    return { walletId: id, address };
  }

  // Encrypt a WIF wallet into the keyring (single account). Requires _pass set.
  async _addWifWallet(wif, label) {
    const id = this._nextWalletId();
    const { privateKey } = await verge.wifToPrivateKey(wif);
    const address = await verge.addressFromPrivate(privateKey, this.network);
    const v = await vault.createVault(wif, this._pass, { type: 'wif', network: this.network.name, createdAt: Date.now() });
    this._keyring.wallets.push({
      id, label, type: 'wif', vault: v, network: this.network.name, createdAt: Date.now(),
      activeAccount: 0, accounts: [{ index: 0, label: 'Account 1', address }],
    });
    this._seeds.set(id, wif);
    return { walletId: id, address };
  }

  /**
   * Add a wallet while unlocked, encrypting it under the current passphrase and switching to it.
   * @param {Object} opts { kind: 'create'|'importMnemonic'|'importWIF', mnemonic?, wif?, strength?, label? }
   * @returns { walletId, address, mnemonic? }  mnemonic returned ONCE for kind:'create'
   */
  async addWallet(opts = {}) {
    this._requireKeyringUnlocked();
    const label = opts.label && String(opts.label).trim() ? String(opts.label).trim() : `Wallet ${this._keyring.wallets.length + 1}`;
    let res;
    if (opts.kind === 'create') {
      const mnemonic = await bip39.generateMnemonic(opts.strength || 128);
      res = await this._addMnemonicWallet(mnemonic, label);
      res.mnemonic = mnemonic;
    } else if (opts.kind === 'importMnemonic') {
      const clean = String(opts.mnemonic || '').trim().replace(/\s+/g, ' ');
      if (!(await bip39.validateMnemonic(clean))) throw new Error('invalid recovery phrase');
      res = await this._addMnemonicWallet(clean, label);
    } else if (opts.kind === 'importWIF') {
      if (!opts.wif) throw new Error('private key required');
      res = await this._addWifWallet(String(opts.wif).trim(), label);
    } else {
      throw new Error('unknown wallet kind');
    }
    this._keyring.activeWalletId = res.walletId;
    await this._save();
    await this._activate();
    return res;
  }

  /** Derive and add the next account (address) inside a mnemonic wallet, then switch to it. */
  async addAccount(walletId) {
    this._requireKeyringUnlocked();
    const wlt = this._wallet(walletId);
    if (wlt.type !== 'mnemonic') throw new Error('private-key wallets have a single address');
    const used = new Set(wlt.accounts.map((a) => a.index));
    let idx = 0;
    while (used.has(idx)) idx++;
    const { address } = await this._deriveAccount(wlt, idx);
    wlt.accounts.push({ index: idx, label: `Account ${wlt.accounts.length + 1}`, address });
    wlt.activeAccount = idx;
    this._keyring.activeWalletId = walletId;
    await this._save();
    await this._activate();
    return { index: idx, address };
  }

  /** Switch the active wallet+account (one-click switch). */
  async selectAccount(walletId, index) {
    this._requireKeyringUnlocked();
    const wlt = this._wallet(walletId);
    if (!wlt.accounts.some((a) => a.index === index)) throw new Error('no such account');
    wlt.activeAccount = index;
    this._keyring.activeWalletId = walletId;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  async renameWallet(walletId, label) {
    this._requireKeyringUnlocked();
    const clean = String(label || '').trim();
    if (!clean) throw new Error('name required');
    this._wallet(walletId).label = clean;
    await this._save();
    return { ok: true };
  }

  async renameAccount(walletId, index, label) {
    this._requireKeyringUnlocked();
    const clean = String(label || '').trim();
    if (!clean) throw new Error('name required');
    const acct = this._wallet(walletId).accounts.find((a) => a.index === index);
    if (!acct) throw new Error('no such account');
    acct.label = clean;
    await this._save();
    return { ok: true };
  }

  /** Remove a whole wallet (and wipe its in-memory seed). Refuses to remove the last wallet. */
  async removeWallet(walletId) {
    this._requireKeyringUnlocked();
    if (this._keyring.wallets.length <= 1) throw new Error('cannot remove your only wallet');
    this._wallet(walletId); // existence check
    this._keyring.wallets = this._keyring.wallets.filter((w) => w.id !== walletId);
    this._seeds.delete(walletId);
    if (this._keyring.activeWalletId === walletId) this._keyring.activeWalletId = this._keyring.wallets[0].id;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  /** Remove one account (address) from a wallet. Refuses to remove a wallet's only account. */
  async removeAccount(walletId, index) {
    this._requireKeyringUnlocked();
    const wlt = this._wallet(walletId);
    if (wlt.accounts.length <= 1) throw new Error('cannot remove the only address in a wallet');
    wlt.accounts = wlt.accounts.filter((a) => a.index !== index);
    if (wlt.activeAccount === index) wlt.activeAccount = wlt.accounts[0].index;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  /** Unlock the keyring: decrypt every wallet's secret with `passphrase` and activate the pointer. */
  async unlock(passphrase) {
    const kr = await this._loadKeyring();
    if (!kr || !kr.wallets.length) throw new Error('no wallet: create or import first');
    this._seeds.clear();
    for (const wlt of kr.wallets) {
      const secret = await vault.openVault(wlt.vault, passphrase); // throws 'wrong passphrase'
      this._seeds.set(wlt.id, secret);
    }
    this._pass = passphrase;
    await this._activate();
    return { address: this._address };
  }

  /** Drop all secrets from memory. */
  lock() {
    if (this._priv) this._priv.fill(0);
    this._priv = null;
    this._address = null;
    this._pass = null;
    this._seeds.clear();
  }

  /**
   * Reveal a wallet's recovery phrase for backup. Requires passphrase re-entry (never uses the
   * in-memory copy silently). Defaults to the active wallet. Throws for WIF wallets (no phrase).
   */
  async revealMnemonic(passphrase, walletId) {
    const kr = await this._loadKeyring();
    if (!kr) throw new Error('no wallet');
    const id = walletId || kr.activeWalletId;
    const wlt = this._wallet(id, kr);
    if (wlt.type !== 'mnemonic') throw new Error('this wallet was imported from a private key and has no recovery phrase');
    return vault.openVault(wlt.vault, passphrase); // returns the mnemonic
  }

  /**
   * Export an account's private key as WIF (requires passphrase re-entry). Defaults to the active
   * wallet/account. For mnemonic wallets this derives the key at the account index; for WIF wallets it
   * returns the stored WIF.
   */
  async exportWIF(passphrase, walletId, index) {
    const kr = await this._loadKeyring();
    if (!kr) throw new Error('no wallet');
    const id = walletId || kr.activeWalletId;
    const wlt = this._wallet(id, kr);
    const secret = await vault.openVault(wlt.vault, passphrase);
    if (wlt.type === 'mnemonic') {
      const idx = index != null ? index : (wlt.activeAccount ?? 0);
      const seed = await bip39.mnemonicToSeed(secret, '');
      const priv = await bip32.derivePrivateKey(seed, accountPath(idx));
      return verge.privateKeyToWIF(priv, this.network);
    }
    return secret; // already a WIF
  }

  /** Whether a wallet has a recovery phrase (false for WIF imports). Defaults to the active wallet. */
  async hasMnemonic(walletId) {
    const kr = await this._loadKeyring();
    if (!kr) return false;
    const id = walletId || kr.activeWalletId;
    const wlt = (kr.wallets || []).find((w) => w.id === id);
    return !!wlt && wlt.type === 'mnemonic';
  }

  /** Non-secret snapshot for the UI: wallet list with accounts + the active pointers. */
  async list() {
    const kr = await this._loadKeyring();
    if (!kr) return { activeWalletId: null, wallets: [] };
    return {
      activeWalletId: kr.activeWalletId,
      wallets: kr.wallets.map((w) => ({
        id: w.id, label: w.label, type: w.type, activeAccount: w.activeAccount ?? 0,
        accounts: w.accounts.map((a) => ({ index: a.index, label: a.label, address: a.address })),
      })),
    };
  }

  /** Non-secret description of the currently active wallet+account (or {} when locked). */
  activeInfo() {
    const kr = this._keyring;
    if (!kr) return {};
    const wlt = kr.wallets.find((w) => w.id === kr.activeWalletId);
    if (!wlt) return {};
    const acct = wlt.accounts.find((a) => a.index === (wlt.activeAccount ?? 0)) || wlt.accounts[0];
    return {
      walletId: wlt.id, walletLabel: wlt.label, walletType: wlt.type,
      accountIndex: acct ? acct.index : 0, accountLabel: acct ? acct.label : null,
      address: this._address || (acct ? acct.address : null),
    };
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
