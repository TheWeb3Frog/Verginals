// Exercises the mnemonic wallet lifecycle end-to-end with an in-memory chrome.storage stub (no
// network: create/unlock/reveal/export never touch ElectrumX). Proves: create -> address; the
// mnemonic round-trips through the encrypted vault; unlock rederives the SAME address; a fresh Wallet
// importing the same phrase lands on the same address; wrong passphrase fails; legacy WIF still works.

const store = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(k) { const key = typeof k === 'string' ? k : Object.keys(k)[0]; return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(o) { for (const k of Object.keys(o)) store.set(k, o[k]); },
    async remove(k) { store.delete(k); },
  } },
};

const { Wallet, verge } = await import('./lib/wallet.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };

console.log('mnemonic wallet lifecycle:');
const w = new Wallet();
const created = await w.create('correct horse battery staple');
ok(/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(created.address), `create -> Verge address ${created.address}`);
ok(typeof created.mnemonic === 'string' && created.mnemonic.split(' ').length === 12, 'create returns a 12-word phrase once');
const addr0 = created.address, phrase = created.mnemonic;

w.lock();
ok(!w.isUnlocked, 'lock clears the key');

const unlocked = await w.unlock('correct horse battery staple');
ok(unlocked.address === addr0, 'unlock rederives the same address');

ok((await w.hasMnemonic()) === true, 'hasMnemonic true for seed wallet');
const revealed = await w.revealMnemonic('correct horse battery staple');
ok(revealed === phrase, 'revealMnemonic returns the original phrase');

let threw = false;
try { await w.revealMnemonic('wrong pass'); } catch { threw = true; }
ok(threw, 'wrong passphrase is rejected on reveal');

const wifOut = await w.exportWIF('correct horse battery staple');
ok(/^[1-9A-HJ-NP-Za-km-z]{51,52}$/.test(wifOut), `exportWIF derives a Verge WIF (${wifOut.slice(0, 6)}...)`);

// A separate wallet importing the SAME phrase must reproduce the same address (portability).
store.clear();
const w2 = new Wallet();
const imp = await w2.importMnemonic(phrase, 'another pass');
ok(imp.address === addr0, 'importMnemonic(same phrase) -> same address (portable across wallets)');

// The exported WIF, imported into a fresh legacy wallet, must also yield the same address.
store.clear();
const w3 = new Wallet();
const impWif = await w3.importWIF(wifOut, 'p');
ok(impWif.address === addr0, 'importWIF(derived WIF) -> same address');
ok((await w3.hasMnemonic()) === false, 'hasMnemonic false for WIF wallet');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
