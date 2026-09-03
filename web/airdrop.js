// The community drop: are you on the list, and what does that come to.
//
// This page asks one question and shows the answer. It signs nothing, stores nothing and does not
// need a wallet: an address typed in by hand gets the same answer as a connected one, because the
// answer is a fact about the chain rather than about who is asking.
//
// Two honesty rules run through the whole file, and both were learned the hard way on other pages
// of this site.
//
//   AN UNFINISHED SCAN IS NOT AN ANSWER. A restart costs a full rescan, during which the ledger is
//   genuinely empty and every address on earth is genuinely ineligible. Saying "you do not qualify"
//   then is a lie that reads exactly like the truth, so while the index is behind the tip this page
//   refuses to render a verdict at all.
//
//   AN ESTIMATE IS LABELLED AS ONE. The allocation is the supply divided by every share there is,
//   and shares are still being earned. Quoting a number that quietly shrinks each time somebody
//   else qualifies is how an airdrop page turns into an argument.

import { mountChrome } from '/vgnav.js?v=44';

mountChrome({
  active: 'coins',
  where: [{ text: 'Coins', href: '/runes/market' }, { text: 'Airdrop' }],
  right: 'all of it, none of it ours',
});

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

// Where somebody goes to earn a share they have not got yet. The whole point of showing an action
// short of its ceiling is that it can still be topped up, so the way to do it sits on the row.
const HOW = {
  inscribe: '/#inscribe',
  alpha: '/#mint',
  etch: '/etch',
  coin: '/runes/mint',
};

const pct = (f) => Number((f * 100).toFixed(1));

let terms = null;       // the last /api/airdrop answer, without an address
let pending = null;     // an address typed before the terms arrived
let scanTimer = null;
// Connecting reaches this page twice: once from the button that was pressed, and once from the
// event wallet.js fires when the address changes. Both are correct and neither can be removed
// without breaking the other entry point, so the second one is simply not asked again.
let asked = null;

// --- talking to the server ------------------------------------------------------------------------

async function ask(address) {
  const url = address ? `/api/airdrop?address=${encodeURIComponent(address)}` : '/api/airdrop';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  return r.json();
}

function note(text, kind) {
  const n = $('ad-note');
  n.className = 'vg-note' + (kind ? ' ' + kind : '');
  n.textContent = text;
  n.hidden = !text;
}

// --- the page's fixed parts -------------------------------------------------------------------------

function paintTerms(d) {
  terms = d;
  if (d.coin) {
    // Rebuild the separators as their own elements so they can be dimmed. Written as nodes rather
    // than innerHTML because a ticker is somebody else's text and this page will not run it.
    $('ad-name').textContent = '';
    String(d.coin.display).split('•').forEach((part, i) => {
      if (i) $('ad-name').append(el('span', 'ad-dot', '•'));
      $('ad-name').append(document.createTextNode(part));
    });
    // Every figure and every mention of the name, filled from the chain rather than typed into the
    // markup. The page used to say "One billion" in four places; the coin the drop points at is
    // configuration, and when it changed those four sentences became false while the stat beside
    // them was right. A number that lives in two places is a number that eventually disagrees with
    // itself, so it lives in one: the etching.
    for (const e of document.querySelectorAll('[data-supply]')) e.textContent = fmt(d.coin.whole);
    for (const e of document.querySelectorAll('[data-coin]')) e.textContent = d.coin.display;
  }

  // What state the drop is in, said in the chip rather than buried in a paragraph.
  const chip = $('ad-state');
  if (d.settled) {
    chip.textContent = `list settled at block ${fmt(d.snapshotHeight)}`;
    chip.className = 'vg-chip ok';
  } else if (d.snapshotHeight) {
    chip.textContent = `snapshot at block ${fmt(d.snapshotHeight)}`;
    chip.className = 'vg-chip warn';
  } else {
    chip.textContent = 'still open, no snapshot taken';
    chip.className = 'vg-chip accent';
  }

  if (d.snapshotHeight) {
    $('ad-snap').textContent = d.settled
      ? `Taken at block ${fmt(d.snapshotHeight)}. Anything done after it does not count.`
      : `Block ${fmt(d.snapshotHeight)}. Anything done before it counts, and there is still time.`;
  }

  // While the index is catching up, say so and keep asking. The figures below are real but partial,
  // and a visitor who checks now would be told no on the strength of blocks nobody has read yet.
  if (d.scanning) {
    const done = Math.max(0, d.scannedThrough - d.indexFrom);
    const all = Math.max(1, d.tip - d.indexFrom);
    note(`Reading the chain: block ${fmt(d.scannedThrough)} of ${fmt(d.tip)}, `
      + `${Math.floor((done / all) * 100)}% of the way. Eligibility cannot be answered until this finishes.`, 'warn');
    if (!scanTimer) scanTimer = setInterval(refresh, 5000);
  } else if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    note('');
  }
}

async function refresh() {
  try {
    const d = await ask(null);
    paintTerms(d);
    if (!d.scanning && pending) { const a = pending; pending = null; check(a); }
  } catch (e) {
    note(`Could not reach the server: ${e.message}`, 'bad');
  }
}

// --- the answer ---------------------------------------------------------------------------------------

