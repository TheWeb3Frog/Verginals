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

// The crypto module is loaded ON DEMAND, when somebody asks for a key, and not at the top of this
// file. A static import would make the whole page depend on one more file being present: if it were
// ever missing the module would fail to evaluate and the form would not render at all, which is a
// blank screen caused by a feature most visitors never touch.
let cryptoMod = null;
async function loadCrypto() {
  if (!cryptoMod) cryptoMod = await import('/ext/lib/verge.js');
  return cryptoMod;
}

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
  if (e.key === ' ' || e.code === 'Space') {
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

// { pubHex, derived, index, path, wif? }. `wif` is present ONLY for the fallback path, where the key
// was made in this page and the etcher has to keep it themselves.
let lockKey = null;

/**
 * Ask the wallet for a lock key derived from its own recovery phrase.
 *
 * This is the whole fix. A key made in this page is an orphan: unrelated to anything the etcher
 * already keeps, needed exactly once, four years later, and useless in any other wallet because the
 * coins do not sit at its ordinary address. A derived key needs no backup at all, because the backup
 * happened when they wrote down their twelve words.
 *
 * The private half never leaves the extension. This asks for a public key and gets a public key.
 */
async function deriveFromWallet() {
  const p = window.verge;
  if (!p || !p.isVerginals) return null;
  try {
    // Which index to use is decided by what this wallet has already published on chain, so a second
    // coin never reuses the key of the first.
    let index = 0;
    try {
      const res = await fetch('/api/runes/locks').then((r) => r.json());
      const mine = await p.request({ method: 'runesMyLocks', params: { locks: res.locks || [] } });
      index = mine && Number.isInteger(mine.nextIndex) ? mine.nextIndex : 0;
    } catch (_) { /* an unreachable index service is not a reason to refuse to etch */ }
    const k = await p.request({ method: 'runesLockPubkey', params: { index } });
    return k && k.pubkey ? { pubHex: k.pubkey, derived: true, index: k.index, path: k.path } : null;
  } catch (_) {
    return null;
  }
}

$('#et-genkey').addEventListener('click', async () => {
  const host = $('#et-key-out');

  const fromWallet = await deriveFromWallet();
  if (fromWallet) {
    lockKey = fromWallet;
    host.textContent = '';
    host.append(el('p', '', 'This key comes from your wallet recovery phrase, so there is nothing '
      + 'new to save. In four years, restoring your wallet from your twelve words brings it back, '
      + 'and your wallet will show you the lock with a countdown in the meantime.'));
    const path = el('div', 'et-key', fromWallet.path);
    host.append(path);
    const pk = el('p', '', 'public half sent with the etching: ' + fromWallet.pubHex.slice(0, 24) + '…');
    pk.style.opacity = '.6';
    host.append(pk);
    refresh();
    return;
  }

  host.textContent = '';
  host.append(el('p', 'et-warn', 'No wallet is connected, so this key is being made here instead. '
    + 'It has no relation to any recovery phrase and NOTHING can regenerate it. Connect the '
    + 'Verginals wallet before etching and you will have nothing to save at all.'));

  let mod;
  try {
    mod = await loadCrypto();
  } catch (e) {
    host.textContent = '';
    host.append(el('p', 'et-err', 'The key generator could not be loaded, so a key cannot be made '
      + 'here. Everything else on this page still works, and you can supply a public key from your '
      + 'own wallet instead.'));
    return;
  }
  const priv = mod.generatePrivateKey();
  const pub = mod.publicKeyFromPrivate(priv);
  lockKey = {
    wif: await mod.privateKeyToWIF(priv, mod.NETWORKS.mainnet),
    pubHex: mod.bytesToHex(pub),
  };

  host.textContent = '';
  host.append(el('p', '', 'Save this. It is the only way to reopen your locked coins in four years, '
    + 'and nobody can regenerate it for you. It was made in this browser and never sent anywhere.'));
  host.append(el('div', 'et-key', lockKey.wif));
  const pk = el('p', '', 'public half sent with the etching: ' + lockKey.pubHex.slice(0, 24) + '…');
  pk.style.opacity = '.6';
  host.append(pk);
  // Saying "save the key" is not enough, and the omission is expensive: the coins do not sit at the
  // ordinary address of this key, so somebody importing it into a wallet in four years sees zero and
  // concludes it is gone. They need the release date and the transaction too, and they need to be
  // told where the recovery tool lives before they need it rather than after.
  const note = el('p', 'et-note', 'You will need two more things when the four years are up, and '
    + 'they only exist once your coin is etched: the release date and the etch transaction id. '
    + 'Compose below and this page hands you all three together.');
  host.append(note);
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

// The share control. Presets and the slider write the same value, and the readout follows both, so
// there is never a number on screen that the form does not actually hold.
(function () {
  const range = document.getElementById('et-keep');
  const out = document.getElementById('et-keep-out');
  const paint = () => { out.textContent = range.value + '%'; };
  range.addEventListener('input', () => { paint(); refresh(); });
  for (const b of document.querySelectorAll('[data-keep]')) {
    b.addEventListener('click', () => { range.value = b.dataset.keep; paint(); refresh(); });
  }
  paint();
})();

function readForm() {
  const typed = tickerInput.value;
  const symbol = Array.from($('#et-symbol').value.trim()).slice(0, 1).join('');
  const name = bare(typed);
  const supply = int('#et-supply');
  // Kept as a SHARE of the supply, never as a free number. It used to be a plain input, and a
  // person could type more than the supply, get a valid looking form, pay, and have the etching
  // silently ignored by every indexer. A share cannot express that mistake at all.
  const keepPct = Math.max(0, Math.min(100, Number($('#et-keep').value) || 0));
  const supplyOk = Number.isInteger(supply) && supply > 0;
  const premine = supplyOk ? Math.round(supply * keepPct / 100) : 0;
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

  if (open) {
    if (!Number.isInteger(perMint) || perMint <= 0) problems.push('units per claim must be a whole number above zero');
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) problems.push('the maximum number of claims must be a whole number');
    if (!Number.isFinite(mintPrice) || mintPrice < 0) problems.push('the fee per claim is not a number');
    else if (mintPrice > 49 * COIN) problems.push('the fee per claim cannot exceed 49 XVG');
    if (Number.isInteger(supply) && Number.isInteger(premine) && premine >= supply) {
      problems.push('an open mint needs supply left over: keep less than all of it');
    }
  }
  if (!$('#et-recipient').value.trim()) problems.push('an address to receive your coins is missing');
  if (!lockKey) problems.push('get your unlock key');

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
    kv(sOut, 'You keep', fmt(f.premine / unit) + ' of them');
    kv(sOut, 'Everyone else can have', fmt((f.supply - f.premine) / unit));
    if (f.open && Number.isInteger(f.perMint) && f.perMint > 0) {
      const claimable = f.supply - f.premine;
      const claims = f.cap !== null ? Math.min(f.cap, Math.floor(claimable / f.perMint)) : Math.floor(claimable / f.perMint);
      kv(sOut, 'Others can claim', fmt(claims) + ' times, ' + fmt(f.perMint / unit) + ' each');
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
    kv(review, 'Miner fees and the inscription', 'about ' + xvg(4 * 100000) + ' XVG');
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
    symbol: f.symbol || undefined,
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

  // Deliberately NOT a recovery card yet. The lock address and the release date shown above belong
  // to this composition and nothing else: etching for real computes them again at that moment, and
  // ten seconds of difference is a different address. Printing them as something to keep would hand
  // somebody a card pointing at an address that never held their money, which is the exact failure
  // this whole feature exists to prevent. The real card is printed once, after the etching.
  out.append(el('p', 'et-note', 'The lock address and release date above are for this preview. They '
    + 'are decided at the moment you etch, and you get them, with everything else you need to '
    + 'recover your coins, once the coin exists.'));

  const next = el('div');
  if (r.launched) {
    const go = el('button', 'et-btn', 'Etch it for real');
    next.append(el('p', 'et-note', 'This is the last reversible moment. Once you pay, the coin is '
      + 'made and everything above is permanent.'));
    next.append(go);
    const live = el('div', 'et-result');
    next.append(live);
    go.addEventListener('click', () => { go.disabled = true; startEtch(payload, live); });
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

for (const id of ['#et-symbol', '#et-supply', '#et-div', '#et-keep', '#et-per', '#et-cap',
  '#et-price', '#et-recipient']) {
  $(id).addEventListener('input', refresh);
}
refresh();

// --- paying for it, and watching it happen --------------------------------------------------------

/**
 * Quote, then poll until the coin exists.
 *
 * The polling is what actually drives the work: the server splits and reveals when it sees the
 * payment. A rune's identity is (height, txIndex), so it genuinely cannot be known until a miner
 * places the transaction, which is why the last line only appears at the end rather than being
 * promised earlier.
 */
async function startEtch(payload, host) {
  const say = (text, cls) => { host.textContent = ''; host.append(el('p', cls || '', text)); };
  say('Asking for a payment address…');

  let job;
  try {
    job = await (await fetch('/api/runes/etch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })).json();
    if (job.error) throw new Error(job.error);
  } catch (e) { return say(e.message, 'et-err'); }

  host.textContent = '';
  host.append(el('h3', '', 'Pay once, and the coin is made'));
  const box = el('div');
  kv(box, 'Send exactly', xvg(job.total) + ' XVG', 'lead');
  kv(box, 'To this address', job.payTo, 'lead');
  kv(box, 'For', job.display || job.ticker);
  host.append(box);
  const state = el('p', 'et-note', 'Waiting for your payment. You can leave this page open.');
  host.append(state);

  for (let i = 0; i < 3600; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    let s;
    try {
      s = await (await fetch('/api/runes/etch/status?job=' + encodeURIComponent(job.jobId))).json();
    } catch { continue; }

    if (s.status === 'error') { state.className = 'et-err'; state.textContent = s.error; return; }
    if (s.runeRef) {
      host.textContent = '';
      host.append(el('h3', '', 'Your coin exists'));
      const done = el('div');
      kv(done, 'Coin', s.display || s.ticker, 'lead');
      kv(done, 'Reference', s.runeRef, 'lead');
      kv(done, 'Etch transaction', s.revealTxid);
      kv(done, 'Locked', xvg(job.breakdown.ticker) + ' XVG at ' + s.lockAddress);
      kv(done, 'Yours again on', new Date(s.locktime * 1000)
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
      host.append(done);
      // The etch txid only exists now, and it is the piece that makes recovery one lookup instead
      // of a full rescan, so the card is reprinted complete rather than left half filled.
      host.append(el('h3', '', 'Your recovery card, complete'));
      const card = [
        'VERGE RUNES RECOVERY CARD',
        'coin           ' + (s.display || s.ticker),
        'unlock key     ' + lockKey.wif,
        'release date   ' + s.locktime,
        'lock address   ' + s.lockAddress,
        'etch txid      ' + s.revealTxid,
        '',
        'Recover at https://theweb3frog.github.io/Verginals/ or /unlock on this site.',
      ].join('\n');
      const pre = el('div', 'et-hex');
      pre.style.whiteSpace = 'pre';
      pre.style.maxHeight = 'none';
      pre.textContent = card;
      host.append(pre);
      return;
    }
    if (s.revealTxid) state.textContent = 'Broadcast. Waiting for a block to place it…';
    else if (s.splitTxid) state.textContent = 'Payment received. Writing the etching…';
    else if (s.received) state.textContent = 'Seen ' + xvg(s.received) + ' of ' + xvg(job.total) + ' XVG…';
  }
  state.textContent = 'Still waiting. Your job id is ' + job.jobId + ', nothing is lost.';
}
