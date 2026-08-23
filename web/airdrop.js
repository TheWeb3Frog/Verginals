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
//   AN ESTIMATE IS LABELLED AS ONE. The allocation is a billion divided by every share that exists,
//   and shares are still being earned. Quoting a number that quietly shrinks each time somebody
//   else qualifies is how an airdrop page turns into an argument.

import { mountChrome } from '/vgnav.js';

mountChrome({
  active: 'coins',
  where: [{ text: 'Coins', href: '/runes/market' }, { text: 'Airdrop' }],
  right: 'one billion, none of it ours',
});

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

// Where somebody goes to earn the share they have not got. The whole point of showing an unmet
// action is that it can still be met.
const HOW = {
  inscribe: { href: '/#inscribe', text: 'Inscribe something' },
  alpha: { href: '/#mint', text: 'Mint an Alpha' },
  etch: { href: '/etch', text: 'Etch a coin' },
  coin: { href: '/runes/mint', text: 'Mint a coin' },
};

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
    $('ad-supply').textContent = fmt(d.coin.whole);
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

  const card = el('div', 'ad-verdict' + (eligible ? ' is-in' : ''));
  const say = el('div', 'ad-verdict-say');
  say.append(el('h3', '', eligible
    ? (you.shares === 4 ? 'Everything. Maximum allocation.' : `On the list, with ${you.shares} of 4 shares.`)
    : 'Not on the list yet.'));
  say.append(el('p', 'vg-say', eligible
    ? (d.settled
      ? 'This is your final allocation. Nothing to claim: it will be sent to this address.'
      : "An estimate at today's numbers. It moves as more wallets qualify, and settles when the snapshot is taken.")
    : 'This address has not done any of the four yet. Any one of them is enough, and there is still time.'));
  say.append(el('p', 'ad-who', you.address));
  card.append(say);

  const amount = el('div', 'ad-amount' + (eligible ? '' : ' none'));
  amount.append(el('b', '', eligible ? fmt(you.whole) : '0'));
  amount.append(el('span', '', eligible && !d.settled ? 'estimated ALPHA GO BRRRR' : 'ALPHA GO BRRRR'));
  card.append(amount);
  out.append(card);

  // The four, met and unmet alike. Showing only what you earned hides what is still on the table.
  const list = el('ul', 'ad-acts');
  for (const a of d.actions) {
    const at = you.done[a.key];
    const row = el('li', 'ad-act' + (at ? ' done' : ''));
    row.append(el('span', 'ad-act-mark', at ? '✓' : ''));
    const s = el('div', 'ad-act-say');
    s.append(el('b', '', a.label));
    s.append(el('span', '', at ? `first at block ${fmt(at)}` : 'not yet'));
    row.append(s);
    const how = HOW[a.key];
    if (how) {
      const go = el('a', 'vg-btn ad-act-go', how.text);
      go.href = how.href;
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
