// The coin market: every rune that exists, what it costs, and how far its mint has got.
//
// This is the directory rather than the order book, and that is the point. On the day a protocol
// opens there are coins and no orders, so a market built only on orders shows an empty screen while
// several coins are minting behind it. Coins first, asks alongside.
//
// Every figure here arrives already scaled to whole coins. The server holds the divisibility and
// does the multiplication, because the two places this page would have had to remember it are the
// two places it has already been got wrong: a balance shown a hundred times too big, and a price
// shown a hundred times too small, on the same afternoon.

import { mountChrome } from '/vgnav.js';

mountChrome({ active: 'coins', where: [{ text: 'Coins', href: '/runes' }, { text: 'Market' }],
  right: 'a directory first, an order book second' });

const $ = (id) => document.getElementById(id);
const COIN = 1_000_000;

const fmtXvg = (u) => (u / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtN = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

/**
 * Big numbers, short. A supply of 9,420,420 is read at a glance as 9.42M and precisely as nothing,
 * which is the right trade in a column somebody is scanning. The exact figure is one click away on
 * the coin's own page, where there is room for it.
 */
function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(abs >= 1e13 ? 0 : 1).replace(/\.0$/, '') + 'T';
  if (abs >= 1e9) return (v / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e4) return Math.round(v).toLocaleString();
  return fmtN(v);
}

let coins = [];
let sort = 'new';
let query = '';
let scanning = false;
let scanTimer = null;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** A figure with its own label, because on a phone there is no column heading above it. */
function val(host, label, value, quiet) {
  const box = el('div', 'rm-val' + (quiet ? ' quiet' : ''));
  box.append(el('b', '', value), el('span', '', label));
  host.append(box);
  return box;
}

async function load() {
  let res;
  try {
    res = await fetch('/api/runes/coins').then((r) => (r.ok ? r.json() : null));
  } catch { res = null; }

  if (!res || !Array.isArray(res.coins)) {
    $('status').textContent = 'Could not reach the index. Nothing below would be trustworthy, so '
      + 'nothing is shown.';
    $('status').classList.add('bad');
    return;
  }

  coins = res.coins;
  scanning = res.scanning === true;
  $('status').hidden = true;
  $('rm-table').hidden = false;
  paintStats(res);
  render();

  // While the index is catching up the figures are real but incomplete, so the page says so rather
  // than letting somebody read a partial count as the whole truth. It also comes back on its own:
  // being told to refresh is a worse answer than refreshing.
  if (scanning) {
    $('status').hidden = false;
    $('status').classList.remove('bad');
    const done = res.tip ? Math.min(100, (res.scannedThrough / res.tip) * 100) : null;
    $('status').textContent = 'Still reading the chain'
      + (done !== null ? `, ${done.toFixed(2)}% of the way` : '')
      + '. Coins already found are shown; more may appear.';
    clearTimeout(scanTimer);
    scanTimer = setTimeout(load, 15000);
  }
}

function paintStats(res) {
  const box = $('rm-stats');
  box.textContent = '';
  const listed = coins.filter((c) => c.market.asks > 0).length;
  const minting = coins.filter((c) => c.mint && c.mint.open).length;
  const stat = (label, value, sub, cls) => {
    const d = el('div', 'vg-stat');
    d.append(el('span', 'vg-label', label), el('b', 'vg-num vg-n-lg' + (cls ? ' ' + cls : ''), value));
    if (sub) d.append(el('span', 'vg-stat-sub', sub));
    box.append(d);
  };
  stat('Coins', fmtN(coins.length), 'etched so far');
  stat('Minting now', fmtN(minting), minting ? 'open to anyone' : 'none open', minting ? 'vg-accent' : '');
  // Listed is the honest headline for a market, and today it is zero. Saying so beats dressing the
  // page with a figure that measures nothing.
  stat('Listed', fmtN(listed), listed ? 'on the book' : 'nobody selling yet', listed ? '' : 'vg-muted');
}

