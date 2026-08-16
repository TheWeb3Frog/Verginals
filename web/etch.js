// Etch a Verge Rune.
//
// The form validates locally so the arithmetic is instant, but the ETCHING ITSELF is composed by the
// server, which runs the same src/runes/builder.js the end-to-end suites drive against a real chain.
// Nothing here reimplements the protocol: a second implementation living in a page is a second
// implementation to keep in step, and the first time it drifted somebody would pay for a name they
// did not get.
//
// The one thing that must NOT happen on the server is the unlock key. It is generated here, in the
// browser, and only its public half is ever sent: that key is the only way to reopen the ticker
// price in four years.

import { generatePrivateKey, publicKeyFromPrivate, privateKeyToWIF, bytesToHex, NETWORKS }
  from '/verge-crypto.js';

const $ = (s) => document.querySelector(s);
const COIN = 1e6;
const SEP = '•';
const MAX_NAME = 26;
const MAX_TYPED = MAX_NAME * 2 - 1;

const fmt = (n) => n.toLocaleString('en-US');
const xvg = (units) => (units / COIN).toLocaleString('en-US', { maximumFractionDigits: 6 });

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function kv(host, k, v, cls) {
  const r = el('div', 'et-kv' + (cls ? ' ' + cls : ''));
  r.append(el('span', '', k), el('span', '', v));
  host.append(r);
}

// --- the price schedule, §7 ---------------------------------------------------------------------
// Mirrored here only to show a number as somebody types. The server recomputes it from tickers.js
// and its answer is the one that gets etched, so a drift here is a cosmetic bug, never a payment one.
const PRICE_XVG = { 1: 100000, 2: 50000, 3: 25000, 4: 10000, 5: 5000, 6: 2500,
  7: 1000, 8: 500, 9: 250, 10: 100, 11: 50 };
const priceOf = (n) => (n >= 12 ? 10 : PRICE_XVG[n] || 0) * COIN;

// --- ticker input: separators are free and never end a name -------------------------------------

const bare = (s) => s.split(SEP).join('');

/** Trim to `max` REAL characters, and never leave a name ending on a separator. */
function clampTicker(typed) {
  let out = '';
  let seen = 0;
  for (const ch of typed) {
    if (ch === SEP) { if (seen > 0 && seen < MAX_NAME) out += SEP; continue; }
    if (seen >= MAX_NAME) break;
    out += ch;
    seen += 1;
  }
  return out.replace(new RegExp(SEP + '+$'), '');
}

const tickerInput = $('#et-ticker');
let armed = false; // a space arms the next gap; the bullet appears with the character after it

tickerInput.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    if (bare(tickerInput.value).length > 0) armed = true;
  }
});

tickerInput.addEventListener('input', () => {
  let v = tickerInput.value.toUpperCase().replace(/[^A-Z0-9•]/g, '');
  v = v.replace(new RegExp(SEP + '+', 'g'), SEP).replace(new RegExp('^' + SEP + '+'), '');
  if (armed && v.length && v[v.length - 1] !== SEP) {
    v = v.slice(0, -1) + SEP + v.slice(-1);
    armed = false;
  }
  tickerInput.value = clampTicker(v).slice(0, MAX_TYPED);
  refresh();
});

// --- the unlock key ------------------------------------------------------------------------------

let lockKey = null; // { wif, pubHex }

$('#et-genkey').addEventListener('click', async () => {
  const net = NETWORKS.mainnet;
  const priv = generatePrivateKey();
  const pub = publicKeyFromPrivate(priv);
  lockKey = { wif: await privateKeyToWIF(priv, net), pubHex: bytesToHex(pub) };

  const host = $('#et-key-out');
  host.textContent = '';
  host.append(el('p', '', 'Save this. It is the only way to reopen your locked coins in four years, '
    + 'and nobody can regenerate it for you. It was made in this browser and never sent anywhere.'));
  host.append(el('div', 'et-key', lockKey.wif));
  const pk = el('p', '', 'public half sent with the etching: ' + lockKey.pubHex.slice(0, 24) + '…');
  pk.style.opacity = '.6';
  host.append(pk);
  refresh();
});

// --- open mint toggle ----------------------------------------------------------------------------

