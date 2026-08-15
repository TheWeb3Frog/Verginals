// The rune market list. Sample data throughout: there is no market yet, and the page says so.
//
// The shape follows what people already know from Runes marketplaces, because a trader should not
// have to learn a new table. What is different is forced by the protocol rather than by taste, and
// where it differs the interface says why rather than hiding it.

import { sparkline, fmtShort } from './verge-runes-chart.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// --- sample market ------------------------------------------------------------------------------

const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

function series(seed, start, drift) {
  const r = rng(seed);
  const out = [];
  let v = start;
  for (let i = 0; i < 12; i++) {
    v = Math.max(start * 0.25, v * (1 + drift * 0.01 + (r() - 0.5) * 0.14));
    out.push(v);
  }
  return out;
}

const ASSETS = [
  { ticker: 'GRUMPY', name: 'Grumpy Token', price: 0.0421, ch: 12.4, vol: 184000, cap: 884100, holders: 412, listings: 37, seed: 7 },
  { ticker: 'VERGE', name: 'Verge Reserve', price: 1.204, ch: -3.1, vol: 96200, cap: 2408000, holders: 288, listings: 19, seed: 21 },
  { ticker: 'WRAITH', name: 'Wraith', price: 0.0088, ch: 41.7, vol: 71400, cap: 184800, holders: 903, listings: 64, seed: 33 },
  { ticker: 'SUNEROK', name: 'Sunerok', price: 0.3312, ch: 0.4, vol: 40100, cap: 662400, holders: 156, listings: 12, seed: 44 },
  { ticker: 'RUNE', name: 'Rune Fragment', price: 0.0016, ch: -18.2, vol: 28800, cap: 33600, holders: 1204, listings: 88, seed: 51 },
  { ticker: 'BLACKPAPER', name: 'Blackpaper', price: 0.0007, ch: 6.9, vol: 9100, cap: 14700, holders: 640, listings: 41, seed: 62 },
];

// --- rows ----------------------------------------------------------------------------------------

/**
 * The 24h change.
 *
 * Green and red carry a glyph and a signed number, always. Colour alone would leave a deuteranope
 * with nothing: the two hues sit at a CVD separation that is legal only when something else says
 * the same thing, and the arrow plus the sign is that something.
 */
function delta(pct) {
  const wrap = el('span', `vr-delta ${pct >= 0 ? 'up' : 'down'}`);
  wrap.append(el('span', 'vr-arrow', pct >= 0 ? '▲' : '▼'));
  wrap.append(el('span', '', `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`));
  return wrap;
}

let sortKey = 'vol';
let sortDir = -1;
let query = '';

function rows() {
  const tbody = $('#vr-rows');
  tbody.textContent = '';
  const list = ASSETS
    .filter((a) => !query || a.ticker.includes(query) || a.name.toUpperCase().includes(query))
    .slice()
    .sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : -1) * sortDir);

  if (!list.length) {
    const tr = el('tr');
    const td = el('td', 'vr-empty', 'Nothing matches that.');
    td.colSpan = 8;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  list.forEach((a, i) => {
    const tr = el('tr');
    tr.append(el('td', 'vr-rank', String(i + 1)));

    const idc = el('td');
    const id = el('div', 'vr-id');
    id.append(el('div', 'vr-badge', a.ticker.slice(0, 3)));
    const names = el('div');
    names.append(el('div', 'vr-tk', a.ticker));
    names.append(el('div', 'vr-nm', a.name));
    id.append(names);
    idc.append(id);
    tr.append(idc);

    tr.append(el('td', 'vr-n', `${fmt(a.price, 4)}`));
    const d = el('td', 'vr-n');
    d.append(delta(a.ch));
    tr.append(d);
    tr.append(el('td', 'vr-n', fmtShort(a.vol)));
    tr.append(el('td', 'vr-n', fmtShort(a.cap)));
    tr.append(el('td', 'vr-n', fmt(a.holders)));

    const sp = el('td', 'vr-spark');
    sp.append(sparkline(series(a.seed, a.price, a.ch)));
    tr.append(sp);

    const act = el('td');
    const b = el('a', 'vr-btn sm', `${a.listings} listed`);
    b.href = `/verge-runes-token?t=${encodeURIComponent(a.ticker)}`;
    act.append(b);
    tr.append(act);

    tbody.append(tr);
  });
}

// --- controls ------------------------------------------------------------------------------------

function controls() {
  // Filters live in one row above the table, never scattered through it.
  const bar = $('#vr-controls');
  bar.textContent = '';

  const search = el('input', 'vr-in sm');
  search.placeholder = 'Search ticker or name';
  search.setAttribute('aria-label', 'Search runes');
  search.addEventListener('input', () => { query = search.value.toUpperCase().trim(); rows(); });
  bar.append(search);

  const sorts = [['vol', '24h volume'], ['cap', 'Market cap'], ['ch', '24h change'], ['holders', 'Holders']];
  const group = el('div', 'vr-seg');
  for (const [key, label] of sorts) {
    const b = el('button', `vr-segb${key === sortKey ? ' on' : ''}`, label);
    b.onclick = () => {
      if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = -1; }
      [...group.children].forEach((c) => { c.className = 'vr-segb'; });
      b.className = 'vr-segb on';
      rows();
    };
    group.append(b);
  }
  bar.append(group);
}

// --- status --------------------------------------------------------------------------------------

async function status() {
  const node = $('#vr-status');
  try {
    const info = await (await fetch('/api/info')).json();
    if (info.runes) {
      node.className = 'vr-status bad';
      node.textContent = 'This server reports runes ENABLED, which it should not be. Tell someone.';
      return;
    }
  } catch (_) { /* the sentence below is true either way */ }
  node.textContent = 'Every figure on this page is invented. The rune protocol is switched off on '
    + 'this server, no rune has ever been etched, and nothing here can spend a coin.';
}

status();
controls();
rows();
