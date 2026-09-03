// Etch a Verge Rune.
//
// The form validates locally so the arithmetic is instant, but the ETCHING ITSELF is composed by the
// server, which runs the same src/runes/builder.js the end-to-end suites drive against a real chain.
// Nothing here reimplements the protocol: a second implementation living in a page is a second
// implementation to keep in step, and the first time it drifted somebody would pay for a name they
// did not get.
//
// A coin can only be etched from a connected wallet. There is no field for an address and no button
// that makes a key in this page, and both absences are the point: a pasted address is permanent the
// moment the etch confirms, and a key made in a web page is an orphan with no relation to anything
// its owner already keeps. Those are the two ways people lose a locked ticker price. The wallet
// supplies the address it already holds and derives the lock key from the same recovery phrase, so
// the private half never reaches this page and there is nothing new for anybody to save.

import { mountChrome } from '/vgnav.js?v=37';

mountChrome({ active: 'create', where: [{ text: 'Create' }, { text: 'Etch a coin' }],
  right: 'permanent the moment it confirms' });

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

/**
 * The same trim, but keeping a trailing separator, because somebody is still typing and has just
 * asked to see one. Nothing downstream reads this: the card, the price and the etching all go
 * through clampTicker, which drops it.
 */
function clampTyping(typed) {
  const trailing = typed.endsWith(SEP);
  const body = clampTicker(trailing ? typed.slice(0, -1) : typed);
  return trailing && bare(body).length > 0 && bare(body).length < MAX_NAME ? body + SEP : body;
}

const tickerInput = $('#et-ticker');

// Space puts the separator in AT ONCE, rather than arming it and waiting for the next letter. The
// old behaviour was correct and felt broken: you pressed space and the field did not move, so you
// pressed it again. A separator is display only and costs nothing, so showing it the instant it is
// asked for is free.
//
// It cannot open a name and it cannot double. It CAN sit at the end while somebody is still typing,
// because that is the moment they need to see it; every reader below strips a trailing one, so it
// never reaches the card, the price, or the chain.
tickerInput.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.code !== 'Space') return;
  e.preventDefault();
  const v = tickerInput.value;
  if (!v.length || v.endsWith(SEP)) return;      // never leading, never doubled
  if (bare(v).length >= MAX_NAME) return;        // a full name has no room for another gap
  tickerInput.value = (v + SEP).slice(0, MAX_TYPED);
  refresh();
});

tickerInput.addEventListener('input', () => {
  let v = tickerInput.value.toUpperCase().replace(/[^A-Z\u2022]/g, '');
  v = v.replace(new RegExp(SEP + '+', 'g'), SEP).replace(new RegExp('^' + SEP + '+'), '');
  tickerInput.value = clampTyping(v).slice(0, MAX_TYPED);
  refresh();
});

// --- the unlock key ------------------------------------------------------------------------------

// { pubHex, derived, index, path, wif? }. `wif` is present ONLY for the fallback path, where the key
// was made in this page and the etcher has to keep it themselves.
let lockKey = null;
// Why the last attempt to get a lock key failed, so the page can say something true instead of
// sending somebody to reconnect a wallet that is working perfectly well.
let lockError = null;
let selfFunded = null;
let fundError = null;

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
// --- the wallet ---------------------------------------------------------------------------------
//
// Connected, step four is one sentence: the coins come back to the address the wallet already has,
// and the key that reopens the locked price is derived from the same recovery phrase. Asking
// somebody to paste an address they are already holding is friction and a chance to fatfinger a
// destination that cannot be changed once it confirms.

let walletAddress = null;

function paintWallet() {
  const on = $('#et-wallet-on'), off = $('#et-wallet-off');
  if (walletAddress) {
    $('#et-wallet-addr').textContent = walletAddress;
    on.hidden = false; off.hidden = true;
  } else {
    on.hidden = true; off.hidden = false;
  }
  refresh();
}

