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

import { mountChrome } from '/vgnav.js?v=34';

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
let tip = 0;          // chain tip, so a coin's age can be read off its etching height
let sort = 'live';
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
  tip = Number(res.tip || res.height || 0);
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

// The mark colour, drawn from the collection's own palette.
//
// Every row used to carry the same grey-blue gradient square with the same fallback glyph in it,
// so fourteen coins read as fourteen identical rows and the eye had nothing to hold on to. A coin
// has no art, but it does have a permanent identity, so the colour is derived from that: the same
// coin is the same colour on every device, for ever, and no two adjacent rows look alike.
const MARKS = ['#FD0142', '#7909F9', '#FEC925', '#F18BF6', '#0DF1FF', '#59C54F',
  '#FF4F02', '#DB3FFD', '#03BF99', '#FDED58', '#0098DB',
  // Widened from eleven: fifteen coins over eleven colours put two of the same shade in one
  // short list. These three are also real collection backgrounds, so the set stays one palette.
  '#1F6F52', '#6CE3FF', '#424C6D'];

function markFor(key) {
  // FNV-1a over the ticker AND the reference. A plain h*31 over the reference alone clustered,
  // because every reference on this chain starts with the same four digits: measured against the
  // real fourteen coins in the order the page actually shows them, it put two identical colours
  // side by side. This one puts none.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const bg = MARKS[(h >>> 0) % MARKS.length];
  // Readable text on whatever came out, rather than white on lemon yellow.
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { bg, fg: lum > 0.55 ? '#0b1017' : '#ffffff' };
}

/** Can somebody do anything with this coin right now? Ranks a market by what is alive in it. */
function liveness(c) {
  if (c.market.asks > 0) return 3;          // you can buy it
  if (c.mint && c.mint.open) return 2;      // you can mint it
  if (c.carriers > 1) return 1;             // somebody other than the etcher holds it
  return 0;                                 // etched and untouched
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
  if (sort === 'new') return rows.sort(byNew);
  // The default. Newest-first was the default and it opened the market on whatever was etched last,
  // which is reliably a coin with no asks, no holders and nothing to do, so the first thing anybody
  // saw was two rows of "No asks" and a dash. Sorting by what you can actually act on puts the
  // living coins at the top without inventing a metric: it is only counting listings and mints.
  return rows.sort((a, b) => liveness(b) - liveness(a)
    || b.market.asks - a.market.asks
    || b.carriers - a.carriers
    || byNew(a, b));
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

  rows.forEach((c, i) => list.append(rowFor(c, i + 1)));
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
    prog.append(el('span', 'rm-pct', compact(c.whole.supply) + ' supply, mint closed'));
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
    label.textContent = `${pct.toFixed(0)}% minted, no limit`;
  } else {
    label.textContent = `${pct > 0 && pct < 1 ? pct.toFixed(2) : pct.toFixed(0)}% \u00b7 `
      + `${compact(c.mint.remaining)} left`;
  }
  prog.append(track, label);
  return prog;
}

/** How long ago a coin was etched, from block height. Verge aims at 30 second blocks. */
function ageOf(height, tip) {
  if (!tip || !height || tip < height) return null;
  const secs = (tip - height) * 30;
  if (secs < 3600) return Math.max(1, Math.round(secs / 60)) + 'm';
  if (secs < 86400) return Math.round(secs / 3600) + 'h';
  return Math.round(secs / 86400) + 'd';
}

function rowFor(c, rank) {
  const li = document.createElement('li');
  li.className = 'rm-row';
  const href = '/runes/coin?rune=' + encodeURIComponent(c.runeRef);

  li.append(el('span', 'rm-rank', String(rank)));

  const id = el('div', 'rm-id');
  const face = markFor(c.ticker + c.runeRef);
  const mark = el('div', 'rm-mark', c.symbol || c.ticker.slice(0, 1));
  mark.style.background = face.bg;
  mark.style.color = face.fg;
  const names = el('div', 'rm-names');
  const name = el('a', 'rm-name', c.display);
  name.href = href;
  name.title = c.display;
  names.append(name, el('span', 'rm-ref', c.runeRef));
  id.append(mark, names);
  li.append(id);

  // The floor, per whole coin. `null` is "nobody is selling", which is a different fact from
  // "cheap", and it is shown as words rather than as a zero.
  if (c.market.bestAsk === null) {
    val(li, 'floor', 'No asks', true);
  } else {
    const box = val(li, 'floor', fmtXvg(c.market.bestAsk));
    box.append(el('span', 'sub', 'XVG'));
  }

  if (c.market.forSale > 0) {
    const box = val(li, 'for sale', compact(c.market.forSaleWhole));
    box.append(el('span', 'sub', `${c.market.asks} listing${c.market.asks === 1 ? '' : 's'}`));
  } else {
    val(li, 'for sale', '-', true);
  }

  val(li, 'holders', fmtN(c.carriers), c.carriers === 0);

  li.append(progressFor(c));

  const age = ageOf(c.etchedAtHeight, tip);
  val(li, 'age', age || '-', !age);

  // What you can actually do, rather than a single word for every row.
  const go = el('a', 'vg-btn rm-go' + (c.market.asks > 0 ? ' primary' : ''),
    c.market.asks > 0 ? 'Buy' : (c.mint && c.mint.open ? 'Mint' : 'View'));
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