$('#et-openmint').addEventListener('change', (e) => {
  $('#et-terms').hidden = !e.target.checked;
  refresh();
});

// --- reading the form ----------------------------------------------------------------------------

const int = (sel) => {
  const raw = $(sel).value.replace(/[\s,]/g, '');
  if (raw === '') return null;
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
};

function readForm() {
  const typed = tickerInput.value;
  const name = bare(typed);
  const supply = int('#et-supply');
  const premine = int('#et-premine');
  const divisibility = int('#et-div');
  const open = $('#et-openmint').checked;
  const perMint = open ? int('#et-per') : null;
  const cap = open ? int('#et-cap') : null;
  const priceRaw = open ? $('#et-price').value.replace(/[\s,]/g, '') : '';
  const mintPrice = open && priceRaw !== '' ? Math.round(Number(priceRaw) * COIN) : 0;

  const problems = [];
  if (!name) problems.push('the ticker is empty');
  else if (!/^[A-Z0-9]{1,26}$/.test(name)) problems.push('a ticker is 1 to 26 characters of A-Z and 0-9');
  if (!Number.isInteger(supply) || supply <= 0) problems.push('the supply must be a whole number above zero');
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) problems.push('decimals must be 0 to 6');
  if (!Number.isInteger(premine) || premine < 0) problems.push('the amount kept must be a whole number');
  else if (Number.isInteger(supply) && premine > supply) problems.push('you cannot keep more than the supply');
  if (open) {
    if (!Number.isInteger(perMint) || perMint <= 0) problems.push('units per claim must be a whole number above zero');
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) problems.push('the maximum number of claims must be a whole number');
    if (!Number.isFinite(mintPrice) || mintPrice < 0) problems.push('the fee per claim is not a number');
    else if (mintPrice > 49 * COIN) problems.push('the fee per claim cannot exceed 49 XVG');
    if (Number.isInteger(supply) && Number.isInteger(premine) && premine >= supply) {
      problems.push('an open mint needs supply left over: lower what you keep');
    }
  }
  if (!$('#et-recipient').value.trim()) problems.push('an address to receive your coins is missing');
  if (!lockKey) problems.push('generate your unlock key');

  return { typed, name, supply, premine, divisibility, open, perMint, cap, mintPrice, problems };
}

// --- live readouts -------------------------------------------------------------------------------