async function connectWallet(ask) {
  const p = window.verge;
  if (!p || !p.isVerginals) return null;

  // TWO STEPS, TWO TRIES, AND A PAINT BETWEEN THEM. They used to share one try block, so anything
  // that went wrong while deriving the lock key skipped the repaint entirely: the wallet was
  // connected, walletAddress held the address, and the screen still said "connect your wallet"
  // because nothing had told it otherwise. Connecting is a fact as soon as it happens, and a
  // secondary step failing must never be able to hide it.
  let addr = null;
  try {
    const r = ask ? await p.connect() : await p.getAddress().catch(() => null);
    addr = r && (r.address || (Array.isArray(r) ? r[0] : null));
  } catch (_) { return null; }
  if (!addr) return null;

  walletAddress = addr;
  lockError = null;
  paintWallet();

  // Deriving the key needs a connection, so it happens here rather than behind a second button.
  try {
    const k = await deriveFromWallet();
    if (k) lockKey = k;
  } catch (e) {
    lockError = e && e.message ? 'the wallet refused to derive a lock key: ' + e.message : null;
  }
  paintWallet();
  return addr;
}

async function deriveFromWallet() {
  const p = window.verge;
  if (!p || !p.isVerginals) return null;
  try {
    // Which index to use is decided by what this wallet has already published on chain, so a second
    // coin never reuses the key of the first.
    let index = 0;
    try {
      const res = await fetch('/api/runes/locks').then((r) => r.json());
      const mine = await p.runesMyLocks({ locks: res.locks || [] });
      index = mine && Number.isInteger(mine.nextIndex) ? mine.nextIndex : 0;
    } catch (_) { /* an unreachable index service is not a reason to refuse to etch */ }
    // Say which build is answering. A stale service worker looks exactly like a broken one, and the
    // difference between "reload the extension" and "this is a bug" is worth one call.
    let build = '';
    try { const v = await p.walletVersion(); if (v && v.version) build = ' (wallet ' + v.version + ')'; }
    catch (_) { build = ' (wallet too old to say which version it is)'; }

    if (typeof p.runesLockPubkey !== 'function') {
      // An older wallet that predates this method. Say which one it is rather than blaming the
      // connection, because reconnecting an old wallet produces the same nothing for ever.
      lockError = 'this wallet is too old to derive a lock key: update the Verginals wallet' + build;
      return null;
    }
    const k = await p.runesLockPubkey({ index });
    return k && k.pubkey ? { pubHex: k.pubkey, derived: true, index: k.index, path: k.path } : null;
  } catch (e) {
    lockError = (e && e.message) ? 'the wallet refused to derive a lock key: ' + e.message + (build || '') : null;
    return null;
  }
}



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
  const typed = clampTicker(tickerInput.value);
  const symbol = Array.from($('#et-symbol').value.trim()).slice(0, 1).join('');
  const name = bare(typed);
  // WHOLE COINS in the field, atomic units on the wire.
  //
  // The field used to be atomic units and the readout showed whole coins, so somebody typing
  // 21000000 with 2 decimals was told they had made 210,000 coins. Both numbers were correct and the
  // pair was nonsense: nobody means "twenty one million hundredths" when they type twenty one
  // million. The protocol still counts in atomic units, which is where the multiplication happens.
  const whole = int('#et-supply');
  const divisibility = int('#et-div');
  const scale = Number.isInteger(divisibility) && divisibility >= 0 && divisibility <= 6 ? 10 ** divisibility : 1;
  const supply = Number.isInteger(whole) && whole > 0 ? whole * scale : whole;
  // Kept as a SHARE of the supply, never as a free number. It used to be a plain input, and a
  // person could type more than the supply, get a valid looking form, pay, and have the etching
  // silently ignored by every indexer. A share cannot express that mistake at all.
  const keepPct = Math.max(0, Math.min(100, Number($('#et-keep').value) || 0));
  const supplyOk = Number.isInteger(supply) && supply > 0;
  const premine = supplyOk ? Math.round(supply * keepPct / 100) : 0;
  const open = $('#et-openmint').checked;
  // Scaled by the divisibility, exactly like the supply above it. It was NOT, and the two fields
  // sat side by side: somebody typing 9420420 for the supply got 9,420,420 coins, and somebody
  // typing 1000 here got 1000 ATOMIC UNITS, which at two decimals is ten coins. A hundredfold
  // difference between two boxes that look identical, in terms that can never be changed once the
  // etching confirms. This is the same mistake the supply field already had, one field over, and
  // fixing one without looking at its neighbour is how it survived.
  const perMintTyped = open ? int('#et-per') : null;
  const perMint = open && Number.isInteger(perMintTyped) && perMintTyped > 0
    ? perMintTyped * scale : perMintTyped;
  // No cap. The field is gone, and with it a whole class of permanent mistake: a cap counts claims
  // for the WHOLE coin, it was read as a limit per person, and the one etcher who read it that way
  // closed a 21,000-supply coin after 25 coins existed. Nothing on this form can produce that
  // outcome now, because claiming simply runs until the supply is gone.
  //
  // The protocol still has the field. This site does not set it.
  const cap = null;
  const priceRaw = open ? $('#et-price').value.replace(/[\s,]/g, '') : '';
  const mintPrice = open && priceRaw !== '' ? Math.round(Number(priceRaw) * COIN) : 0;

  // The wallet's address wins: it is the one the person is already holding, and it cannot be
  // mistyped. The manual field is the fallback for somebody etching without the extension.
  // Only ever the wallet's. There is no field to type one into: a pasted address is permanent the
  // moment the etch confirms, and a typo in it sends a coin somewhere nobody can reach.
  const recipient = walletAddress;

  const problems = [];
  if (!name) problems.push('the ticker is empty');
  else if (!/^[A-Z]{1,26}$/.test(name)) problems.push('a ticker is 1 to 26 letters, A to Z');
  if (!Number.isInteger(whole) || whole <= 0) problems.push('the supply must be a whole number above zero');
  else if (supply > 16555000000000000) problems.push('that many coins at that many decimals is past what the protocol can count');
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 6) problems.push('decimals must be 0 to 6');

  if (open) {
    if (!Number.isInteger(perMint) || perMint <= 0) problems.push('units per claim must be a whole number above zero');
    if (!Number.isFinite(mintPrice) || mintPrice < 0) problems.push('the fee per claim is not a number');
    else if (mintPrice > 49 * COIN) problems.push('the fee per claim cannot exceed 49 XVG');
    if (Number.isInteger(supply) && Number.isInteger(premine) && premine >= supply) {
      problems.push('an open mint needs supply left over: keep less than all of it');
    }
  }

  // Without a cap, an open mint always reaches the whole open supply, so nothing can be stranded by
  // one. The figures stay because the card still reports what a mint releases, and because a CLOSED
  // mint can still leave supply nobody can reach: that case is a verdict on the card, not a guard.
  const claimable = supplyOk && Number.isInteger(premine) ? supply - premine : 0;
  const mintable = claimable;
  const stranded = 0;
  // Connecting a wallet fixes the address and the key at once, so listing them as two failures
  // reads as twice the work. They are one sentence until somebody opens the manual panel.
  if (!recipient) problems.push('connect your wallet');
  // No separate line for the key. It is derived when the wallet connects, the person never sees it,
  // and after the release is inscribed they never need it again. A key nobody handles is not a step.
  if (!lockKey && recipient) problems.push(lockError || 'the wallet did not return a lock key: reconnect it');

  return { typed, name, symbol, keepPct, recipient, whole, supply, premine, divisibility, open,
    perMint, cap, mintPrice, claimable, mintable, stranded, problems };
}

