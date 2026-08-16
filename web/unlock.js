// Recovering a locked ticker price, four years on.
//
// Two rules shape this file.
//
//   CHECKING MUST NEVER BE RISKY. Reading your own timer takes no key, so the lookup asks for
//   nothing but a transaction id, which is public. Somebody should be able to watch the clock run
//   down for four years without ever going near the thing that spends their money.
//
//   THE KEY NEVER LEAVES THE BROWSER. The transaction is built and signed here and only the finished
//   hex is sent. That is not a courtesy, it is the difference between a recovery tool and a phishing
//   page, and it is why the redeem script is rebuilt locally and CHECKED against the lock address
//   rather than taken from the server: this page trusts the chain, not its own backend.

import * as verge from '/ext/lib/verge.js';

const $ = (s) => document.querySelector(s);
const COIN = 1e6;
const xvg = (u) => (u / COIN).toLocaleString('en-US', { maximumFractionDigits: 6 });

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function kv(host, k, v, cls) {
  const r = el('div', 'un-kv' + (cls ? ' ' + cls : ''));
  r.append(el('span', '', k), el('span', '', v));
  host.append(r);
}

let lock = null;      // what the chain says about this etching
let ticking = null;   // the countdown interval

// --- the lock script, rebuilt here rather than trusted ------------------------------------------

