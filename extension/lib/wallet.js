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

    // Keyring state (MetaMask-style: one shared recovery phrase, a flat list of accounts where each
    // account is a single address). Held only while unlocked:
    this._keyring = null;    // { v:2, activeId, seedVault, accounts:[...] } (vaults stay encrypted at rest)
    this._pass = null;       // passphrase kept in memory so new accounts encrypt under the same key
    this._seed = null;       // decrypted shared mnemonic (null if the wallet has no seed, e.g. WIF-only)
    this._imported = new Map(); // accountId -> decrypted WIF, for imported (standalone) accounts
  }

  get isUnlocked() { return this._priv !== null; }
  get address() { return this._address; }

  // --- keyring helpers -----------------------------------------------------
  _requireKeyringUnlocked() {
    if (!this._pass || !this._keyring || this._keyring.v !== 2) throw new Error('wallet is locked');
  }

  _account(id, kr = this._keyring) {
    const a = (kr && kr.accounts || []).find((x) => x.id === id);
    if (!a) throw new Error('account not found');
    return a;
  }

  _nextAccountId() {
    const ids = new Set((this._keyring.accounts || []).map((a) => a.id));
    let n = 1;
    while (ids.has('a' + n)) n++;
    return 'a' + n;
  }

  async _save() { await vault.saveKeyring(this._keyring); }

  // Load the keyring into memory. A legacy single vault is converted to the flat model here (no
  // decryption needed: only the encrypted blob and the public address move). An interim two-level
  // keyring (v1, never publicly released) is left as-is and folded into v2 at unlock, where the
  // passphrase is available to re-encrypt the extra keys as imported accounts.
  async _loadKeyring() {
    if (this._keyring) return this._keyring;
    let kr = await vault.loadKeyring();
    if (!kr) {
      const legacy = await vault.loadVault();
      if (legacy) {
        const type = legacy.meta?.type || 'wif';
        if (type === 'mnemonic') {
          kr = {
            v: 2, activeId: 'a1', seedVault: legacy,
            accounts: [{ id: 'a1', label: 'Account 1', kind: 'derived', index: 0, address: legacy.meta?.address || null }],
          };
        } else {
          kr = {
            v: 2, activeId: 'a1', seedVault: null,
            accounts: [{ id: 'a1', label: 'Account 1', kind: 'imported', vault: legacy, address: legacy.meta?.address || null }],
          };
        }
        await vault.saveKeyring(kr);
      }
    }
    this._keyring = kr;
    return kr;
  }

  // Derive the { priv, address } for a derived account index from the in-memory shared seed.
  async _deriveIndex(index) {
    if (this._seed == null) throw new Error('wallet has no recovery phrase');
    const seed = await bip39.mnemonicToSeed(this._seed, '');
    const priv = await bip32.derivePrivateKey(seed, accountPath(index));
    const address = await verge.addressFromPrivate(priv, this.network);
    return { priv, address };
  }

  // Resolve an account object to { priv, address } using in-memory secrets (requires unlocked).
  async _accountKey(acct) {
    if (acct.kind === 'derived') return this._deriveIndex(acct.index);
    const wif = this._imported.get(acct.id);
    if (wif == null) throw new Error('wallet is locked');
    const { privateKey } = await verge.wifToPrivateKey(wif);
    const address = await verge.addressFromPrivate(privateKey, this.network);
    return { priv: privateKey, address };
  }

  // Point _priv/_address at the keyring's active account, refreshing the cached address.
  async _activate() {
    const kr = this._keyring;
    const acct = kr.accounts.find((a) => a.id === kr.activeId) || kr.accounts[0];
    if (!acct) throw new Error('no account');
    kr.activeId = acct.id;
    const { priv, address } = await this._accountKey(acct);
    if (this._priv) this._priv.fill(0);
    this._priv = priv;
    this._address = address;
    if (acct.address !== address) { acct.address = address; await this._save(); } // backfill legacy nulls
  }

  // Decrypt the shared seed + every imported account's key into memory. Throws on wrong passphrase.
  async _loadSecrets(passphrase) {
    this._seed = null;
    this._imported.clear();
    if (this._keyring.seedVault) this._seed = await vault.openVault(this._keyring.seedVault, passphrase);
    for (const a of this._keyring.accounts) {
      if (a.kind === 'imported') this._imported.set(a.id, await vault.openVault(a.vault, passphrase));
    }
  }

  // --- lifecycle -----------------------------------------------------------
  async exists() { return (await vault.hasKeyring()) || (await vault.hasVault()); }

  /**
   * Create the wallet from a fresh BIP-39 recovery phrase. Establishes the shared phrase + passphrase
   * and the first (derived) account. Returns the address AND the mnemonic so the UI can show it ONCE;
   * it is never returned again (recover it only via revealMnemonic with the passphrase). Use
   * addAccount()/importAccount() once unlocked to add more addresses.
   * @param {string} passphrase
   * @param {number} [strength=128]  128 -> 12 words, 256 -> 24 words
   */
  async create(passphrase, strength = 128) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    const mnemonic = await bip39.generateMnemonic(strength);
    this._pass = passphrase;
    this._seed = mnemonic;
    this._imported.clear();
    const seedVault = await vault.createVault(mnemonic, passphrase, { type: 'mnemonic', createdAt: Date.now() });
    const { address } = await this._deriveIndex(0);
    this._keyring = { v: 2, activeId: 'a1', seedVault, accounts: [{ id: 'a1', label: 'Account 1', kind: 'derived', index: 0, address }] };
    await this._save();
    await this._activate();
    return { address, mnemonic };
  }

  /** Set up the wallet from an existing BIP-39 recovery phrase (12/24 words) as the shared seed. */
  async importMnemonic(mnemonic, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    const clean = mnemonic.trim().replace(/\s+/g, ' ');
    if (!(await bip39.validateMnemonic(clean))) throw new Error('invalid recovery phrase');
    this._pass = passphrase;
    this._seed = clean;
    this._imported.clear();
    const seedVault = await vault.createVault(clean, passphrase, { type: 'mnemonic', createdAt: Date.now() });
    const { address } = await this._deriveIndex(0);
    this._keyring = { v: 2, activeId: 'a1', seedVault, accounts: [{ id: 'a1', label: 'Account 1', kind: 'derived', index: 0, address }] };
    await this._save();
    await this._activate();
    return { address };
  }

  /** Set up the wallet from a WIF private key. The wallet has NO shared phrase (import-only). */
  async importWIF(wif, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    const clean = String(wif).trim();
    const { privateKey } = await verge.wifToPrivateKey(clean);
    const address = await verge.addressFromPrivate(privateKey, this.network);
    this._pass = passphrase;
    this._seed = null;
    this._imported.clear();
    const v = await vault.createVault(clean, passphrase, { type: 'wif', createdAt: Date.now() });
    this._imported.set('a1', clean);
    this._keyring = { v: 2, activeId: 'a1', seedVault: null, accounts: [{ id: 'a1', label: 'Account 1', kind: 'imported', vault: v, address }] };
    await this._save();
    await this._activate();
    return { address };
  }

  /**
   * Derive and add the next account (address) from the shared recovery phrase, then switch to it.
   * @param {string} [label]
   */
  async addAccount(label) {
    this._requireKeyringUnlocked();
    if (this._seed == null) throw new Error('this wallet has no recovery phrase; import a private key instead');
    const usedIdx = new Set(this._keyring.accounts.filter((a) => a.kind === 'derived').map((a) => a.index));
    let index = 0;
    while (usedIdx.has(index)) index++;
    const { address } = await this._deriveIndex(index);
    const id = this._nextAccountId();
    const clean = String(label || '').trim() || `Account ${this._keyring.accounts.length + 1}`;
    this._keyring.accounts.push({ id, label: clean, kind: 'derived', index, address });
    this._keyring.activeId = id;
    await this._save();
    await this._activate();
    return { id, address };
  }

  /** Add a standalone account from a WIF private key (not covered by the phrase), then switch to it. */
  async importAccount(wif, label) {
    this._requireKeyringUnlocked();
    const clean = String(wif || '').trim();
    if (!clean) throw new Error('private key required');
    const { privateKey } = await verge.wifToPrivateKey(clean);
    const address = await verge.addressFromPrivate(privateKey, this.network);
    if (this._keyring.accounts.some((a) => a.address === address)) throw new Error('that account is already in the wallet');
    const v = await vault.createVault(clean, this._pass, { type: 'wif', createdAt: Date.now() });
    const id = this._nextAccountId();
    const name = String(label || '').trim() || `Account ${this._keyring.accounts.length + 1}`;
    this._keyring.accounts.push({ id, label: name, kind: 'imported', vault: v, address });
    this._imported.set(id, clean);
    this._keyring.activeId = id;
    await this._save();
    await this._activate();
    return { id, address };
  }

  /** Switch the active account (one-click switch). */
  async selectAccount(id) {
    this._requireKeyringUnlocked();
    if (!this._keyring.accounts.some((a) => a.id === id)) throw new Error('no such account');
    this._keyring.activeId = id;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  async renameAccount(id, label) {
    this._requireKeyringUnlocked();
    const clean = String(label || '').trim();
    if (!clean) throw new Error('name required');
    this._account(id).label = clean;
    await this._save();
    return { ok: true };
  }

  /** Remove an account. Refuses to remove the only account. */
  async removeAccount(id) {
    this._requireKeyringUnlocked();
    if (this._keyring.accounts.length <= 1) throw new Error('cannot remove your only account');
    this._account(id); // existence check
    this._keyring.accounts = this._keyring.accounts.filter((a) => a.id !== id);
    this._imported.delete(id);
    if (this._keyring.activeId === id) this._keyring.activeId = this._keyring.accounts[0].id;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  // Fold an interim two-level keyring (v1) into the flat v2 model. The first mnemonic wallet becomes
  // the shared seed and its addresses become derived accounts; every other key (extra phrases, WIFs)
  // is re-encrypted as a standalone imported account so no key is ever lost. Requires the passphrase.
  async _migrateV1(krV1, passphrase) {
    let counter = 0;
    const nextId = () => 'a' + (++counter);
    const accounts = [];
    let seedVault = null;
    const firstMnemonic = (krV1.wallets || []).find((w) => w.type === 'mnemonic');
    if (firstMnemonic) {
      const phrase = await vault.openVault(firstMnemonic.vault, passphrase); // verifies passphrase
      seedVault = await vault.createVault(phrase, passphrase, { type: 'mnemonic', createdAt: Date.now() });
      for (const a of firstMnemonic.accounts) {
        accounts.push({ id: nextId(), label: a.label || `Account ${counter}`, kind: 'derived', index: a.index, address: a.address || null });
      }
    }
    for (const w of (krV1.wallets || [])) {
      if (w === firstMnemonic) continue;
      const secret = await vault.openVault(w.vault, passphrase);
      for (const a of w.accounts) {
        let wif;
        if (w.type === 'mnemonic') {
          const seed = await bip39.mnemonicToSeed(secret, '');
          const priv = await bip32.derivePrivateKey(seed, accountPath(a.index));
          wif = await verge.privateKeyToWIF(priv, this.network);
        } else {
          wif = secret;
        }
        const v = await vault.createVault(wif, passphrase, { type: 'wif', createdAt: Date.now() });
        accounts.push({ id: nextId(), label: a.label || `Account ${counter}`, kind: 'imported', vault: v, address: a.address || null });
      }
    }
    this._keyring = { v: 2, activeId: accounts[0].id, seedVault, accounts };
    await this._save();
  }

  /** Unlock the keyring: decrypt the shared seed + imported keys with `passphrase`, then activate. */
  async unlock(passphrase) {
    const raw = await this._loadKeyring();
    if (!raw) throw new Error('no wallet: create or import first');
    if (raw.v === 1) {
      if (!(raw.wallets || []).length) throw new Error('no wallet: create or import first');
      await this._migrateV1(raw, passphrase); // throws on wrong passphrase; sets this._keyring to v2
    } else {
      if (!(raw.accounts || []).length) throw new Error('no wallet: create or import first');
      this._keyring = raw;
    }
    await this._loadSecrets(passphrase); // throws on wrong passphrase
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
    this._seed = null;
    this._imported.clear();
  }

  /**
   * Reveal the shared recovery phrase for backup. Requires passphrase re-entry (never uses the
   * in-memory copy silently). Throws for import-only wallets that have no phrase.
   */
  async revealMnemonic(passphrase) {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 2) throw new Error('unlock your wallet first');
    if (!kr.seedVault) throw new Error('this wallet has no recovery phrase');
    return vault.openVault(kr.seedVault, passphrase); // returns the mnemonic
  }

  /**
   * Export an account's private key as WIF (requires passphrase re-entry). Defaults to the active
   * account. Derived accounts are derived at their index; imported accounts return their stored WIF.
   */
  async exportWIF(passphrase, id) {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 2) throw new Error('unlock your wallet first');
    const acct = this._account(id || kr.activeId, kr);
    if (acct.kind === 'derived') {
      if (!kr.seedVault) throw new Error('this wallet has no recovery phrase');
      const mnemonic = await vault.openVault(kr.seedVault, passphrase);
      const seed = await bip39.mnemonicToSeed(mnemonic, '');
      const priv = await bip32.derivePrivateKey(seed, accountPath(acct.index));
      return verge.privateKeyToWIF(priv, this.network);
    }
    return vault.openVault(acct.vault, passphrase); // imported: the stored WIF
  }

  /** Whether the wallet has a shared recovery phrase (false for import-only wallets). */
  async hasMnemonic() {
    const kr = await this._loadKeyring();
    if (!kr) return false;
    if (kr.v === 1) return (kr.wallets || []).some((w) => w.type === 'mnemonic');
    return kr.seedVault != null;
  }

  /** Non-secret snapshot for the UI: the flat account list + the active pointer + whether a seed exists. */
  async list() {
    const kr = await this._loadKeyring();
    if (!kr) return { activeId: null, hasSeed: false, accounts: [] };
    if (kr.v === 1) return { activeId: null, hasSeed: (kr.wallets || []).some((w) => w.type === 'mnemonic'), accounts: [] };
    return {
      activeId: kr.activeId,
      hasSeed: kr.seedVault != null,
      accounts: kr.accounts.map((a) => ({ id: a.id, label: a.label, kind: a.kind, index: a.index, address: a.address })),
    };
  }

  /** Non-secret description of the currently active account (or {} when locked). */
  activeInfo() {
    const kr = this._keyring;
    if (!kr || kr.v !== 2) return {};
    const acct = kr.accounts.find((a) => a.id === kr.activeId) || kr.accounts[0];
    if (!acct) return {};
    return { id: acct.id, label: acct.label, kind: acct.kind, address: this._address || acct.address };
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
