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

    // Keyring state: a flat list of fully independent accounts. Each account is one address that is
    // EITHER its own recovery phrase ('seed', created fresh or imported, revealable) OR a standalone
    // private key ('key'). There is no shared seed: adding an address mints a brand new phrase, just
    // like creating the first one. Held only while unlocked:
    this._keyring = null;    // { v:3, activeId, accounts:[...] } (vaults stay encrypted at rest)
    this._pass = null;       // passphrase kept in memory so new accounts encrypt under the same key
    this._seeds = new Map(); // accountId -> decrypted mnemonic, for 'seed' accounts
    this._keys = new Map();  // accountId -> decrypted WIF, for 'key' accounts
  }

  get isUnlocked() { return this._priv !== null; }
  get address() { return this._address; }

  // --- keyring helpers -----------------------------------------------------
  _requireKeyringUnlocked() {
    if (!this._pass || !this._keyring || this._keyring.v !== 3) throw new Error('wallet is locked');
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
  // decryption needed: only the encrypted blob and the public address move). Older keyrings (v1 two-
  // level, v2 shared-seed) are left as-is and folded into v3 at unlock, where the passphrase is
  // available to re-encrypt keys.
  async _loadKeyring() {
    if (this._keyring) return this._keyring;
    let kr = await vault.loadKeyring();
    if (!kr) {
      const legacy = await vault.loadVault();
      if (legacy) {
        const type = legacy.meta?.type || 'wif';
        if (type === 'mnemonic') {
          kr = {
            v: 3, activeId: 'a1',
            accounts: [{ id: 'a1', label: 'Account 1', kind: 'seed', seedVault: legacy, index: 0, address: legacy.meta?.address || null }],
          };
        } else {
          kr = {
            v: 3, activeId: 'a1',
            accounts: [{ id: 'a1', label: 'Account 1', kind: 'key', vault: legacy, address: legacy.meta?.address || null }],
          };
        }
        await vault.saveKeyring(kr);
      }
    }
    this._keyring = kr;
    return kr;
  }

  // Derive the { priv, address } at `index` from a mnemonic string.
  async _deriveFromMnemonic(mnemonic, index = 0) {
    const seed = await bip39.mnemonicToSeed(mnemonic, '');
    const priv = await bip32.derivePrivateKey(seed, accountPath(index));
    const address = await verge.addressFromPrivate(priv, this.network);
    return { priv, address };
  }

  // Resolve an account object to { priv, address } using in-memory secrets (requires unlocked).
  async _accountKey(acct) {
    if (acct.kind === 'seed') {
      const mnemonic = this._seeds.get(acct.id);
      if (mnemonic == null) throw new Error('wallet is locked');
      return this._deriveFromMnemonic(mnemonic, acct.index || 0);
    }
    const wif = this._keys.get(acct.id);
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

  // Decrypt every account's secret (phrase or key) into memory. Throws on wrong passphrase.
  async _loadSecrets(passphrase) {
    this._seeds.clear();
    this._keys.clear();
    for (const a of this._keyring.accounts) {
      if (a.kind === 'seed') this._seeds.set(a.id, await vault.openVault(a.seedVault, passphrase));
      else this._keys.set(a.id, await vault.openVault(a.vault, passphrase));
    }
  }

  // --- lifecycle -----------------------------------------------------------
  async exists() { return (await vault.hasKeyring()) || (await vault.hasVault()); }

  // Add a fresh phrase-backed ('seed') account and switch to it. Shared by first-time create() and
  // by addSeedAccount(); pass a mnemonic to import one, or omit to mint a new phrase of `strength`.
  async _addSeedAccount(label, { mnemonic, strength = 128, requireLocked = false } = {}) {
    const phrase = mnemonic
      ? String(mnemonic).trim().replace(/\s+/g, ' ')
      : await bip39.generateMnemonic(strength);
    if (mnemonic && !(await bip39.validateMnemonic(phrase))) throw new Error('invalid recovery phrase');
    const { address } = await this._deriveFromMnemonic(phrase, 0);
    if (this._keyring && this._keyring.accounts.some((a) => a.address === address)) {
      throw new Error('that address is already in the wallet');
    }
    const seedVault = await vault.createVault(phrase, this._pass, { type: 'mnemonic', createdAt: Date.now() });
    const id = this._keyring ? this._nextAccountId() : 'a1';
    const name = String(label || '').trim() || `Account ${(this._keyring?.accounts.length || 0) + 1}`;
    const acct = { id, label: name, kind: 'seed', seedVault, index: 0, address };
    if (this._keyring) this._keyring.accounts.push(acct);
    else this._keyring = { v: 3, activeId: id, accounts: [acct] };
    this._keyring.activeId = id;
    this._seeds.set(id, phrase);
    await this._save();
    await this._activate();
    return { id, address, mnemonic: phrase };
  }

  // Add a key-only ('key') account from a WIF and switch to it.
  async _addKeyAccount(wif, label) {
    const clean = String(wif || '').trim();
    if (!clean) throw new Error('private key required');
    const { privateKey } = await verge.wifToPrivateKey(clean);
    const address = await verge.addressFromPrivate(privateKey, this.network);
    if (this._keyring && this._keyring.accounts.some((a) => a.address === address)) {
      throw new Error('that address is already in the wallet');
    }
    const v = await vault.createVault(clean, this._pass, { type: 'wif', createdAt: Date.now() });
    const id = this._keyring ? this._nextAccountId() : 'a1';
    const name = String(label || '').trim() || `Account ${(this._keyring?.accounts.length || 0) + 1}`;
    const acct = { id, label: name, kind: 'key', vault: v, address };
    if (this._keyring) this._keyring.accounts.push(acct);
    else this._keyring = { v: 3, activeId: id, accounts: [acct] };
    this._keyring.activeId = id;
    this._keys.set(id, clean);
    await this._save();
    await this._activate();
    return { id, address };
  }

  /**
   * Create the wallet's FIRST address from a fresh BIP-39 recovery phrase. Returns the address AND the
   * mnemonic so the UI can show it ONCE (recover it later only via revealMnemonic + passphrase).
   * @param {string} passphrase
   * @param {number} [strength=128]  128 -> 12 words, 256 -> 24 words
   */
  async create(passphrase, strength = 128) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    this._pass = passphrase;
    this._seeds.clear();
    this._keys.clear();
    return this._addSeedAccount(null, { strength });
  }

  /** Set up the wallet's first address from an existing BIP-39 recovery phrase (12/24 words). */
  async importMnemonic(mnemonic, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    this._pass = passphrase;
    this._seeds.clear();
    this._keys.clear();
    const { address } = await this._addSeedAccount(null, { mnemonic });
    return { address };
  }

  /** Set up the wallet's first address from a WIF private key (key-only account). */
  async importWIF(wif, passphrase) {
    if (await this.exists()) throw new Error('wallet already exists; unlock first');
    if (!passphrase) throw new Error('passphrase required');
    this._pass = passphrase;
    this._seeds.clear();
    this._keys.clear();
    const { address } = await this._addKeyAccount(wif, null);
    return { address };
  }

  /**
   * Create a brand new address backed by its OWN fresh recovery phrase, then switch to it. Returns the
   * mnemonic so the UI can show the backup screen once, exactly like the first address.
   * @param {string} [label]
   * @param {number} [strength=128]  128 -> 12 words, 256 -> 24 words
   */
  async addSeedAccount(label, strength = 128) {
    this._requireKeyringUnlocked();
    return this._addSeedAccount(label, { strength });
  }

  /** Import an existing address from a WIF private key (key-only account), then switch to it. */
  async importAccount(wif, label) {
    this._requireKeyringUnlocked();
    return this._addKeyAccount(wif, label);
  }

  /**
   * Import an existing address from an external recovery phrase. Stores that phrase (revealable) and
   * uses its FIRST address (index 0). The phrase belongs to this address alone, so it is kept just
   * like a natively created one.
   */
  async importMnemonicAccount(mnemonic, label) {
    this._requireKeyringUnlocked();
    if (!String(mnemonic || '').trim()) throw new Error('recovery phrase required');
    return this._addSeedAccount(label, { mnemonic });
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
    this._seeds.delete(id);
    this._keys.delete(id);
    if (this._keyring.activeId === id) this._keyring.activeId = this._keyring.accounts[0].id;
    await this._save();
    await this._activate();
    return { address: this._address };
  }

  // Fold an interim two-level keyring (v1) into the flat v3 model. Each wallet's first address keeps
  // its phrase as a 'seed' account (revealable); every other derived address and every WIF becomes a
  // key-only account so no key is ever lost. Requires the passphrase.
  async _migrateV1ToV3(krV1, passphrase) {
    let counter = 0;
    const nextId = () => 'a' + (++counter);
    const accounts = [];
    for (const w of (krV1.wallets || [])) {
      const secret = await vault.openVault(w.vault, passphrase); // verifies passphrase
      let first = true;
      for (const a of w.accounts) {
        if (w.type === 'mnemonic') {
          const { address } = await this._deriveFromMnemonic(secret, a.index);
          if (first) {
            const seedVault = await vault.createVault(secret, passphrase, { type: 'mnemonic', createdAt: Date.now() });
            accounts.push({ id: nextId(), label: a.label || w.label || `Account ${counter}`, kind: 'seed', seedVault, index: a.index, address });
          } else {
            const seed = await bip39.mnemonicToSeed(secret, '');
            const priv = await bip32.derivePrivateKey(seed, accountPath(a.index));
            const wif = await verge.privateKeyToWIF(priv, this.network);
            const v = await vault.createVault(wif, passphrase, { type: 'wif', createdAt: Date.now() });
            accounts.push({ id: nextId(), label: a.label || `Account ${counter}`, kind: 'key', vault: v, address });
          }
        } else {
          const v = await vault.createVault(secret, passphrase, { type: 'wif', createdAt: Date.now() });
          accounts.push({ id: nextId(), label: a.label || w.label || `Account ${counter}`, kind: 'key', vault: v, address: a.address || null });
        }
        first = false;
      }
    }
    if (!accounts.length) throw new Error('no wallet: create or import first');
    this._keyring = { v: 3, activeId: accounts[0].id, accounts };
    await this._save();
  }

  // Fold a shared-seed keyring (v2) into the flat v3 model. The first derived address keeps the shared
  // phrase as a 'seed' account (so it stays revealable); the other derived addresses and every
  // imported key become key-only accounts. Ids and the active pointer are preserved. Requires pass.
  async _migrateV2ToV3(krV2, passphrase) {
    const mnemonic = krV2.seedVault ? await vault.openVault(krV2.seedVault, passphrase) : null; // verifies pass
    const accounts = [];
    let seedTaken = false;
    for (const a of krV2.accounts) {
      if (a.kind === 'derived') {
        const { address } = await this._deriveFromMnemonic(mnemonic, a.index);
        if (!seedTaken) {
          const seedVault = await vault.createVault(mnemonic, passphrase, { type: 'mnemonic', createdAt: Date.now() });
          accounts.push({ id: a.id, label: a.label, kind: 'seed', seedVault, index: a.index, address });
          seedTaken = true;
        } else {
          const seed = await bip39.mnemonicToSeed(mnemonic, '');
          const priv = await bip32.derivePrivateKey(seed, accountPath(a.index));
          const wif = await verge.privateKeyToWIF(priv, this.network);
          const v = await vault.createVault(wif, passphrase, { type: 'wif', createdAt: Date.now() });
          accounts.push({ id: a.id, label: a.label, kind: 'key', vault: v, address });
        }
      } else {
        // imported: already a WIF vault under this passphrase; keep it as a key account.
        accounts.push({ id: a.id, label: a.label, kind: 'key', vault: a.vault, address: a.address || null });
      }
    }
    this._keyring = { v: 3, activeId: krV2.activeId || accounts[0].id, accounts };
    await this._save();
  }

  /** Unlock the keyring: decrypt every account's secret with `passphrase`, migrating if needed. */
  async unlock(passphrase) {
    const raw = await this._loadKeyring();
    if (!raw) throw new Error('no wallet: create or import first');
    if (raw.v === 1) {
      await this._migrateV1ToV3(raw, passphrase); // throws on wrong passphrase; sets this._keyring to v3
    } else if (raw.v === 2) {
      await this._migrateV2ToV3(raw, passphrase); // throws on wrong passphrase; sets this._keyring to v3
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
    this._seeds.clear();
    this._keys.clear();
  }

  /**
   * Reveal an account's recovery phrase for backup (requires passphrase re-entry). Defaults to the
   * active account. Throws for key-only accounts, which have no phrase.
   */
  async revealMnemonic(passphrase, id) {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 3) throw new Error('unlock your wallet first');
    const acct = this._account(id || kr.activeId, kr);
    if (acct.kind !== 'seed') throw new Error('this address has no recovery phrase');
    return vault.openVault(acct.seedVault, passphrase); // returns the mnemonic
  }

  /**
   * Export an account's private key as WIF (requires passphrase re-entry). Defaults to the active
   * account. Seed accounts derive at their index; key accounts return their stored WIF.
   */
  async exportWIF(passphrase, id) {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 3) throw new Error('unlock your wallet first');
    const acct = this._account(id || kr.activeId, kr);
    if (acct.kind === 'seed') {
      const mnemonic = await vault.openVault(acct.seedVault, passphrase);
      const seed = await bip39.mnemonicToSeed(mnemonic, '');
      const priv = await bip32.derivePrivateKey(seed, accountPath(acct.index || 0));
      return verge.privateKeyToWIF(priv, this.network);
    }
    return vault.openVault(acct.vault, passphrase); // key account: the stored WIF
  }

  /** Whether the ACTIVE account is phrase-backed (has a recovery phrase to reveal). */
  async hasMnemonic() {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 3 || !kr.accounts.length) return false;
    const acct = kr.accounts.find((a) => a.id === kr.activeId) || kr.accounts[0];
    return acct.kind === 'seed';
  }

  /** Non-secret snapshot for the UI: the flat account list + the active pointer. */
  async list() {
    const kr = await this._loadKeyring();
    if (!kr || kr.v !== 3) return { activeId: null, accounts: [] };
    return {
      activeId: kr.activeId,
      accounts: kr.accounts.map((a) => ({ id: a.id, label: a.label, kind: a.kind, address: a.address })),
    };
  }

  /** Non-secret description of the currently active account (or {} when locked). */
  activeInfo() {
    const kr = this._keyring;
    if (!kr || kr.v !== 3) return {};
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
