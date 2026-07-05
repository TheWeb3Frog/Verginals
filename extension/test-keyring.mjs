// Exercises the flat keyring end-to-end with an in-memory chrome.storage stub (no network).
// Model: one shared recovery phrase, a flat list of accounts where each account is a single address.
// Proves: derive more addresses from the shared phrase; import a standalone WIF address; one-click
// switching rederives the right key; rename/remove with last-account guard; passphrase-gated reveal
// (shared phrase) + per-account export; a legacy single vault migrates into the keyring on unlock;
// lock/unlock restores every secret and the active pointer.

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

console.log('flat keyring (one seed, per-address accounts):');
const PW = 'correct horse battery staple';
const w = new Wallet();

// Create establishes the shared phrase + passphrase and the first (derived) account.
const c1 = await w.create(PW);
ok(isAddr(c1.address), `account 1 (derived index 0) -> ${c1.address}`);
ok(typeof c1.mnemonic === 'string' && c1.mnemonic.split(' ').length === 12, 'create returns the phrase once');
const a0 = c1.address;

// Add a second derived address from the same phrase; it becomes active.
const acc2 = await w.addAccount('Cold');
ok(isAddr(acc2.address) && acc2.address !== a0, `addAccount -> distinct derived address ${acc2.address}`);
ok(w.address === acc2.address, 'switched to the new account');
const a1 = acc2.address;

// Import a standalone WIF (not covered by the phrase). Reuse a derived key as a known-valid WIF.
const importedWif = await w.exportWIF(PW, 'a1'); // WIF of account 1 (index 0)
let dupThrew = false; try { await w.importAccount(importedWif, 'Dup'); } catch { dupThrew = true; }
ok(dupThrew, 'importing a key whose address already exists is rejected');

// A fresh, unrelated key: back a throwaway wallet with its own store to mint an independent WIF.
const tmpStore = new Map();
const savedGet = chrome.storage.local.get, savedSet = chrome.storage.local.set, savedRem = chrome.storage.local.remove;
chrome.storage.local.get = async (k) => { const key = typeof k === 'string' ? k : Object.keys(k)[0]; return tmpStore.has(key) ? { [key]: tmpStore.get(key) } : {}; };
chrome.storage.local.set = async (o) => { for (const k of Object.keys(o)) tmpStore.set(k, o[k]); };
chrome.storage.local.remove = async (k) => { tmpStore.delete(k); };
const tmp = new Wallet();
await tmp.create('another pass phrase');
const freshWif = await tmp.exportWIF('another pass phrase', 'a1');
chrome.storage.local.get = savedGet; chrome.storage.local.set = savedSet; chrome.storage.local.remove = savedRem;

const imp = await w.importAccount(freshWif, 'Imported');
ok(isAddr(imp.address), `importAccount -> standalone address ${imp.address}`);
ok(w.address === imp.address, 'switched to the imported account');
const impId = imp.id;

// Switch back to the first account (one-click), rederiving its key from the shared seed.
await w.selectAccount('a1');
ok(w.address === a0, 'one-click switch back rederives account 1');

// Snapshot: three accounts (2 derived + 1 imported), a seed exists, no secrets leaked.
const list = await w.list();
ok(list.accounts.length === 3, 'list has 3 accounts');
ok(list.hasSeed === true, 'list reports a shared seed exists');
ok(list.accounts.filter((a) => a.kind === 'imported').length === 1, 'one imported account');
ok(JSON.stringify(list).indexOf(c1.mnemonic.split(' ')[0]) === -1, 'list carries no mnemonic words');

// Rename.
await w.renameAccount(impId, 'Hot key');
ok((await w.list()).accounts.find((a) => a.id === impId).label === 'Hot key', 'renameAccount applied');

// Reveal (shared phrase) + export (per account) are passphrase-gated.
const phrase = await w.revealMnemonic(PW);
ok(phrase === c1.mnemonic, 'revealMnemonic returns the shared phrase');
const wifImp = await w.exportWIF(PW, impId);
ok(isWif(wifImp) && wifImp === freshWif, 'exportWIF(imported) returns its stored WIF');
let threw = false; try { await w.revealMnemonic('nope'); } catch { threw = true; }
ok(threw, 'wrong passphrase rejected on reveal');

// Lock + unlock decrypts everything and restores the active pointer (account 1).
w.lock();
ok(!w.isUnlocked, 'lock clears keys');
const u = await w.unlock(PW);
ok(u.address === a0, 'unlock restores the active account');
const info = w.activeInfo();
ok(info.id === 'a1' && info.kind === 'derived', 'activeInfo reflects the pointer');

// Remove the extra derived account, then the imported one; guard protects the last account.
await w.removeAccount('a2');
ok((await w.list()).accounts.length === 2, 'removeAccount drops the derived one');
await w.removeAccount(impId);
const finalList = await w.list();
ok(finalList.accounts.length === 1, 'removeAccount drops the imported one');
ok(w.address === a0, 'active falls back to the surviving account');
let guard = false; try { await w.removeAccount('a1'); } catch { guard = true; }
ok(guard, 'cannot remove the only account');

// Legacy migration: a pre-keyring single vault becomes the first (derived) account on unlock.
store.clear();
const legacyWallet = new Wallet();
const seedHelper = new Wallet();
await seedHelper.importMnemonic(c1.mnemonic, PW);
const kr = store.get(V.KEYRING_KEY);
const legacyVault = kr.seedVault;
legacyVault.meta = { ...legacyVault.meta, type: 'mnemonic', address: a0 };
store.clear();
store.set(V.STORAGE_KEY, legacyVault);
ok(await legacyWallet.exists(), 'exists() true from a legacy vault alone');
const lu = await legacyWallet.unlock(PW);
ok(lu.address === a0, 'legacy vault unlocks to its original address');
ok(store.has(V.KEYRING_KEY), 'legacy vault migrated into a keyring');
const lgl = await legacyWallet.list();
ok(lgl.accounts.length === 1 && lgl.accounts[0].kind === 'derived', 'migrated account is derived index 0');
ok(lgl.hasSeed === true, 'migrated wallet keeps its shared phrase');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