function paintAnswer(d) {
  const out = $('ad-out');
  out.textContent = '';
  const you = d.you;
  const eligible = you.eligible;
  const full = you.shares >= d.maxShares;
  const short = d.maxShares - you.shares;

  const card = el('div', 'ad-verdict' + (eligible ? ' is-in' : '') + (full ? ' is-full' : ''));
  const say = el('div', 'ad-verdict-say');
  say.append(el('h3', '', full ? 'Eligible, and maxed out.' : eligible ? 'Eligible.' : 'Not on the list yet.'));
  say.append(el('p', 'vg-say', full
    ? 'Every share there is. Nothing left to do but wait for it to land.'
    : eligible
      ? `You hold ${you.shares} of ${d.maxShares} shares. ${short} more ${short === 1 ? 'is' : 'are'} still on the table below.`
      : 'Any one of the four below puts you on the list, and there is still time to do it.'));
  say.append(el('p', 'ad-who', you.address));
  card.append(say);

  // A fraction of the maximum anybody can hold, never a coin figure. What an address ends up with
  // is the supply divided by every share that exists, and that shrinks each time somebody else
  // qualifies; showing it would mean showing a number that gets smaller while you read the page.
  const meter = el('div', 'ad-meter' + (eligible ? '' : ' none'));
  meter.append(el('b', '', pct(you.fill) + '%'));
  meter.append(el('span', '', 'of the maximum allocation'));
  card.append(meter);

  const bar = el('div', 'vg-bar ad-bar');
  const fill = el('span');
  fill.style.width = `${you.fill * 100}%`; // the exact fraction, not the figure rounded for reading
  if (full) fill.className = 'done';
  bar.append(fill);
  card.append(bar);
  out.append(card);

  // The four, met and unmet alike. Showing only what you earned hides what is still on the table,
  // and what is still on the table is the only reason somebody reads this list twice.
  const list = el('ul', 'ad-acts');
  for (const a of d.actions) {
    const at = you.done[a.key] || { count: 0, max: a.max, first: null };
    const maxed = at.count >= at.max;
    const row = el('li', 'ad-act' + (at.count ? ' done' : '') + (maxed ? ' full' : ''));
    // A tick once the ceiling is reached, the running count while there is more to get. A tick on
    // one Alpha out of three would say "finished" about something half done.
    row.append(el('span', 'ad-act-mark', maxed ? '✓' : at.count ? String(at.count) : ''));

    const s = el('div', 'ad-act-say');
    s.append(el('b', '', a.label));
    const tally = a.max > 1 ? `${at.count} of ${a.max}` : (at.count ? 'done' : 'not yet');
    s.append(el('span', '', at.first ? `${tally}, first at block ${fmt(at.first)}` : tally));
    row.append(s);

    // The way to top it up, on every row that is not finished. Four buttons rather than one,
    // because the row somebody is looking at is the row they want to act on.
    const href = HOW[a.key];
    if (href && !maxed) {
      const go = el('a', 'vg-btn ad-act-go' + (at.count ? '' : ' primary'), at.count ? `${a.one} again` : a.one);
      go.href = href;
      row.append(go);
    }
    list.append(row);
  }
  out.append(list);

  const totals = el('div', 'ad-totals');
  const stat = (n, label) => {
    const d2 = el('div');
    d2.append(el('b', '', n), el('span', '', label));
    totals.append(d2);
  };
  stat(fmt(d.totals.wallets), 'wallets qualify so far');
  stat(fmt(d.totals.shares), 'shares between them');
  stat(fmt(d.coin ? d.coin.whole : 0), 'coins to share out');
  stat(String(d.maxShares), 'shares is the most anyone can hold');
  out.append(totals);

  out.hidden = false;
}

async function check(address, force = false) {
  const a = String(address || '').trim();
  if (!a) { note('Type a Verge address, or connect a wallet.', 'warn'); return; }
  if (!force && a === asked) return;
  asked = a;
  // The scan is the one condition under which no answer is better than an answer.
  if (terms && terms.scanning) {
    pending = a;
    note('Still reading the chain. Your answer will appear as soon as it finishes.', 'warn');
    return;
  }
  $('ad-go').disabled = true;
  try {
    const d = await ask(a);
    if (d.scanning) { pending = a; paintTerms(d); return; }
    paintTerms(d);
    paintAnswer(d);
    note('');
  } catch (e) {
    asked = null; // a failed check must be retryable with the same address
    note(`Could not check that address: ${e.message}`, 'bad');
  } finally {
    $('ad-go').disabled = false;
  }
}

// --- wiring ----------------------------------------------------------------------------------------------

$('ad-form').addEventListener('submit', (e) => {
  e.preventDefault();
  check($('airdrop-address').value, true); // pressing Check again means check again
});

// wallet.js owns the provider and the bar's Connect button. This one is the same action, offered
// where somebody is actually standing, and it goes through the same bridge rather than reaching for
// window.verge itself.
$('ad-connect').addEventListener('click', async () => {
  const w = window.VerginalsArena;
  if (!w || !w.installed()) {
    note('No Verginals Wallet found in this browser. Install it, or paste an address below.', 'warn');
    return;
  }
  try {
    // Already-connected returns straight away without firing the change event, so the answer is
    // asked for here; a fresh connection fires it, and the guard above drops the repeat.
    const address = await w.connect();
    if (address) { $('airdrop-address').value = address; check(address); }
  } catch (e) {
    note(`The wallet did not connect: ${e.message}`, 'bad');
  }
});

// Connecting from the bar is the same event as connecting from here, so it answers the same way.
document.addEventListener('vg:wallet', (e) => {
  const address = e.detail && e.detail.address;
  if (!address) return;
  $('airdrop-address').value = address;
  check(address);
});

// With no extension there is nothing to connect, and offering it anyway sends people to a dead
// button. Checked after a moment, because the provider injects asynchronously.
setTimeout(() => {
  const w = window.VerginalsArena;
  if (w && w.installed()) return;
  $('ad-connect-row').classList.add('hidden');
  $('ad-or').classList.add('hidden');
}, 1200);

refresh();

// An address in the link, so a result can be shared and a wallet can deep-link into it.
const fromUrl = new URLSearchParams(location.search).get('address');
if (fromUrl) { $('airdrop-address').value = fromUrl; check(fromUrl); }
