// Proves the encrypted key vault (lib/vault.js): AES-GCM roundtrip, wrong-passphrase rejection,
// tamper detection, and rekey. Runs under Node (WebCrypto global); chrome.storage paths are not
// exercised here (they're thin wrappers over the pure crypto tested below).
//
//   node extension/test-vault.mjs

const V = await import('./lib/vault.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } }

const secret = 'L1Verge_privateKeyWIF_or_hex_1111111111111111111111111111111111';
const pw = 'correct horse battery staple';

// 1. roundtrip
const vault = await V.createVault(secret, pw, { address: 'DXX...', network: 'mainnet' });
ok('vault is v1 with all fields', vault.v === 1 && vault.salt && vault.iv && vault.ciphertext);
ok('meta preserved (non-secret)', vault.meta.address === 'DXX...' && vault.meta.network === 'mainnet');
ok('ciphertext does not contain plaintext', !atob(vault.ciphertext).includes('privateKey'));
const back = await V.openVault(vault, pw);
ok('decrypts back to original secret', back === secret);

// 2. wrong passphrase rejected
let threw = false;
try { await V.openVault(vault, 'wrong pw'); } catch (e) { threw = /wrong passphrase/.test(e.message); }
ok('wrong passphrase throws', threw);

// 3. tamper detection (flip a ciphertext byte -> GCM auth fails)
const tampered = { ...vault };
const ctBytes = Uint8Array.from(atob(vault.ciphertext), (c) => c.charCodeAt(0));
ctBytes[0] ^= 0xff;
tampered.ciphertext = btoa(String.fromCharCode(...ctBytes));
let tamperThrew = false;
try { await V.openVault(tampered, pw); } catch (e) { tamperThrew = true; }
ok('tampered ciphertext rejected', tamperThrew);

// 4. two vaults of same secret differ (random salt+iv)
const vault2 = await V.createVault(secret, pw);
ok('salt differs across vaults', vault.salt !== vault2.salt);
ok('iv differs across vaults', vault.iv !== vault2.iv);
ok('ciphertext differs across vaults', vault.ciphertext !== vault2.ciphertext);

// 5. rekey
const rekeyed = await V.rekeyVault(vault, pw, 'new passphrase 2026');
ok('old passphrase no longer opens rekeyed', await (async () => { try { await V.openVault(rekeyed, pw); return false; } catch { return true; } })());
ok('new passphrase opens rekeyed to original secret', (await V.openVault(rekeyed, 'new passphrase 2026')) === secret);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