function refresh() {
  const f = readForm();

  const tOut = $('#et-ticker-out');
  tOut.textContent = '';
  if (f.name) {
    const price = priceOf(f.name.length);
    kv(tOut, 'The coin is', f.name, 'lead');
    if (f.typed !== f.name) kv(tOut, 'Shown as', f.typed);
    kv(tOut, 'Characters', String(f.name.length) + ' (separators are free)');
    kv(tOut, 'Price to claim it', xvg(price) + ' XVG', 'warn');
    const releases = new Date(Date.now() + 1460 * 86400e3);
    kv(tOut, 'Yours again on', releases.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
  }

  const sOut = $('#et-supply-out');
  sOut.textContent = '';
  if (Number.isInteger(f.supply) && f.supply > 0 && Number.isInteger(f.divisibility)
    && f.divisibility >= 0 && f.divisibility <= 6 && Number.isInteger(f.premine) && f.premine >= 0) {
    const unit = 10 ** f.divisibility;
    kv(sOut, 'Whole coins', fmt(f.supply / unit));
    kv(sOut, 'You keep', fmt(f.premine / unit) + (f.supply ? `  (${(f.premine / f.supply * 100).toFixed(1)}%)` : ''));
    if (f.open && Number.isInteger(f.perMint) && f.perMint > 0) {
      const claimable = f.supply - f.premine;
      const claims = f.cap !== null ? Math.min(f.cap, Math.floor(claimable / f.perMint)) : Math.floor(claimable / f.perMint);
      kv(sOut, 'Others can claim', fmt(claims) + ' times, ' + fmt(f.perMint / unit) + ' each');
      if (f.mintPrice > 0) kv(sOut, 'Taking all of it costs', xvg(claims * f.mintPrice) + ' XVG in fees');
    }
  }

  const review = $('#et-review');
  review.textContent = '';
  if (f.problems.length) {
    review.append(el('p', '', 'Before you can compose this:'));
    const ul = el('ul');
    for (const p of f.problems) ul.append(el('li', '', p));
    review.append(ul);
    $('#et-compose').disabled = true;
  } else {
    const price = priceOf(f.name.length);
    kv(review, 'Ticker price, locked four years', xvg(price) + ' XVG');
    kv(review, 'To fund the inscription', 'about ' + xvg(4 * 100000) + ' XVG');
    kv(review, 'Total you need', xvg(price + 4 * 100000) + ' XVG', 'lead');
    review.append(el('p', 'et-note', 'The ticker price is not spent and not burnt. It returns to the '
      + 'key you generated, four years from the block that confirms this.'));
    $('#et-compose').disabled = false;
  }
}

// --- composing ------------------------------------------------------------------------------------

$('#et-compose').addEventListener('click', async () => {
  const f = readForm();
  if (f.problems.length) return;
  const btn = $('#et-compose');
  const out = $('#et-result');
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Composing…';

  const payload = {
    ticker: f.typed,
    name: $('#et-name').value.trim() || undefined,
    divisibility: f.divisibility,
    supply: f.supply,
    premine: f.premine,
    recipient: $('#et-recipient').value.trim(),
    lockPubkey: lockKey.pubHex,
  };
  if (f.open) {
    payload.terms = { amount: f.perMint };
    if (f.cap !== null) payload.terms.cap = f.cap;
    if (f.mintPrice > 0) payload.terms.price = f.mintPrice;
  }

  let r;
  try {
    const res = await fetch('/api/runes/etch/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    r = await res.json();
    if (r.error) throw new Error(r.error);
  } catch (e) {
    out.textContent = '';
    out.append(el('p', 'et-err', 'Could not compose: ' + e.message));
    btn.disabled = false;
    return;
  }

  out.textContent = '';
  out.append(el('h3', '', 'Your etching, composed'));
  const box = el('div');
  kv(box, 'Coin', r.display || r.ticker, 'lead');
  kv(box, 'Definition', r.bodyBytes + ' bytes of CBOR');
  kv(box, 'Ticker price', xvg(r.price) + ' XVG');
  kv(box, 'Locked until', new Date(r.lock.releases).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric' }));
  kv(box, 'Lock address', r.lock.address);
  kv(box, 'Inscription funding', xvg(r.commit.total) + ' XVG across ' + r.commit.addresses.length + ' address(es)');
  kv(box, 'Total', xvg(r.cost.total) + ' XVG', 'lead');
  out.append(box);

  out.append(el('h3', '', 'The exact bytes that get written'));
  out.append(el('div', 'et-hex', r.bodyHex));

  const next = el('div');
  if (r.launched) {
    next.append(el('p', '', 'To finish: fund each inscription address, then broadcast the reveal '
      + 'carrying the lock output. The wallet does this for you.'));
  } else {
    next.append(el('p', 'et-note', 'Verge Runes is not switched on yet on this server, so nothing '
      + 'here has been broadcast and no coins have moved. This is the real etching your coin would '
      + 'be made from, composed by the same code that will make it. Etching for real is deliberately '
      + 'held back until an indexer is serving balances, because a ticker costs real money and a '
      + 'name nothing yet honours is not worth paying for.'));
  }
  out.append(next);
  btn.disabled = false;
});

// --- what this server reports ---------------------------------------------------------------------

(async () => {
  const box = $('#et-status');
  try {
    const info = await (await fetch('/api/info', { headers: { accept: 'application/json' } })).json();
    if (info.runes) {
      box.textContent = 'Verge Runes is live on this server';
      box.className = 'et-status live';
    } else {
      box.textContent = 'Verge Runes is not switched on yet: you can compose an etching, nothing is broadcast';
      box.className = 'et-status off';
    }
  } catch {
    box.textContent = 'Could not reach this server';
  }
})();

for (const id of ['#et-name', '#et-supply', '#et-div', '#et-premine', '#et-per', '#et-cap',
  '#et-price', '#et-recipient']) {
  $(id).addEventListener('input', refresh);
}
refresh();
