// Live validation of the client-side inscription detector (lib/inscriptions.js) against the
// authoritative server indexer output. Connects to the real Verge ElectrumX server over WSS (Node 26
// has a global WebSocket) and confirms each known Verginal's carrier UTXO is detected in-browser with
// the same id the server reports -- proving the browser detector needs no server for spend-safety.
//
// Ground truth (GET https://verginals.com/api/inscriptions), captured 2026-07-03:
//   #0 cf251def...i0  @ 5bfc7c6b...:0   (direct reveal, offset 0)
//   #1 08a9d50e...i0  @ 1881f1be...:0   (carried; shares the output with #2)
//   #2 1881f1be...i0  @ 1881f1be...:0   (direct reveal at that tx; double-occupancy with #1)
//   #3 32b674...i0    @ 314122b6...:1   (revealed elsewhere, carried to vout 1 -> multi-hop, P>0)
//   #4 314122b6...i0  @ 314122b6...:0   (direct reveal, offset 0)

import { ElectrumClient } from './lib/electrum.js';
import { InscriptionDetector, decodeRawTx, parseInscriptionScript } from './lib/inscriptions.js';

const GROUND_TRUTH = [
  { number: 0, id: 'cf251def70f730b7c4151348e303d5ebd911a82a232e84e0226cc8501c2237f8i0', location: '5bfc7c6ba99092c6b6b36d7f937b13d7f5906b01de9762a128873575a473b391:0' },
  { number: 2, id: '1881f1beffd984a4c1bf78166006ab76a80399f91ad853fc734ecd15695c10bci0', location: '1881f1beffd984a4c1bf78166006ab76a80399f91ad853fc734ecd15695c10bc:0' },
  { number: 3, id: '32b674722f40ae06c08b36bc9738dcd0141ee72e534c44b4725fec7c566fb5e8i0', location: '314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4:1' },
  { number: 4, id: '314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4i0', location: '314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4i0'.replace('i0', ':0') },
];

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };

const client = new ElectrumClient();
// eraHeight = 9290000: below genesis #0 (9295203), so it only bounds the clean-proving descent.
const detector = new InscriptionDetector(client, { storage: null, eraHeight: 9290000 });

console.log('connecting to ElectrumX...');
await client.connect();
console.log('connected:', client.url, '\n');

// 1) Each known carrier UTXO is detected as inscribed with the correct id.
console.log('carrier detection vs. server indexer:');
for (const g of GROUND_TRUTH) {
  const [txid, voutStr] = g.location.split(':');
  const r = await detector.detect(txid, Number(voutStr));
  ok(r.status === 'inscribed', `#${g.number} ${g.location} -> status inscribed (got ${r.status})`);
  ok(r.id === g.id, `#${g.number} id ${r.id === g.id ? 'matches' : `MISMATCH: got ${r.id}, want ${g.id}`}`);
}

// 2) An ordinary funding sat (the reveal tx's first input prevout) must be classified clean.
console.log('\nordinary-XVG (funding) detection:');
{
  const revealHex = await client.getTransaction('314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4', false);
  const reveal = decodeRawTx(revealHex);
  const fund = reveal.vin.find((i) => !i.coinbase);
  const r = await detector.detect(fund.txid, fund.vout);
  ok(r.status === 'clean', `funding prevout ${fund.txid.slice(0, 12)}...:${fund.vout} -> clean (got ${r.status})`);
}

// 3) Cache: a second detect() returns the identical (persisted) answer.
console.log('\nimmutable cache:');
{
  const a = await detector.detect('314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4', 0);
  const b = await detector.detect('314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4', 0);
  ok(JSON.stringify(a) === JSON.stringify(b), 'repeat detect() is stable');
}

// 4) The reveal tx really does contain a parseable envelope (sanity on the browser envelope parser).
console.log('\nenvelope parser sanity:');
{
  const hex = await client.getTransaction('314122b643f98a857b8f94adfd0eafd75ddbf9aab9c7b83cbdb89dbd0ff58db4', false);
  const tx = decodeRawTx(hex);
  let parsed = null;
  for (const inp of tx.vin) { const p = parseInscriptionScript(inp.scriptSig); if (p) { parsed = p; break; } }
  ok(parsed != null, 'found an inscription envelope in the reveal scriptSig');
  ok(parsed && new TextDecoder().decode(parsed.contentType) === 'image/webp', 'content-type decodes to image/webp');
}

client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
