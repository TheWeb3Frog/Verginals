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
import * as swap from './swap.js';
import { verifiedBalances, spendableForPayment, selectForRuneTransfer, encodeEdicts, edictScript, DUST_UNITS } from './runes.js';
import * as runebid from './runebid.js';

const DEFAULT_API = 'https://verginals.com';

// BIP-44 account path for Verge (SLIP-44 coin type 77): external receiving keys. A seed-phrase wallet
// can hold many independent addresses; each is the receiving key at index i on this branch. Index 0 is
// the classic single address, so wallets created before multi-account keep the exact same address.
// New wallets get 24 words, not 12.
//
// 12 words is 128 bits of entropy and no classical computer will ever exhaust that. The reason to
// move is Grover's algorithm, which gives a quantum search a square root speedup and so halves the
// effective strength: 128 bits becomes about 64, and 256 becomes about 128. Sixty four bits of
// quantum work is still far beyond any machine anyone can describe building, but the margin is thin
// enough to be worth twelve extra words written down once.
//
// BE CLEAR ABOUT WHAT THIS DOES NOT DO. It is not quantum protection for the coins. The threat to
// the coins is Shor's algorithm against secp256k1, which recovers a private key from a PUBLIC key
// and does not care how long the phrase was. What protects a normal address is that its public key
// stays hidden behind a hash until it is first spent from. A longer phrase protects the phrase.
//
// Existing 12 word wallets are unaffected and stay valid forever: BIP-39 accepts any legal length
// and the derivation is identical, so nobody has to migrate.
export const DEFAULT_STRENGTH = 256;

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
  async _addSeedAccount(label, { mnemonic, strength = DEFAULT_STRENGTH, requireLocked = false } = {}) {
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
   * @param {number} [strength=DEFAULT_STRENGTH]  128 -> 12 words, 256 -> 24 words
   */
  async create(passphrase, strength = DEFAULT_STRENGTH) {
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
  // --- Verge Runes locks ------------------------------------------------------------------------

  /**
   * The BIP-39 seed of the active account, for lock derivation only.
   *
   * A key-only account (an imported WIF) has no seed and therefore cannot derive a lock key. That is
   * refused loudly rather than silently falling back to a random key: a random key is exactly the
   * orphan this whole design exists to remove, and an etcher who thinks their lock is backed by
   * their twelve words when it is not would find that out four years too late.
   */
  async _lockSeed() {
    const kr = this._keyring;
    if (!kr) throw new Error('unlock your wallet first');
    const acct = kr.accounts.find((a) => a.id === kr.activeId) || kr.accounts[0];
    if (!acct || acct.kind !== 'seed') {
      throw new Error('this account was imported as a single key, so it has no recovery phrase to '
        + 'derive a lock key from. Switch to a seed account before etching a coin.');
    }
    const mnemonic = this._seeds.get(acct.id);
    if (mnemonic == null) throw new Error('wallet is locked');
    return bip39.mnemonicToSeed(mnemonic, '');
  }

  /**
   * The public key that will lock a ticker price, derived from this wallet's seed.
   *
   * Only the public half is returned, ever. The etching publishes it on chain anyway, so handing it
   * to a page discloses nothing that the whole world will not read a block later.
   */
  async runesLockPubkey(index = 0) {
    const seed = await this._lockSeed();
    const { deriveLockKey } = await import('./runelock.js');
    const k = await deriveLockKey(seed, index);
    return { index: k.index, path: k.path, pubkey: k.pubkey };
  }

  /**
   * Which of the locks published on chain this wallet can open.
   *
   * `published` is the public list from /api/runes/locks. Nothing is sent anywhere: the seed derives
   * candidate keys here and the comparison happens here, so the server that served the list never
   * learns which entries were a match.
   */
  async runesMyLocks(published) {
    const seed = await this._lockSeed();
    const { matchPublishedLocks, nextLockIndex, timeUntil } = await import('./runelock.js');
    const mine = await matchPublishedLocks(seed, published);
    return {
      locks: mine.map((l) => ({ ...l, countdown: timeUntil(l.locktime).text, open: timeUntil(l.locktime).open })),
      nextIndex: nextLockIndex(mine),
    };
  }

  /**
   * Sign the release for a lock this wallet owns, at etch time.
   *
   * The private half never leaves here: the page hands over the outpoint and the destination, and
   * gets back a finished transaction it can inscribe. After this the key is optional, which is the
   * entire point of the scheme.
   */
  async runesSignRelease({ index, locktime, txid, vout, value, to, fee, time }) {
    const seed = await this._lockSeed();
    const { deriveLockKey, buildRelease } = await import('./runelock.js');
    const { privateKey } = await deriveLockKey(seed, Number(index) || 0, { includePrivate: true });
    try {
      return await buildRelease(privateKey, {
        locktime: Number(locktime), txid: String(txid), vout: Number(vout),
        value: Number(value), to: to || this.address, fee: Number(fee), network: this.network, time,
      });
    } finally {
      privateKey.fill(0);
    }
  }

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

  async _get(path) {
    const res = await fetch(this.apiBase + path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `GET ${path} failed (${res.status})`);
    return body;
  }

  // --- marketplace (trustless swaps; the site is only an order book, keys stay here) ----------

  /** The active account's coins split into { carrier, clean, sorted }; a carrier check is enforced. */
  async _marketCoins(carrierOutpoint) {
    const utxos = await this.getUtxos();
    let carrier = null;
    if (carrierOutpoint) {
      const [ct, cv] = carrierOutpoint.split(':');
      carrier = utxos.find((u) => u.txid === ct && u.vout === Number(cv)) || null;
    }
    // Spendable, non-inscription coins only (never an untagged Verginal).
    const clean = utxos.filter((u) => u.inscription === null);
    // Two of these become the swap pads (padded output 0); prefer the smallest as pads.
    const sorted = clean.slice().sort((a, b) => a.value - b.value);
    return { carrier, clean, sorted };
  }

  /**
   * The inscribed sat's unit offset inside a carrier output, from our indexer. A swap needs it to
   * reset the Verginal onto a fresh constant-postage carrier (swap.completeListing / buildBid).
   * Returns 0 if the outpoint carries no known inscription (fresh mints are always offset 0).
   */
  async _carrierOffset(carrierOutpoint) {
    try {
      const { inscriptions } = await this._post('/api/inscriptions/at', { outpoints: [carrierOutpoint] });
      const hit = inscriptions && inscriptions[carrierOutpoint];
      return hit && typeof hit.offset === 'number' ? hit.offset : 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * A transaction's Verge nTime, read from its raw serialization ([int32 version][uint32 nTime]…).
   * A swap must be stamped no earlier than every coin it spends (rule R1), so a pad-split must
   * inherit the age of its source coins; this gives us that age.
   */
  async _txTime(txid) {
    // A transaction's nTime is immutable, so this cache never goes stale. We cache the PROMISE, not
    // the value: a split produces pad/pad/change from one txid, so the three coins are looked up
    // concurrently and a value cache would still fire three identical round-trips.
    if (!this._txTimes) this._txTimes = new Map();
    const hit = this._txTimes.get(txid);
    if (hit) return hit;
    const p = (async () => {
      const hex = await this.electrum.getTransaction(txid, false);
      const b = verge.hexToBytes(hex.slice(8, 16)); // 4 bytes at byte offset 4
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    })();
    this._txTimes.set(txid, p);
    p.catch(() => this._txTimes.delete(txid)); // never cache a failure
    return p;
  }

  /**
   * The subset of `coins` that a transaction stamped `nTime = t` may legally spend (rule R1:
   * tx.nTime >= the nTime of every input's creating transaction). A coin whose time cannot be read
   * is dropped rather than assumed usable: building an unspendable transaction is worse than
   * skipping a coin.
   */
  async _coinsOlderThan(coins, t) {
    const times = await Promise.all(coins.map((u) => this._txTime(u.txid).catch(() => Infinity)));
    return coins.filter((_, i) => times[i] <= t);
  }

  /**
   * The nTime to stamp on a transaction spending `utxos`: the oldest value rule R1 allows, i.e. the
   * newest input's own nTime.
   *
   * Stamping `now` instead would be legal but wasteful: the change output would be born "new", and
   * since a listing variant can only be funded by coins older than its nTime, a wallet that had just
   * paid for anything (a mint, most obviously) would lose the ability to buy aged listings until its
   * change caught up. Inheriting the age means SPENDING NEVER MAKES YOUR COINS YOUNGER; only
   * receiving from outside does, which is the honest behaviour.
   *
   * A coin whose time cannot be read falls back to `now`, which is always legal (R2 keeps every
   * confirmed coin's nTime at or below wall clock) and simply forfeits the optimisation.
   */
  async _spendTime(utxos) {
    if (!utxos || !utxos.length) return Math.floor(Date.now() / 1000);
    const now = Math.floor(Date.now() / 1000);
    const times = await Promise.all(utxos.map((u) => this._txTime(u.txid).catch(() => now)));
    return Math.max(...times);
  }

  /**
   * Guarantee two dust pads plus funding coins for a swap, creating them automatically when the
   * wallet lacks them. The pads pad output 0 so the Verginal resets onto a fresh constant postage.
   * If we already hold three usable clean coins we spend them as-is (no extra transaction);
   * otherwise we split the clean coins into [pad, pad, change] in one transaction and use those.
   *
   * The split is stamped at the age of its source coins (rule R1: a transaction's nTime must be
   * >= every input's), so the new pads are no younger than the coins they came from and a
   * fixed-price buy on an older listing variant still validates.
   * @returns {{ pads: Array, funds: Array }}
   */
  async _ensurePads(sorted, need) {
    const PAD = swap.POSTAGE_UNITS; // 0.1 XVG, the minimum relayable dust
    // Fast path: three or more clean coins already, two as pads and the rest covering need. The two
    // pads must sum to at least one dust so the padding-out (pads + offset) is itself relayable;
    // otherwise fall through and split, which mints dust-sized pads on purpose.
    if (sorted.length >= 3 && sorted[0].value + sorted[1].value >= PAD) {
      const rest = sorted.slice(2);
      const restSum = rest.reduce((s, u) => s + u.value, 0);
      if (restSum >= need) {
        return {
          pads: sorted.slice(0, 2).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
          funds: rest.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
        };
      }
    }
    // Otherwise carve the pads out of the wallet's clean coins with a single split transaction.
    const total = sorted.reduce((s, u) => s + u.value, 0);
    const estSize = 14 + sorted.length * 148 + 3 * 34;
    const splitFee = Math.max(200000, Math.ceil((estSize / 1000) * 200000));
    const change = total - 2 * PAD - splitFee;
    if (change < need) {
      throw new Error('Not enough spendable XVG for this swap plus fees. Top up this wallet and try again.');
    }
    const splitTime = await this._spendTime(sorted); // >= every source coin's nTime, so R1 holds
    const built = await verge.buildAndSignP2PKH({
      inputs: sorted.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, privateKey: this._priv })),
      outputs: [
        { address: this._address, value: PAD },
        { address: this._address, value: PAD },
        { address: this._address, value: change },
      ],
      time: splitTime,
    });
    const { txid } = await this.broadcast(built.hex);
    const stxid = txid || built.txid;
    return {
      pads: [{ txid: stxid, vout: 0, value: PAD }, { txid: stxid, vout: 1, value: PAD }],
      funds: [{ txid: stxid, vout: 2, value: change }],
    };
  }

  /** The marketplace fee (basis points + destination) the server requires listings to carry. */
  async _marketFee() {
    try {
      const info = await this._get('/api/info');
      const bps = Number(info.marketFeeBps || 0);
      return { bps, address: bps > 0 ? info.marketFeeAddress : null };
    } catch (_) {
      return { bps: 0, address: null };
    }
  }

  /**
   * List one owned Verginal for sale at `priceUnits`. Signs a 30-day schedule of half-signed
   * variants (SIGHASH_SINGLE|ANYONECANPAY) and posts them to the order book. No coins move. The
   * marketplace fee is taken from the sale, so the seller nets priceUnits minus the fee.
   */
  async listInscription({ carrierOutpoint, priceUnits }) {
    this._requireUnlocked();
    if (!/^[a-fA-F0-9]{64}:\d+$/.test(carrierOutpoint || '')) throw new Error('bad carrier outpoint');
    if (!(priceUnits > 0)) throw new Error('price must be positive');
    const { carrier } = await this._marketCoins(carrierOutpoint);
    if (!carrier) throw new Error('carrier UTXO not found for this wallet');
    if (!carrier.inscription) throw new Error('that UTXO carries no Verginal');
    const { bps, address } = await this._marketFee();
    const feeUnits = bps > 0 ? Math.floor((priceUnits * bps) / 10000) : 0;
    const listing = await swap.buildListing({
      carrier: { txid: carrier.txid, vout: carrier.vout, value: carrier.value },
      priceUnits, sellerAddress: this._address, priv: this._priv,
      feeUnits, feeAddress: address,
    });
    return this._post('/api/market/list', listing);
  }

  /** Buy a listed Verginal: fetch the variant matching our coin ages, complete it, broadcast. */
  async buyListing({ carrierOutpoint, expectedPriceUnits, broadcast = true }) {
    this._requireUnlocked();
    const { sorted } = await this._marketCoins(null);
    if (!sorted.length) throw new Error('This wallet has no spendable XVG. Top it up, wait for the deposit to confirm, then try again.');
    // MARKETPLACE-SPEC-v0 §2.1: the order book serves the variant with the largest nTime that is
    // already minable, chosen INDEPENDENTLY of us; we then spend only coins older than that nTime.
    // Announcing our whole balance instead (the old `?coins=` call) let a single freshly received
    // coin veto a variant every one of our other coins could have satisfied, so any wallet that
    // had just paid for anything, a mint included, could not buy an aged listing at all.
    let variant, carrierOffset;
    try {
      ({ variant, carrierOffset } = await this._get(`/api/market/buy/${carrierOutpoint}`));
    } catch (e) {
      if (/variant|usable|coins/i.test(e.message || '')) {
        throw new Error('This listing has no variant available right now. Use "Make an offer" instead (offers work right away).');
      }
      throw e;
    }
    if (variant.sellerAddress && variant.sellerAddress === this._address) {
      throw new Error("This is your own listing, so you can't buy it. Connect a different wallet as the buyer.");
    }
    // Never pay more than the user approved: the seller-signed price is immutable, but guard anyway.
    if (expectedPriceUnits != null && variant.priceUnits !== expectedPriceUnits) {
      throw new Error('the listed price changed since you opened it; cancel and try again');
    }

    const feeUnits = 300000; // ~0.3 XVG, a small padded swap
    const need = variant.priceUnits + feeUnits;
    // Only coins older than the variant's nTime may fund it (R1). Newer ones are simply left
    // alone rather than allowed to block the purchase.
    const eligible = await this._coinsOlderThan(sorted, variant.time);
    if (eligible.reduce((s, u) => s + u.value, 0) < need) {
      throw new Error(eligible.length === 0
        ? 'All of your XVG is more recent than this listing, so an instant buy is not possible yet. Use "Make an offer" instead, which has no such limit and works right away.'
        : 'Your coins that are old enough for this listing do not cover the price. Use "Make an offer" instead, which can spend your whole balance.');
    }
    const { pads, funds } = await this._ensurePads(eligible, need);
    const built = await swap.completeListing({
      variant, pads, funds,
      buyerAddress: this._address, priv: this._priv, feeUnits,
      carrierOffset: carrierOffset || 0,
    });
    if (!broadcast) return built;
    const { txid } = await this.broadcast(built.hex);
    return { txid: txid || built.txid, hex: built.hex };
  }

  /** Place an offer on any Verginal by its carrier outpoint (public), at `priceUnits`. */
  async placeBid({ carrierOutpoint, sellerAddress, carrierValue, priceUnits }) {
    this._requireUnlocked();
    if (!(priceUnits > 0)) throw new Error('price must be positive');
    if (sellerAddress && sellerAddress === this._address) throw new Error("This is your own listing, so you can't make an offer on it.");
    const { sorted } = await this._marketCoins(null);
    if (!sorted.length) throw new Error('This wallet has no spendable XVG. Top it up, wait for the deposit to confirm, then try again.');
    const feeUnits = 300000;
    const { pads, funds } = await this._ensurePads(sorted, priceUnits + feeUnits);
    const [ct, cv] = carrierOutpoint.split(':');
    const carrierOffset = await this._carrierOffset(carrierOutpoint);
    const { bps, address } = await this._marketFee();
    const marketFeeUnits = bps > 0 ? Math.floor((priceUnits * bps) / 10000) : 0;
    const bid = await swap.buildBid({
      carrier: { txid: ct, vout: Number(cv), value: carrierValue },
      priceUnits, sellerAddress, pads, funds,
      buyerAddress: this._address, priv: this._priv, feeUnits,
      marketFeeUnits, feeAddress: address,
      carrierOffset,
    });
    return this._post('/api/market/bid', bid);
  }

  /** Accept an offer on one of our Verginals: sign the carrier input and broadcast. */
  async acceptBid({ carrierOutpoint, buyerAddress, expectedPriceUnits, broadcast = true }) {
    this._requireUnlocked();
    const { carrier } = await this._marketCoins(carrierOutpoint);
    if (!carrier) throw new Error('carrier UTXO not found for this wallet');
    const { bid } = await this._get(`/api/market/accept/${carrierOutpoint}/${buyerAddress}`);
    if (expectedPriceUnits != null && bid.priceUnits !== expectedPriceUnits) {
      throw new Error('the offer changed since you opened it; refresh and try again');
    }
    // The bid's payout address must be OUR active address, or we would be handing over the Verginal
    // for a payment that goes elsewhere. buildBid always pays vout[2] to sellerAddress; verify it.
    if (bid.sellerAddress !== this._address) throw new Error('this offer does not pay your wallet');
    const built = await swap.acceptBid({ bid, priv: this._priv });
    if (!broadcast) return built;
    const { txid } = await this.broadcast(built.hex);
    return { txid: txid || built.txid, hex: built.hex };
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
    await this._annotateRunes(utxos);
    return utxos;
  }

  /**
   * Tag each coin with the fungible runes it carries (RUNES-SPEC-v0).
   *
   * A wallet cannot index the chain, so it asks an indexer, and then REFUSES TO TRUST IT: every
   * balance must come with a merkle proof that verifies against a checkpoint root, and anything that
   * does not verify is discarded. A hostile indexer therefore cannot invent a balance, and a dead
   * one cannot make coins look spendable that are not.
   *
   * `runes` follows the same fail-safe convention as `inscription`: {} means confirmed to carry
   * nothing, and `undefined` means undetermined, which every spend path treats as "do not touch".
   */
  async _annotateRunes(utxos) {
    for (const u of utxos) u.runes = undefined; // undetermined until proven otherwise
    try {
      // Is the rune protocol even running here? This question has to be asked first, and getting it
      // wrong bricks the wallet: "undetermined" is the right answer when an indexer exists and fails,
      // but on a chain where nothing has ever been etched there is nothing to be undetermined ABOUT.
      // Treating that case as unsafe left every coin unspendable and reported it as "insufficient
      // funds", which is how a full wallet came to say it had nothing.
      const info = await this._get('/api/info').catch(() => null);
      if (info && info.runes === false) {
        for (const u of utxos) u.runes = {};
        return;
      }
      const outpoints = utxos.map((u) => `${u.txid}:${u.vout}`);
      const answer = await this._post('/api/runes/balances', { outpoints });
      if (!answer || !answer.root || !Array.isArray(answer.entries)) return; // leave undetermined
      const root = Uint8Array.from(answer.root);
      const { balances, rejected } = await verifiedBalances(answer, root);
      if (rejected > 0) {
        // Something served a balance it could not prove. Trust nothing from this answer.
        console.warn(`runes: ${rejected} unproven balance(s) rejected; leaving coins undetermined`);
        return;
      }
      for (const u of utxos) u.runes = balances.get(`${u.txid}:${u.vout}`) || {};
    } catch {
      /* offline, or no rune indexer: coins stay undetermined, so nothing gets spent by accident */
    }
  }

  /** Fungible rune balances held by this wallet, summed across its coins. */
  async getRuneBalances() {
    const utxos = await this.getUtxos();
    const totals = {};
    let undetermined = 0;
    for (const u of utxos) {
      if (u.runes === undefined) { undetermined += 1; continue; }
      for (const [ref, amt] of Object.entries(u.runes)) totals[ref] = (totals[ref] || 0) + amt;
    }
    return { totals, undetermined };
  }

  /**
   * The same balances, ready to render: ticker, symbol, decimals and whether the amount was PROVEN.
   *
   * `undetermined` is not a rounding error and must reach the screen. It counts coins whose rune
   * content this wallet could not verify against the published root, because the indexer was
   * unreachable or served something it could not prove. A wallet that quietly showed those as zero
   * would be telling somebody they own nothing when they may own a great deal.
   */
  async getRunesForDisplay() {
    const { totals, undetermined } = await this.getRuneBalances();
    const refs = Object.keys(totals);
    if (!refs.length) return { runes: [], undetermined };

    // The definitions travel with the proofs, so one call answers both.
    let defs = new Map();
    try {
      const utxos = await this.getUtxos();
      const answer = await this._post('/api/runes/balances', { outpoints: utxos.map((u) => `${u.txid}:${u.vout}`) });
      for (const d of (answer && answer.runes) || []) defs.set(d.ref || d.runeRef, d);
    } catch { /* names are cosmetic; a balance without one is still a balance */ }

    const runes = refs.map((ref) => {
      const d = defs.get(ref) || {};
      const div = Number.isInteger(d.divisibility) ? d.divisibility : 0;
      return {
        ref,
        ticker: d.ticker || null,
        display: d.display || d.ticker || ref,
        symbol: d.symbol || '\u00a4',
        divisibility: div,
        units: totals[ref],
        amount: totals[ref] / (10 ** div),
        verified: true,
      };
    });
    runes.sort((a, b) => String(a.display).localeCompare(String(b.display)));
    return { runes, undetermined };
  }

  /** The scriptPubKey this account's coins sit on, as hex. Every carrier of ours has this script. */
  async _ownScript() {
    this._requireUnlocked();
    return verge.bytesToHex(await verge.p2pkhScript(this._address));
  }

  /**
   * Advertise that you are selling. A standing order names NO OUTPOINT, so a partial sale does not
   * kill it: the remainder comes home on a new coin and the same signature keeps selling it.
   *
   * It binds nobody, and that is the point. Only this key can move these runes, so the promise is a
   * promise and the buyer's bid is what is binding. The worst outcome of a broken promise is no
   * trade, never a lost coin.
   */
  async publishOrder({ runeRef, sell, minPrice, expiresAt, minFill, nonce }) {
    this._requireUnlocked();
    const order = await runebid.signOrder({
      runeRef, sell, minPrice, priv: this._priv, minFill,
      nonce: nonce || String(Date.now()),
      expiresAt: expiresAt || Math.floor(Date.now() / 1000) + 30 * 86400,
    });
    await this._post('/api/runes/order', { order });
    return order;
  }

  async withdrawOrder(order) {
    this._requireUnlocked();
    const cancel = await runebid.signCancel({ order, priv: this._priv });
    await this._post('/api/runes/order/cancel', { cancel });
    return true;
  }

  /**
   * The bids waiting on this wallet, each already checked against OUR OWN coins.
   *
   * The book is asked what is waiting and is believed about nothing else. Every claim a bid makes is
   * re-derived here from this wallet's own verified utxos, so a book that lies, or is absent, or is
   * replaced by a hostile one, costs the seller a trade and never a coin. A bid that fails is not
   * hidden: it is returned with the reason, because a seller should be able to see somebody trying.
   */
  async getPendingBids() {
    this._requireUnlocked();
    const script = await this._ownScript();
    let bids = [];
    try { ({ bids } = await this._get(`/api/runes/bids?script=${script}`)); }
    catch { return { bids: [], refused: [], reachable: false }; }

    const utxos = await this.getUtxos();
    const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
    const good = [], refused = [];
    for (const bid of bids || []) {
      const onChain = [];
      let missing = null;
      for (const c of bid.carriers || []) {
        const u = byOutpoint.get(`${c.txid}:${c.vout}`);
        if (!u || u.runes === undefined) { missing = `${c.txid}:${c.vout}`; break; }
        onChain.push({ txid: u.txid, vout: u.vout, value: u.value, script, runes: u.runes });
      }
      if (missing) { refused.push({ bid, reason: `this wallet cannot account for ${missing}` }); continue; }
      const v = await runebid.verifyRuneBid({ bid, onChain });
      if (v.ok) good.push({ bid, ...v }); else refused.push({ bid, reason: v.reason });
    }
    good.sort((a, b) => b.receives - a.receives);
    return { bids: good, refused, reachable: true };
  }

  /**
   * Fill one bid. Verified AGAIN here rather than trusting what the list said: the list may be
   * seconds old, and the coins it counted on may have moved since.
   */
  async fillBid(bid) {
    this._requireUnlocked();
    const script = await this._ownScript();
    const utxos = await this.getUtxos();
    const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
    const onChain = [];
    for (const c of bid.carriers || []) {
      const u = byOutpoint.get(`${c.txid}:${c.vout}`);
      if (!u || u.runes === undefined) throw new Error(`this wallet cannot account for ${c.txid}:${c.vout}`);
      onChain.push({ txid: u.txid, vout: u.vout, value: u.value, script, runes: u.runes });
    }
    const v = await runebid.verifyRuneBid({ bid, onChain });
    if (!v.ok) throw new Error(v.reason);
    const signed = await runebid.acceptRuneBid({ bid, priv: this._priv });
    const txid = await this.electrum.broadcast(signed.hex);
    return { txid, changeOutpoint: signed.changeOutpoint, receives: v.receives, gives: v.gives, keeps: v.keeps };
  }

  /**
   * Place a limit order to BUY: name an amount and a price, and leave it on the book.
   *
   * The one thing that must not be taken on trust here is WHAT THE SELLER'S CARRIERS HOLD. A buyer
   * who believed a server about that would sign a full price for a carrier holding a hundredth of
   * what was claimed: the runestone caps an edict at what is actually there, so the money moves and
   * the runes do not. So the seller's coins are listed from ELECTRUM, not from our backend, and their
   * rune contents are proven against the published root by the same code that proves this wallet's
   * own. Anything that will not prove is dropped, and a bid is never built on it.
   */
  async placeRuneBid({ order, amount, feeUnits, marketFeeUnits, feeAddress, alreadySold }) {
    this._requireUnlocked();
    const units = Number(amount);
    if (!Number.isInteger(units) || units <= 0) throw new Error('the amount must be a whole number of units above zero');

    const ov = await runebid.verifyOrder(order, Math.floor(Date.now() / 1000));
    if (!ov.ok) throw new Error(ov.reason);

    // The seller's coins, from the network rather than from us.
    const raw = await this.electrum.listUnspent(order.address);
    if (!raw.length) throw new Error('this seller has nothing to sell from that address');
    const sellerScript = verge.bytesToHex(await verge.p2pkhScript(order.address));
    const carriers = raw.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: sellerScript }));
    await this._annotateRunes(carriers);
    const proven = carriers.filter((c) => c.runes !== undefined);
    if (!proven.length) throw new Error('none of this seller\'s coins could be proven against the published root');

    const q = runebid.quote({ order, carriers: proven, amount: units, alreadySold: alreadySold || 0 });
    if (!q.ok) throw new Error(q.reason);

    const fee = feeUnits == null ? 2_000_000 : Number(feeUnits);
    const need = q.priceUnits + DUST_UNITS + fee;
    const mine = spendableForPayment(await this.getUtxos());
    const funds = [];
    let have = 0;
    for (const u of mine.sort((x, y) => y.value - x.value)) {
      if (have >= need) break;
      funds.push(u); have += u.value;
    }
    if (have < need) throw new Error(`this bid needs ${(need / 1e6).toFixed(6)} XVG of clean coin, you have ${(have / 1e6).toFixed(6)}`);

    const bid = await runebid.buildRuneBid({
      carriers: q.carriers, runeRef: order.runeRef, amount: units, priceUnits: q.priceUnits,
      buyerAddress: this._address, priv: this._priv, funds, feeUnits: fee,
      marketFeeUnits, feeAddress,
    });
    await this._post('/api/runes/bid', { bid });
    return { bid, pays: q.priceUnits, gets: units, carriers: q.carriers.length };
  }

  /**
   * Move a rune to somebody else.
   *
   * The layout is the one the indexer reads: output 0 is the OP_RETURN carrying the edict, output 1
   * is the recipient's carrier, output 2 is the change carrier that keeps whatever was not sent.
   * Coins are chosen by selectForRuneTransfer, which never picks a coin carrying a DIFFERENT rune:
   * an unnamed rune on an input goes to the first non-OP_RETURN output by protocol default, so a
   * careless selection would hand somebody else's coin away with the one being sent.
   */
  async sendRune({ runeRef, amount, to, feeUnits }) {
    if (!to) throw new Error('a destination address is required');
    const units = Number(amount);
    if (!Number.isInteger(units) || units <= 0) throw new Error('the amount must be a whole number of units above zero');

    const utxos = await this.getUtxos();
    if (utxos.some((u) => u.runes === undefined)) {
      throw new Error('some coins could not be verified against the published root, so nothing was moved');
    }
    const fee = feeUnits || DUST_UNITS * 2;
    // selectForRuneTransfer THROWS on a short balance rather than returning empty, which is the
    // right shape: a caller that forgot to check a return value would otherwise build and broadcast
    // a transaction that moves nothing. Its message already says need and hold, so it is passed on.
    let sel;
    try {
      sel = selectForRuneTransfer(utxos, runeRef, units, { targetValue: DUST_UNITS, fee });
    } catch (e) {
      throw new Error(e && e.message ? e.message : 'not enough of that rune to send');
    }
    if (!sel.inputs || !sel.inputs.length) throw new Error('no coins could be selected for this transfer');

    const payload = encodeEdicts([{ runeRef, amount: units, output: 1 }]);
    const outputs = [
      { script: edictScript(payload), value: 0 },
      { address: to, value: DUST_UNITS },
    ];
    const change = sel.inputs.reduce((s, u) => s + u.value, 0) - DUST_UNITS - fee;
    if (change < DUST_UNITS) throw new Error('not enough XVG left to keep a carrier for the change');
    outputs.push({ address: this.address, value: change });

    const tx = await verge.buildAndSignP2PKH({
      inputs: sel.inputs.map((u) => ({ ...u, privateKey: this._priv })),
      outputs,
      time: Math.floor(Date.now() / 1000),
    });
    const txid = await this._post('/api/broadcast', { hex: tx.hex });
    return { txid: (txid && txid.txid) || txid, hex: tx.hex, sent: units, runeRef };
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
      timeOf: (ins) => this._spendTime(ins), // change inherits the age of the coins it came from
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
    // Spend ONLY coins explicitly confirmed to carry neither an inscription nor a fungible rune.
    // Both checks are positive: a coin whose status could not be determined is left alone, because
    // a refused payment is an inconvenience and a burnt rune is permanent.
    const spendable = spendableForPayment(utxos).map((u) => ({ ...u, privateKey: this._priv }));

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
    if (total < amount + fee) {
      // Say which problem this is. "Insufficient funds" on a full wallet sends a user looking for
      // money they already have; the real cause is almost always that no coin could be CLEARED for
      // spending, which is a different thing and has a different fix.
      const undetermined = utxos.filter((u) => u.runes === undefined || u.inscription === undefined).length;
      if (undetermined && !spendable.length) {
        throw new Error('None of your coins could be cleared for spending: their inscription or rune '
          + `status could not be determined (${undetermined} of ${utxos.length}). This is a connection `
          + 'problem, not a balance problem. Try again in a moment.');
      }
      throw new Error(`insufficient spendable funds: need ${amount + fee}, have ${total}`);
    }

    const outputs = [{ address: toAddress, value: amount }];
    const change = total - amount - fee;
    if (change >= dust) outputs.push({ address: this._address, value: change });

    const built = await verge.buildAndSignP2PKH({
      inputs: inputs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, privateKey: this._priv })),
      outputs,
      time: await this._spendTime(inputs), // change inherits the age of what paid for it
    });
    if (!broadcast) return { hex: built.hex, txid: built.txid, size: built.size };
    const { txid } = await this.broadcast(built.hex);
    return { txid: txid || built.txid, hex: built.hex, size: built.size };
  }
}

export { verge, vault };