/**
 * What the mint terms actually do to the coin, said in coins rather than in claims.
 *
 * The old line here read "Others can claim 5 times, 5 each", which is true and tells nobody that
 * 20,975 of their 21,000 coins had just been made impossible. A cap is the only field on this form
 * whose damage is invisible in its own units, so it is reported in the units that matter.
 */
function paintMintTerms(f) {
  const out = $('#et-mint-out');
  out.textContent = '';
  if (!f.open || !Number.isInteger(f.perMint) || f.perMint <= 0
    || !Number.isInteger(f.divisibility) || f.claimable <= 0) return;

  const scale = 10 ** f.divisibility;
  const claims = Math.floor(f.mintable / f.perMint);
  kv(out, 'Claims available', fmt(claims));
  kv(out, 'That releases', fmt(f.mintable / scale) + ' coins');
}


// --- live readouts -------------------------------------------------------------------------------

/**
 * The coin, as it will be, written as sentences.
 *
 * A fact list says "cap: 5" and reads as a setting. A sentence says "25 coins would ever exist" and
 * reads as a consequence, and only one of those two has ever stopped somebody making a permanent
 * mistake. Both of this form's real accidents were legible in its own readout at the time, and
 * neither was legible AS A CONSEQUENCE, which is the whole argument for this card.
 */