function scriptNum(n) {
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.push(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Uint8Array.from(bytes);
}
const push = (data) => verge.concatBytes(Uint8Array.from([data.length]), data);

/** <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG */
function redeemScript(locktime, pubkey) {
  return verge.concatBytes(
    push(scriptNum(locktime)), Uint8Array.from([0xb1, 0x75]), push(pubkey), Uint8Array.from([0xac]),
  );
}

/** The P2SH address that redeem script pays into, so we can check the server told the truth. */
async function p2shAddress(redeem, network) {
  const h = await verge.hash160(redeem);
  return verge.base58Encode(await withChecksum(Uint8Array.from([network.scriptHash, ...h])));
}
async function withChecksum(payload) {
  const d1 = await verge.sha256(payload);
  const d2 = await verge.sha256(d1);
  return verge.concatBytes(payload, d2.slice(0, 4));
}

// --- the countdown ------------------------------------------------------------------------------

function humanGap(seconds) {
  if (seconds <= 0) return 'open now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const years = Math.floor(d / 365);
  const days = d % 365;
  if (years > 0) return `${years} year${years > 1 ? 's' : ''}, ${days} day${days === 1 ? '' : 's'}`;
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}, ${h}h ${m}m`;
  return `${h}h ${m}m ${s}s`;
}

function startTimer(host) {
  if (ticking) clearInterval(ticking);
  const paint = () => {
    const left = lock.locktime - Math.floor(Date.now() / 1000);
    host.textContent = '';
    if (left > 0) {
      host.className = 'un-timer waiting';
      host.append(el('div', 'un-timer-num', humanGap(left)));
      host.append(el('div', 'un-timer-sub', 'until ' + new Date(lock.locktime * 1000)
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })));
    } else if (!lock.open) {
      // The clock has passed but the chain has not caught up: it judges by median time past, which
      // trails real time by around an hour. Saying "open" here would produce a refused transaction.
      host.className = 'un-timer waiting';
      host.append(el('div', 'un-timer-num', 'almost'));
      host.append(el('div', 'un-timer-sub',
        'the date has passed, and the chain confirms a lock about an hour later. Check back shortly.'));
    } else {
      host.className = 'un-timer open';
      host.append(el('div', 'un-timer-num', 'Open'));
      host.append(el('div', 'un-timer-sub', 'your coins are yours to take back'));
    }
  };
  paint();
  ticking = setInterval(paint, 1000);
}

// --- step one: find the lock ---------------------------------------------------------------------

$('#un-look').addEventListener('click', async () => {
  const txid = $('#un-txid').value.trim();
  const found = $('#un-found');
  found.hidden = false;
  found.textContent = 'Looking…';
  $('#un-claim-step').hidden = true;

  let r;
  try {
    const res = await fetch('/api/runes/lock?txid=' + encodeURIComponent(txid));
    r = await res.json();
    if (r.error) throw new Error(r.error);
  } catch (e) {
    found.textContent = '';
    found.append(el('p', 'un-err', e.message));
    return;
  }
  lock = r;

  found.textContent = '';
  const box = el('div');
  kv(box, 'Coin', r.display || r.ticker, 'lead');
  kv(box, 'Locked', xvg(r.value) + ' XVG', 'lead');
  kv(box, 'Sitting at', r.lockAddress);
  found.append(box);

  const timer = el('div', 'un-timer');
  found.append(timer);
  startTimer(timer);

  if (r.claimed) {
    found.append(el('p', 'un-note', 'This lock has already been emptied. If that was not you, the '
      + 'key is not only yours.'));
    return;
  }
  $('#un-claim-step').hidden = false;
  $('#un-claim').disabled = !r.open;
  if (!r.open) {
    $('#un-claim').textContent = 'Not open yet';
  }
});

// --- step two: take it back ----------------------------------------------------------------------

$('#un-claim').addEventListener('click', async () => {
  const out = $('#un-result');
  const btn = $('#un-claim');
  out.hidden = false;
  out.textContent = 'Building and signing, here in your browser…';
  btn.disabled = true;

  try {
    const wif = $('#un-wif').value.trim();
    const dest = $('#un-dest').value.trim();
    if (!wif || !dest) throw new Error('the key and the destination are both needed');

    const info = await (await fetch('/api/info')).json();
    // Looked up rather than guessed. Address prefixes differ per network, so falling back to
    // mainnet on a server running something else would derive a different address and report "that
    // key does not open this lock" to somebody holding exactly the right key. Refusing to guess is
    // the only answer that cannot mislead.
    const network = verge.NETWORKS[info.network];
    if (!network) {
      throw new Error(`this page does not know the address format of the "${info.network}" network, `
        + 'so it will not guess at where your coins are. Use the command line tool instead.');
    }

    const { privateKey } = await verge.wifToPrivateKey(wif);
    const pub = verge.publicKeyFromPrivate(privateKey);

    // Rebuild the lock from public numbers and check it lands on the address holding the money. If
    // the key is the wrong one, this is where it is caught, before anything is broadcast.
    const redeem = redeemScript(lock.locktime, pub);
    const derived = await p2shAddress(redeem, network);
    if (derived !== lock.lockAddress) {
      throw new Error('that key does not open this lock: it derives ' + derived
        + ', but the coins are at ' + lock.lockAddress);
    }

    const FEE = 200000;
    const value = lock.value - FEE;
    if (value <= 0) throw new Error('the fee would take everything');

    const tx = {
      version: 1,
      time: Math.floor(Date.now() / 1000),
      // A final input makes a node ignore nLockTime entirely, which is exactly the spend the lock
      // is there to refuse. It must be non-final for the deadline to be checked at all.
      vin: [{ txid: lock.txid, vout: lock.vout, sequence: 0xfffffffe, script: new Uint8Array(0) }],
      vout: [{ value, script: await verge.outputScript(dest) }],
      locktime: lock.locktime >>> 0,
    };
    const sighash = await verge.legacySighash(tx, 0, redeem, verge.SIGHASH_ALL);
    const sig = await verge.signHashWith(sighash, privateKey, verge.SIGHASH_ALL);
    tx.vin[0].script = verge.concatBytes(push(sig), push(redeem));

    const hex = verge.bytesToHex(verge.serializeTx(tx));
    const sent = await (await fetch('/api/wallet/broadcast', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawtx: hex }),
    })).json();
    if (sent.error) throw new Error(sent.error);

    out.textContent = '';
    out.append(el('h3', '', 'Sent'));
    const box = el('div');
    kv(box, 'Recovered', xvg(value) + ' XVG', 'lead');
    kv(box, 'To', dest);
    kv(box, 'Transaction', sent.txid || sent.result || '(broadcast)');
    out.append(box);
  } catch (e) {
    out.textContent = '';
    out.append(el('p', 'un-err', e.message));
    btn.disabled = false;
  }
});
