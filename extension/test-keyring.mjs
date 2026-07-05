// Exercises the multi-wallet keyring end-to-end with an in-memory chrome.storage stub (no network).
// Proves: many wallets under one passphrase; many derived accounts per wallet; one-click switching
// rederives the right key; rename/remove; per-wallet reveal + per-account export; a legacy single
// vault migrates into the keyring on first unlock; unlock decrypts every wallet.

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

console.log('keyring multi-wallet + multi-account:');
const PW = 'correct horse battery staple';
const w = new Wallet();

// First wallet establishes the passphrase.
const c1 = await w.create(PW);
ok(isAddr(c1.address), `wallet 1 account 0 -> ${c1.address}`);
const a0 = c1.address;

// Add a second, independent wallet (own phrase) while unlocked; it becomes active.
const w2 = await w.addWallet({ kind: 'create', label: 'Trading' });
ok(isAddr(w2.address) && w2.address !== a0, 'addWallet -> new independent address, switched active');
ok(typeof w2.mnemonic === 'string' && w2.mnemonic.split(' ').length === 12, 'addWallet(create) returns a phrase once');
ok(w.address === w2.address, 'active address is the new wallet');

// Switch back to wallet 1.
await w.selectAccount('w1', 0);
ok(w.address === a0, 'one-click switch back to wallet 1 rederives its address');

// Add a second account inside wallet 1: different address, same phrase.
const acc = await w.addAccount('w1');
ok(isAddr(acc.address) && acc.address !== a0, `addAccount -> distinct address ${acc.address}`);
ok(acc.index === 1, 'second account is index 1');
ok(w.address === acc.address, 'switched to the new account');
const a1 = acc.address;

// The list snapshot reflects two wallets, wallet 1 with two accounts, no secrets leaked.
const list = await w.list();
ok(list.wallets.length === 2, 'list has 2 wallets');
const kw1 = list.wallets.find((x) => x.id === 'w1');
ok(kw1.accounts.length === 2, 'wallet 1 has 2 accounts');
ok(JSON.stringify(list).indexOf(w2.mnemonic.split(' ')[0]) === -1, 'list carries no mnemonic words');

// Rename.
await w.renameWallet('w1', 'Savings');
await w.renameAccount('w1', 1, 'Cold');
const list2 = await w.list();
ok(list2.wallets.find((x) => x.id === 'w1').label === 'Savings', 'renameWallet applied');
ok(list2.wallets.find((x) => x.id === 'w1').accounts[1].label === 'Cold', 'renameAccount applied');

// Per-wallet reveal + per-account export are passphrase-gated.
const phrase1 = await w.revealMnemonic(PW, 'w1');
ok(phrase1 === c1.mnemonic, 'revealMnemonic(w1) returns wallet 1 phrase');
const wifA1 = await w.exportWIF(PW, 'w1', 1);
ok(/^[1-9A-HJ-NP-Za-km-z]{51,52}$/.test(wifA1), 'exportWIF(w1, account 1) -> WIF');
let threw = false; try { await w.revealMnemonic('nope', 'w1'); } catch { threw = true; }
ok(threw, 'wrong passphrase rejected on reveal');

// Lock + unlock decrypts every wallet and restores the active pointer (wallet 1, account 1 = Cold).
w.lock();
ok(!w.isUnlocked, 'lock clears keys');
const u = await w.unlock(PW);
ok(u.address === a1, 'unlock restores the active account (w1/account1)');
const info = w.activeInfo();
ok(info.walletId === 'w1' && info.accountIndex === 1 && info.walletLabel === 'Savings', 'activeInfo reflects the pointer');

// Remove the extra account, then the second wallet; guards protect the last of each.
await w.removeAccount('w1', 1);
ok(w.address === a0, 'removeAccount falls back to account 0');
await w.removeWallet('w2');
ok((await w.list()).wallets.length === 1, 'removeWallet leaves one wallet');
let guard = false; try { await w.removeWallet('w1'); } catch { guard = true; }
ok(guard, 'cannot remove the only wallet');

// Legacy migration: a pre-keyring single vault becomes wallet 1 on first unlock.
store.clear();
const legacyWallet = new Wallet();
// Build a legacy vault the old way and stash it under the legacy key.
const legacyMnemonic = c1.mnemonic;
const seedHelper = new Wallet();
// Reuse create to obtain a valid vault, then relocate it to the legacy slot and drop the keyring.
await seedHelper.importMnemonic(legacyMnemonic, PW);
const kr = store.get(V.KEYRING_KEY);
const legacyVault = kr.wallets[0].vault;
legacyVault.meta = { ...legacyVault.meta, type: 'mnemonic', address: a0 };
store.clear();
store.set(V.STORAGE_KEY, legacyVault);
ok(await legacyWallet.exists(), 'exists() true from a legacy vault alone');
const lu = await legacyWallet.unlock(PW);
ok(lu.address === a0, 'legacy vault unlocks to its original address');
ok(store.has(V.KEYRING_KEY), 'legacy vault migrated into a keyring');
ok((await legacyWallet.list()).wallets[0].label === 'Wallet 1', 'migrated wallet is labelled Wallet 1');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