function paintCard(f) {
  const scale = Number.isInteger(f.divisibility) ? 10 ** f.divisibility : 1;
  $('#card-sym').textContent = f.symbol || '\u00a4';
  $('#card-sym').classList.toggle('et-card-sym-default', !f.symbol);
  const shown = f.typed.trim() ? f.typed.trim() : 'YOUR COIN';
  $('#card-name').textContent = shown;
  $('#card-name').classList.toggle('et-card-empty', !f.typed.trim());
  // A ticker runs to 26 letters and the card is a fixed column, so the name is stepped down rather
  // than allowed to break mid-word. SUNEROKTHEDEVGOAT split as SUNEROKTHED and EVGOAT, which reads
  // as a different name.
  $('#card-name').classList.toggle('is-long', shown.length > 11);
  $('#card-name').classList.toggle('is-longer', shown.length > 17);

  const say = $('#card-say');
  say.textContent = '';
  // Not `p`: in this file `p` is the wallet provider, and a paragraph borrowing the name reads as
  // a call into the wallet to anybody skimming, including the check that scans for exactly that.
  const line = (parts) => {
    const row = el('p', 'et-say-line');
    for (const [text, cls] of parts) row.append(cls ? el('b', cls, text) : document.createTextNode(text));
    say.append(row);
  };
  const supplyOk = Number.isInteger(f.supply) && f.supply > 0;
  if (!supplyOk) {
    line([['Set a supply to see what this makes.', 'quiet']]);
  } else {
    line([[fmt(f.whole), 'hot'], [' coins exist, ever.']]);
    line([['You keep '], [f.premine === 0 ? 'none of them' : fmt(f.premine / scale), 'hot'], ['.']]);
    if (!f.open) {
      line([['Nobody else can claim any: there is no open mint.', 'quiet']]);
    } else if (Number.isInteger(f.perMint) && f.perMint > 0) {
      // The line that would have caught the etching that shipped at a hundredth of its intended
      // size: what ONE CLAIMER RECEIVES, in coins, at the divisibility set above.
      line([['Each claim hands over '], [fmt(f.perMint / scale), 'hot'],
        [', for ' + (f.mintPrice ? xvg(f.mintPrice) + ' XVG' : 'nothing') + '.']]);
    }
  }

  const v = $('#card-verdicts');
  v.textContent = '';
  const verdict = (kind, text) => {
    const row = el('p', 'et-verdict ' + kind);
    row.append(el('span', 'mark', kind === 'ok' ? '\u2713' : (kind === 'bad' ? '\u25a0' : '!')),
      el('span', '', text));
    v.append(row);
  };
  if (supplyOk && f.open && Number.isInteger(f.perMint) && f.perMint > 0) {
    if (f.stranded > 0) {
      verdict('warn', fmt(f.stranded / scale) + ' coins would exist and could never be claimed. '
        + 'They would be finished the moment its mint opened.');
    } else {
      verdict('ok', 'Every coin is accounted for.');
    }
  } else if (supplyOk && !f.open && f.keepPct < 100) {
    verdict('warn', fmt((f.supply - f.premine) / scale) + ' coins would exist and could never reach '
      + 'anybody: no mint is open and you did not keep them.');
  } else if (supplyOk) {
    verdict('ok', 'Every coin is accounted for.');
  }

  $('#card-price').textContent = f.name ? xvg(priceOf(f.name.length)) + ' XVG' : 'pick a name';
  $('#card-netfee').textContent = f.name ? '~2.1 XVG' : '-';
  $('#card-back').textContent = f.name
    ? new Date(Date.now() + 1460 * 86400e3).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'a date set now';

  // Which step somebody is on, judged by what they have filled rather than by scroll position.
  let step = 1;
  if (f.name) step = 2;
  if (supplyOk && f.name) step = 3;
  if (step === 3 && (!f.open || (Number.isInteger(f.perMint) && f.perMint > 0))) step = 4;
  if (step === 4 && f.recipient) step = 5;
  $('#et-step').textContent = 'step ' + step + ' of 5';
}

