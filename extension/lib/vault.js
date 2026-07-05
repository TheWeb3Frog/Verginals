// Encrypted key vault for the Verginals wallet (ESM, WebCrypto only).
//
// Stores the wallet's private key(s) encrypted at rest with AES-256-GCM, using a key derived from
// the user's passphrase via PBKDF2-SHA256. The plaintext private key exists in memory ONLY while
// the wallet is unlocked (held by the background service worker), and is wiped on lock.
//
// Storage shape (chrome.storage.local under key 'verginals.vault'):
//   { v: 1, kdf: 'PBKDF2', hash: 'SHA-256', iterations, salt, iv, ciphertext, meta }
// salt/iv/ciphertext are base64. `meta` holds non-secret hints (address, network, createdAt).
//
// This module does not import verge.js; callers pass in the raw secret to encrypt (a hex string of
// the private key, or a JSON blob for multi-key wallets). Keeping it dependency-free keeps the
// trusted crypto surface tiny and independently testable.

const STORAGE_KEY = 'verginals.vault';       // legacy single-wallet blob (pre-keyring); still read for migration
const KEYRING_KEY = 'verginals.keyring';     // multi-wallet keyring: many encrypted vaults under one passphrase
const DEFAULT_ITERATIONS = 310000; // OWASP 2023 floor for PBKDF2-SHA256
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt `secret` (string) under `passphrase`, returning the serializable vault object.
 * @param {string} secret
 * @param {string} passphrase
 * @param {Object} [meta]  non-secret metadata to store alongside (address, network, ...)
 */
export async function createVault(secret, passphrase, meta = {}, iterations = DEFAULT_ITERATIONS) {
  if (!secret) throw new Error('secret required');
  if (!passphrase) throw new Error('passphrase required');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret)));
  return {
    v: 1,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(ct),
    meta,
  };
}

/**
 * Decrypt a vault object with `passphrase`. Throws on wrong passphrase (GCM auth failure).
 * @returns {string} the original secret
 */
export async function openVault(vault, passphrase) {
  if (!vault || vault.v !== 1) throw new Error('unsupported vault');
  const salt = b64decode(vault.salt);
  const iv = b64decode(vault.iv);
  const ct = b64decode(vault.ciphertext);
  const key = await deriveKey(passphrase, salt, vault.iterations || DEFAULT_ITERATIONS);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch (e) {
    throw new Error('wrong passphrase');
  }
  return dec.decode(pt);
}

/** Re-encrypt a vault under a new passphrase (change-password). */
export async function rekeyVault(vault, oldPassphrase, newPassphrase) {
  const secret = await openVault(vault, oldPassphrase);
  return createVault(secret, newPassphrase, vault.meta, vault.iterations);
}

// --- chrome.storage.local persistence (guarded so the module also runs under Node tests) ---
function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

export async function saveVault(vault) {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  await chrome.storage.local.set({ [STORAGE_KEY]: vault });
}

export async function loadVault() {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got[STORAGE_KEY] || null;
}

export async function hasVault() {
  if (!hasChromeStorage()) return false;
  return (await loadVault()) !== null;
}

export async function deleteVault() {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  await chrome.storage.local.remove(STORAGE_KEY);
}

// --- keyring persistence ---------------------------------------------------
// The keyring is a plain object holding many per-wallet vault blobs plus non-secret labels/pointers.
// Every wallet's secret stays encrypted (each `wallet.vault` is a standard createVault blob); only
// labels, addresses and the active pointers are stored in the clear, exactly like the old meta.
//   { v, activeWalletId, wallets: [{ id, label, type, network, createdAt, activeAccount,
//                                    vault, accounts: [{ index, label, address }] }] }
export async function saveKeyring(keyring) {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  await chrome.storage.local.set({ [KEYRING_KEY]: keyring });
}

export async function loadKeyring() {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  const got = await chrome.storage.local.get(KEYRING_KEY);
  return got[KEYRING_KEY] || null;
}

export async function hasKeyring() {
  if (!hasChromeStorage()) return false;
  return (await loadKeyring()) !== null;
}

export async function deleteKeyring() {
  if (!hasChromeStorage()) throw new Error('chrome.storage unavailable');
  await chrome.storage.local.remove(KEYRING_KEY);
}

export { STORAGE_KEY, KEYRING_KEY, DEFAULT_ITERATIONS };