function sorted() {
  const rows = coins.filter((c) => !query
    || c.ticker.includes(query) || c.display.includes(query) || c.runeRef.startsWith(query));
  const byNew = (a, b) => b.etchedAtHeight - a.etchedAtHeight;
  if (sort === 'price') {
    // Coins nobody is selling go last rather than first. A missing price is not a low one.
    return rows.sort((a, b) => {
      const x = a.market.bestAsk, y = b.market.bestAsk;
      if (x === null && y === null) return byNew(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y || byNew(a, b);
    });
  }
  if (sort === 'minted') {
    return rows.sort((a, b) => (b.mintedShare || 0) - (a.mintedShare || 0) || byNew(a, b));
  }
  if (sort === 'holders') return rows.sort((a, b) => b.carriers - a.carriers || byNew(a, b));
  return rows.sort(byNew);
}

function render() {
  const list = $('rm-list');
  list.textContent = '';
  const rows = sorted();

  if (!rows.length) {
    const li = document.createElement('li');
    const box = el('div', 'vg-empty');
    if (coins.length && query) {
      box.textContent = `No coin matches "${query}".`;
    } else if (scanning) {
      // Never "nobody has etched a coin" while the scan is unfinished. That sentence appeared on a
      // live site with five coins on the chain, and it was the page's own words, not the data's.
      box.append(el('p', '', 'Nothing found yet, and the index has not finished reading the chain. '
        + 'This page will fill in on its own.'));
    } else {
      box.append(el('p', '', 'No coin has been etched yet.'));
      const a = el('a', 'vg-btn primary', 'Etch the first one');
      a.href = '/etch';
      box.append(a);
    }
    li.append(box);
    list.append(li);
    return;
  }

  for (const c of rows) list.append(rowFor(c));
}

/**
 * How far the mint has got, or why there is no bar.
 *
 * A coin with no open terms gets NO track at all. Drawing an empty one beside "no open mint" reads
 * as nought per cent minted, when the truth is the opposite: every coin of it already exists and
 * went to the creator in the etching.
 */
function progressFor(c) {
  const prog = el('div', 'rm-prog');
  if (!c.mint) {
    prog.append(el('span', 'rm-pct', 'no open mint, ' + compact(c.whole.supply) + ' supply'));
    return prog;
  }

  const pct = (c.mintedShare || 0) * 100;
  const track = el('div', 'vg-bar thin');
  const fill = el('span');
  // A sliver for anything above zero, so a coin that has genuinely started does not read as
  // untouched. Nought stays nought.
  fill.style.width = Math.min(100, pct > 0 ? Math.max(2, pct) : 0).toFixed(2) + '%';
  if (pct >= 100) fill.classList.add('done');
  track.append(fill);

  const label = el('span', 'rm-pct');
  if (!c.mint.open) {
    label.textContent = (c.mint.closedBecause || [])[0] || 'mint closed';
    label.classList.add('closed');
  } else if (c.mint.remaining == null) {
    label.textContent = `${pct.toFixed(0)}% minted, no limit on claims`;
  } else {
    label.textContent = `${pct > 0 && pct < 1 ? pct.toFixed(2) : pct.toFixed(0)}% minted, `
      + `${compact(c.mint.remaining)} claims left`;
  }
  prog.append(track, label);
  return prog;
}

function rowFor(c) {
  const li = document.createElement('li');
  li.className = 'rm-row';
  const href = '/runes/coin?rune=' + encodeURIComponent(c.runeRef);

  const id = el('div', 'rm-id');
  const mark = el('div', 'rm-mark', c.symbol || '¤');
  const names = el('div', 'rm-names');
  const name = el('a', 'rm-name', c.display);
  name.href = href;
  names.append(name, el('span', 'rm-ref', c.runeRef));
  id.append(mark, names);
  li.append(id);

  // The ask, per whole coin. `null` is "nobody is selling", which is a different fact from "cheap".
  if (c.market.bestAsk === null) {
    val(li, 'cheapest ask', 'No asks', true);
  } else {
    val(li, 'cheapest ask', fmtXvg(c.market.bestAsk) + ' XVG');
  }

  if (c.market.forSale > 0) {
    const box = val(li, 'for sale', compact(c.market.forSaleWhole));
    box.append(el('span', 'sub', `on ${c.market.asks} listing${c.market.asks === 1 ? '' : 's'}`));
  } else {
    val(li, 'for sale', '-', true);
  }

  li.append(progressFor(c));

  val(li, 'coins holding it', fmtN(c.carriers), c.carriers === 0);

  const go = el('a', 'vg-btn rm-go', c.market.asks > 0 ? 'Buy' : (c.mint && c.mint.open ? 'Mint' : 'Open'));
  go.href = href;
  li.append(go);
  return li;
}

$('q').addEventListener('input', (e) => {
  query = e.target.value.trim().toUpperCase();
  render();
});

for (const b of document.querySelectorAll('.rm-sort')) {
  b.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.rm-sort')) other.classList.toggle('is-on', other === b);
    sort = b.dataset.sort;
    render();
  });
}

load();