function refresh() {
  const f = readForm();

  const tOut = $('#et-ticker-out');
  tOut.textContent = '';
  if (f.name) {
    const price = priceOf(f.name.length);
    kv(tOut, 'The coin is', f.name, 'lead');
    if (f.typed !== f.name) kv(tOut, 'Shown as', f.typed);
    // Never the word "price" here. Nobody is paid this, it is not a fee, and it is not spent: it is
    // locked to the name and it comes back in full. Calling it a price made people read the biggest
    // number on the page as money leaving for ever, which is the opposite of what happens.
    kv(tOut, 'You lock', xvg(price) + ' XVG', 'warn');
    const releases = new Date(Date.now() + 1460 * 86400e3);
    kv(tOut, 'You get your locked XVG back on', releases.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
  }

  const sOut = $('#et-supply-out');
  sOut.textContent = '';
  if (Number.isInteger(f.supply) && f.supply > 0 && Number.isInteger(f.divisibility)
    && f.divisibility >= 0 && f.divisibility <= 6 && Number.isInteger(f.premine) && f.premine >= 0) {
    kv(sOut, 'Whole coins', fmt(f.whole));
    kv(sOut, 'You keep', fmt(f.premine / (10 ** f.divisibility)) + ' of them');
    kv(sOut, 'Everyone else can have', fmt((f.supply - f.premine) / (10 ** f.divisibility)));
  }

  paintMintTerms(f);

  paintCard(f);

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
    // The two numbers are different in kind and the review has to say which is which. One leaves for
    // good, the other is only parked. Showing a single "total" without that distinction is how
    // somebody comes away thinking a four letter name cost them 10,000 XVG.
    kv(review, 'Locked to the name, comes back in four years', xvg(price) + ' XVG');
    kv(review, 'Actually spent, on miner fees and the inscription', 'about ' + xvg(4 * 100000) + ' XVG');
    kv(review, 'You need in the wallet today', xvg(price + 4 * 100000) + ' XVG', 'lead');
    review.append(el('p', 'et-note', 'Only the fees are spent. The locked amount is not paid to '
      + 'anybody, not burnt, and not ours: it returns in full to the key you generated, four years '
      + 'from the block that confirms this.'));
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
    recipient: f.recipient,
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

  // THE DECISIVE BUTTON GOES FIRST, and this is the whole fix.
  //
  // It used to sit at the bottom, under a summary, a hex dump and three paragraphs, so the last
  // thing on screen after pressing "Compose" was a wall of text with the real action below the
  // fold. People pressed compose, watched their wallet do something for the lock key, and believed
  // they had etched. They had not: nothing is signed, nothing is paid, and the coin does not exist
  // until the button below is pressed.
  const confirm = el('div', 'et-confirm');
  out.append(confirm);
  out.append(el('h3', '', 'What gets written'));
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
    const head = el('div', 'et-confirm-head');
    head.append(el('p', 'et-confirm-say', 'Nothing has been signed or paid yet'));
    head.append(el('p', 'et-confirm-why', 'Reviewing costs nothing and changes nothing. '
      + (r.display || r.ticker) + ' does not exist until you press the button below, and after that '
      + 'every number on this page is permanent.'));
    const price = el('p', 'et-confirm-price');
    price.append(el('b', '', xvg(r.cost.total) + ' XVG'), document.createTextNode(' in total'));
    head.append(price);

    const go = el('button', 'et-btn et-go', 'Etch ' + (r.display || r.ticker) + ' for real');
    head.append(go);
    confirm.append(head);

    const live = el('div', 'et-result');
    confirm.append(live);
    go.addEventListener('click', () => { go.disabled = true; go.textContent = 'Etching...'; startEtch(payload, live); });

    // Put the decision where the eye already is. Composing scrolls the page, and a button somebody
    // has to hunt for is a button somebody does not press.
    requestAnimationFrame(() => confirm.scrollIntoView({ behavior: 'smooth', block: 'center' }));
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

for (const id of ['#et-symbol', '#et-supply', '#et-div', '#et-keep', '#et-per', '#et-price']) {
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

    // Sign it here rather than sending coins to an address somebody else holds the key to. The
    // deposit address stays as the fallback and is still shown, because an older wallet has no
    // fundEtch and must not be left with no way to etch at all.
    if (window.verge && typeof window.verge.fundEtch === 'function'
      && Array.isArray(job.splitOutputs) && job.splitOutputs.length) {
      try {
        const paid = await window.verge.fundEtch({ jobId: job.jobId, outputs: job.splitOutputs });
        selfFunded = paid && paid.splitTxid;
      } catch (e) {
        // Not fatal: the address below still works, and saying why beats silently falling back.
        fundError = (e && e.message) || 'the wallet did not sign the payment';
      }
    }
    if (job.error) throw new Error(job.error);
  } catch (e) { return say(e.message, 'et-err'); }

  host.textContent = '';
  const box = el('div');
  let state;
  if (selfFunded) {
    // Paid from the etcher's own wallet. Nothing was sent to anybody, so the panel says that
    // instead of an address, and the id is shown because it is the only receipt that exists yet.
    host.append(el('h3', '', 'Paid from your wallet'));
    kv(box, 'You signed', xvg(job.total) + ' XVG', 'lead');
    kv(box, 'For', job.display || job.ticker);
    kv(box, 'Transaction', selfFunded);
    host.append(box);
    state = el('p', 'et-note', 'Nothing was sent to anybody else. Building your coin now.');
  } else {
    host.append(el('h3', '', 'Pay once, and the coin is made'));
    kv(box, 'Send exactly', xvg(job.total) + ' XVG', 'lead');
    kv(box, 'To this address', job.payTo, 'lead');
    kv(box, 'For', job.display || job.ticker);
    host.append(box);
    state = el('p', 'et-note', fundError
      ? 'Your wallet could not sign this, so pay the address above instead: ' + fundError
      : 'Waiting for your payment. You can leave this page open.');
    if (fundError) state.className = 'et-note';
  }
  host.append(state);

  for (let i = 0; i < 3600; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    let s;
    try {
      s = await (await fetch('/api/runes/etch/status?job=' + encodeURIComponent(job.jobId))).json();
    } catch { continue; }

    if (s.status === 'error') { state.className = 'et-err'; state.textContent = s.error; return; }

    // Say where it has got to. This used to read "Building your coin now" for as long as it took,
    // which on a slow block is several minutes of a screen that looks identical to a stuck one, and
    // a stuck screen is what makes somebody reload and press things twice.
    if (!s.runeRef) {
      const where = s.revealTxid
        ? 'Etching broadcast. Waiting for a miner to place it in a block, which is what gives your '
          + 'coin its number.'
        : s.splitTxid
          ? 'Payment seen. Writing the coin definition onto the chain.'
          : selfFunded
            ? 'Payment signed. Waiting for the network to relay it.'
            : 'Waiting for your payment. You can leave this page open.';
      if (state.textContent !== where) state.textContent = where;
    }

    if (s.runeRef) {
      host.textContent = '';
      host.append(el('h3', '', 'Your coin exists'));
      const done = el('div');
      kv(done, 'Coin', s.display || s.ticker, 'lead');
      kv(done, 'Rune ID', s.runeRef, 'lead');
      kv(done, 'Etch transaction', s.revealTxid);
      kv(done, 'Locked', xvg(job.breakdown.ticker) + ' XVG at ' + s.lockAddress);
      kv(done, 'Yours again on', new Date(s.locktime * 1000)
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
      host.append(done);

      // The release: sign the transaction that reopens this deposit, and write it down for ever.
      //
      // After this the key becomes OPTIONAL, which is the whole point of the scheme. The bytes go on
      // chain, and in four years anybody can broadcast them and the money returns to the address
      // below, even if this wallet and its words are long gone. Without it the deposit still comes
      // back, but only to somebody holding the recovery phrase on the day.
      //
      // Done here rather than offered as a button somebody will skip: the funding for it was already
      // paid as part of the etching, and a person who has just spent five thousand XVG should not
      // have to understand a timelock to keep the way back.
      const rel = el('p', 'et-note', 'Writing down the way back to your deposit...');
      host.append(rel);
      (async () => {
        try {
          const p = window.verge;
          if (!p || typeof p.runesSignRelease !== 'function') {
            rel.textContent = 'Your wallet is too old to write down the way back. Update it and etch'
              + ' again, or keep the card below safe: it is enough on its own.';
            return;
          }
          // Which key opens this lock is something only this wallet can work out, by deriving its
          // own keys and comparing against the public list. The server is never told.
          const pub = await fetch('/api/runes/locks').then((r) => r.json()).catch(() => ({ locks: [] }));
          const mine = await p.runesMyLocks({ locks: pub.locks || [] });
          const found = (mine && mine.locks || []).find((l) => l.ref === s.runeRef);
          if (!found) { rel.textContent = 'Could not match this lock to your wallet, so nothing was written.'; return; }

          const signed = await p.runesSignRelease({
            index: found.index,
            locktime: s.locktime,
            txid: s.lock.txid, vout: s.lock.vout, value: s.lock.value,
            // walletAddress, not f.recipient: f belongs to readForm's caller and is not in scope
            // here. The manual address path is gone, so the connected wallet IS the recipient.
            to: walletAddress,
          });
          const posted = await (await fetch('/api/runes/etch/release', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ job: job.jobId, hex: signed.hex || signed }),
          })).json();
          rel.textContent = posted.releaseTxid || posted.already
            ? 'The way back is on chain. In four years anybody can broadcast it and your ' + xvg(job.breakdown.ticker)
              + ' XVG returns to you, with or without this wallet.'
            : 'The way back could not be written: ' + (posted.error || 'unknown');
        } catch (e) {
          rel.textContent = 'The way back could not be written: ' + ((e && e.message) || 'unknown')
            + '. Your recovery card below still works.';
        }
      })();

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

// The wallet is detected silently on load: a page that pops a connection prompt before anybody has
// typed anything is a page people close. The button is there for when they want it.
$('#et-connect').addEventListener('click', async () => {
  const btn = $('#et-connect');
  btn.disabled = true; btn.textContent = 'Connecting…';
  const addr = await connectWallet(true);
  btn.disabled = false; btn.textContent = 'Connect wallet';
  if (!addr) $('#et-noext').hidden = false;
});

(function bootWallet() {
  const tryIt = () => { if (window.verge && window.verge.isVerginals) connectWallet(false); };
  tryIt();
  window.addEventListener('verge#initialized', tryIt, { once: true });
  setTimeout(tryIt, 600);
  paintWallet();
})();
