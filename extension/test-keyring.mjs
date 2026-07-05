// Exercises the flat v3 keyring end-to-end with an in-memory chrome.storage stub (no network).
// Model: a flat list of fully independent accounts. Each account is one address that either carries
// its OWN recovery phrase ('seed', created fresh or imported, revealable) or is a standalone private
// key ('key'). There is no shared seed: adding an address mints a brand new phrase, exactly like the
// first one. Proves: mint independent seed addresses; import a standalone WIF; import an external
// phrase (kept and revealable); dedupe by address; one-click switching; rename/remove with the
// last-account guard; passphrase-gated per-account reveal + export; lock/unlock restores every secret
// and the active pointer; a legacy single vault migrates into the keyring on unlock.

const store = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(k) { const key = typeof k === 'string' ? k : Object.keys(k)[0]; return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(o) { for (const k of Object.keys(o)) store.set(k, o[k]); },
    async remove(k) { store.delete(k); },
  } },
};

const { Wallet } = await import('./lib/wallet.js');
const V = await import('./lib/vault.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const isAddr = (a) => /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const isWif = (w) => /^[1-9A-HJ-NP-Za-km-z]{51,52}$/.test(w);

// Mint an independent phrase + its index-0 WIF using a throwaway wallet on its own store, so the
// returned secrets are unrelated to anything in the main keyring (good for import + dedupe tests).
async function mintFresh(pw) {
  const s = new Map();
  const g = chrome.storage.local.get, se = chrome.storage.local.set, rm = chrome.storage.local.remove;
  chrome.storage.local.get = async (k) => { const key = typeof k === 'string' ? k : Object.keys(k)[0]; return s.has(key) ? { [key]: s.get(key) } : {}; };
  chrome.storage.local.set = async (o) => { for (const k of Object.keys(o)) s.set(k, o[k]); };
  chrome.storage.local.remove = async (k) => { s.delete(k); };
  const t = new Wallet();
  const c = await t.create(pw);
  const wif = await t.exportWIF(pw, 'a1');
  chrome.storage.local.get = g; chrome.storage.local.set = se; chrome.storage.local.remove = rm;
  return { mnemonic: c.mnemonic, wif, address: c.address };
}

console.log('flat v3 keyring (independent addresses):');
const PW = 'correct horse battery staple';
const w = new Wallet();

// Create establishes the passphrase and the first (own-phrase) account.
const c1 = await w.create(PW);
ok(isAddr(c1.address), `account 1 -> ${c1.address}`);
ok(typeof c1.mnemonic === 'string' && c1.mnemonic.split(' ').length === 12, 'create returns the phrase once');
ok(c1.id === 'a1', 'first account id is a1');
const a0 = c1.address;

// Add a second address with its OWN fresh phrase; it becomes active and is independent of account 1.
const acc2 = await w.addSeedAccount('Cold');
ok(isAddr(acc2.address) && acc2.address !== a0, `addSeedAccount -> new independent address ${acc2.address}`);
ok(typeof acc2.mnemonic === 'string' && acc2.mnemonic !== c1.mnemonic, 'new address gets its own distinct phrase');
ok(w.address === acc2.address, 'switched to the new account');
const a1 = acc2.address;

// A 24-word own-phrase address, just to prove the strength option flows through.
const acc24 = await w.addSeedAccount('Big', 256);
ok(acc24.mnemonic.split(' ').length === 24, 'addSeedAccount(256) mints a 24-word phrase');
await w.removeAccount(acc24.id); // keep the rest of the test tidy

// Import a standalone WIF (unrelated key). Duplicates are rejected by address.
const fresh1 = await mintFresh('a temporary passphrase one');
const impKey = await w.importAccount(fresh1.wif, 'Imported key');
ok(isAddr(impKey.address) && impKey.address === fresh1.address, `importAccount -> ${impKey.address}`);
ok(w.address === impKey.address, 'switched to the imported key account');
const keyId = impKey.id;
let dupThrew = false; try { await w.importAccount(fresh1.wif, 'Dup'); } catch { dupThrew = true; }
ok(dupThrew, 'importing a WIF whose address already exists is rejected');

// Import an external recovery phrase. The phrase is KEPT for this address and stays revealable.
const fresh2 = await mintFresh('a temporary passphrase two');
const impPhrase = await w.importMnemonicAccount(fresh2.mnemonic, 'Imported phrase');
ok(isAddr(impPhrase.address) && impPhrase.address === fresh2.address, `importMnemonicAccount -> ${impPhrase.address}`);
ok(w.address === impPhrase.address, 'switched to the imported phrase account');
const phraseId = impPhrase.id;
ok((await w.list()).accounts.find((a) => a.id === phraseId).kind === 'seed', 'imported phrase stored as a seed (revealable)');
ok((await w.revealMnemonic(PW, phraseId)) === fresh2.mnemonic, 'imported phrase reveals its own words');
ok((await w.exportWIF(PW, phraseId)) === fresh2.wif, 'imported phrase account exports its index-0 WIF');
let dup2 = false; try { await w.importMnemonicAccount(fresh2.mnemonic, 'Dup2'); } catch { dup2 = true; }
ok(dup2, 'importing the same phrase again is rejected as a duplicate');

// Switch back to the first account (one-click), rederiving its key from its own phrase.
await w.selectAccount('a1');
ok(w.address === a0, 'one-click switch back to account 1');

// Snapshot: four accounts (account 1 + Cold + imported phrase = 3 seed, imported key = 1), no
// secrets leaked into the list.
const list = await w.list();
ok(list.accounts.length === 4, 'list has 4 accounts');
ok(list.accounts.filter((a) => a.kind === 'seed').length === 3, 'three seed accounts');
ok(list.accounts.filter((a) => a.kind === 'key').length === 1, 'one key account');
ok(!('hasSeed' in list), 'list carries no shared-seed flag');
ok(JSON.stringify(list).indexOf(c1.mnemonic.split(' ')[0]) === -1, 'list carries no mnemonic words');

// Rename.
await w.renameAccount(keyId, 'Hot key');
ok((await w.list()).accounts.find((a) => a.id === keyId).label === 'Hot key', 'renameAccount applied');

// Reveal (own phrase) + export (per account) are passphrase-gated.
const phrase = await w.revealMnemonic(PW, 'a1');
ok(phrase === c1.mnemonic, 'revealMnemonic returns account 1 own phrase');
let noPhrase = false; try { await w.revealMnemonic(PW, keyId); } catch { noPhrase = true; }
ok(noPhrase, 'key-only account has no recovery phrase to reveal');
const wifKey = await w.exportWIF(PW, keyId);
ok(isWif(wifKey) && wifKey === fresh1.wif, 'exportWIF(key) returns its stored WIF');
let threw = false; try { await w.revealMnemonic('nope', 'a1'); } catch { threw = true; }
ok(threw, 'wrong passphrase rejected on reveal');

// Lock + unlock decrypts everything and restores the active pointer (account 1).
w.lock();
ok(!w.isUnlocked, 'lock clears keys');
const u = await w.unlock(PW);
ok(u.address === a0, 'unlock restores the active account');
const info = w.activeInfo();
ok(info.id === 'a1' && info.kind === 'seed', 'activeInfo reflects the pointer');

// Remove the extra accounts down to the last one; the guard protects the final survivor.
await w.removeAccount(phraseId);
ok((await w.list()).accounts.length === 3, 'removeAccount drops the imported phrase');
await w.removeAccount(keyId);
ok((await w.list()).accounts.length === 2, 'removeAccount drops the imported key');
await w.removeAccount(acc2.id);
const finalList = await w.list();
ok(finalList.accounts.length === 1, 'removeAccount drops the Cold account');
ok(w.address === a0, 'active falls back to the surviving account');
let guard = false; try { await w.removeAccount('a1'); } catch { guard = true; }
ok(guard, 'cannot remove the only account');

// Legacy migration: a pre-keyring single vault becomes the first (seed) account on unlock.
store.clear();
const legacyWallet = new Wallet();
const seedHelper = new Wallet();
await seedHelper.importMnemonic(c1.mnemonic, PW);
const kr = store.get(V.KEYRING_KEY);
const legacyVault = kr.accounts[0].seedVault;
legacyVault.meta = { ...legacyVault.meta, type: 'mnemonic', address: a0 };
store.clear();
store.set(V.STORAGE_KEY, legacyVault);
ok(await legacyWallet.exists(), 'exists() true from a legacy vault alone');
const lu = await legacyWallet.unlock(PW);
ok(lu.address === a0, 'legacy vault unlocks to its original address');
ok(store.has(V.KEYRING_KEY), 'legacy vault migrated into a keyring');
const lgl = await legacyWallet.list();
ok(lgl.accounts.length === 1 && lgl.accounts[0].kind === 'seed', 'migrated account is a seed at index 0');
ok((await legacyWallet.revealMnemonic(PW)) === c1.mnemonic, 'migrated account keeps its own phrase');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
