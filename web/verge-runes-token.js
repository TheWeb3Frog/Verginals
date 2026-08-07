// One asset's page: price, the listings, who holds it, what has traded.
//
// The differences from a Runes marketplace are all downstream of one protocol fact: a balance lives
// on an output, so a listing sells a whole carrier and not an amount. That turns the order book
// into a set of discrete lots, which is a worse fit for a depth chart and a better fit for a grid
// of cards, so that is what this is.

import { priceChart, volumeChart, fmtShort, fmtPrice } from './verge-runes-chart.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmt = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const TICKER = (new URLSearchParams(location.search).get('t') || 'GRUMPY').toUpperCase();

// --- sample asset ---------------------------------------------------------------------------

const ASSET = {
  ticker: TICKER,
  name: 'Grumpy Token',
  divisibility: 2,
  price: 0.0421,
  ch24: 12.4,
  supply: 21000000,
  minted: 14700000,
  holders: 412,
  vol24: 184000,
  cap: 884100,
  etchedAt: 9312440,
  royalty: null,
};

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

const rand = (() => { let s = 20260808; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

/** 90 days of last-price, with trades on maybe a third of them. Gaps are the point. */
const HISTORY = (() => {
  const out = [];
  let v = 0.0182;
  for (let i = 89; i >= 0; i--) {
    const traded = rand() > 0.62;
    if (traded) v = Math.max(0.004, v * (1 + (rand() - 0.42) * 0.16));
    out.push({ t: NOW - i * DAY, v, trade: traded });
  }
  out[out.length - 1].v = ASSET.price;
  out[out.length - 1].trade = true;
  return out;
})();

const VOLUME = HISTORY.map((p) => ({
  t: p.t,
  v: p.trade ? Math.round(2000 + rand() * 30000) : 0,
  trades: p.trade ? 1 + Math.floor(rand() * 5) : 0,
}));

// A listing is a carrier. Some of them hold more than the token, which is exactly the thing the
// interface exists to make impossible to miss.
const LISTINGS = [
  { amount: 500000, xvg: 21050, extras: [], age: '2h' },
  { amount: 120000, xvg: 5120, extras: [], age: '5h' },
  { amount: 250000, xvg: 10800, extras: ['Verginal #118'], age: '9h' },
  { amount: 80000, xvg: 3480, extras: [], age: '11h' },
  { amount: 1000000, xvg: 43900, extras: ['WRAITH 4,000.00'], age: '1d' },
  { amount: 60000, xvg: 2700, extras: [], age: '1d' },
];

const TRADES = [
  { amount: 500000, xvg: 21000, age: '18m' },
  { amount: 75000, xvg: 3150, age: '1h' },
  { amount: 240000, xvg: 9980, age: '3h' },
  { amount: 1000000, xvg: 40900, age: '6h' },
  { amount: 30000, xvg: 1230, age: '9h' },
];

const HOLDERS = [
  { label: 'Top holder', pct: 8.2 },
  { label: 'Top 10', pct: 31.4 },
  { label: 'Top 50', pct: 58.9 },
  { label: 'Everyone else', pct: 41.1 },
];

const disp = (atomic) => (atomic / 10 ** ASSET.divisibility)
  .toLocaleString('en-US', { minimumFractionDigits: ASSET.divisibility, maximumFractionDigits: ASSET.divisibility });
const unitPrice = (l) => l.xvg / (l.amount / 10 ** ASSET.divisibility);

// --- header ---------------------------------------------------------------------------------

function header() {
  const host = $('#vr-hero');
  host.textContent = '';

  const top = el('div', 'vr-hero-top');
  top.append(el('div', 'vr-badge lg', ASSET.ticker.slice(0, 3)));
  const names = el('div', 'vr-grow');
  const line = el('div', 'vr-hero-name');
  line.append(el('span', '', ASSET.ticker));
  // The verification badge is the one thing this page has that no other token page can offer.
  const v = el('span', 'vr-tag ok', 'ROOT VERIFIED');
  v.title = 'Every balance on this page was checked against the merkle root published on chain at '
    + 'the last checkpoint. No indexer had to be believed.';
  line.append(v);
  names.append(line);
  names.append(el('div', 'vr-nm', `${ASSET.name} · etched at block ${fmt(ASSET.etchedAt)}`));
  top.append(names);
  host.append(top);

  // Hero figure: the one number the page leads with.
  const price = el('div', 'vr-hero-price');
  price.append(el('span', 'vr-hero-num', fmtPrice(ASSET.price)));
  price.append(el('span', 'vr-hero-unit', 'XVG'));
  const d = el('span', `vr-delta big ${ASSET.ch24 >= 0 ? 'up' : 'down'}`);
  d.append(el('span', 'vr-arrow', ASSET.ch24 >= 0 ? '▲' : '▼'));
  d.append(el('span', '', `${ASSET.ch24 >= 0 ? '+' : ''}${ASSET.ch24.toFixed(1)}% 24h`));
  price.append(d);
  host.append(price);

  // A KPI row of stat tiles, not a grouped bar chart of four unrelated numbers.
  const kpis = el('div', 'vr-kpis');
  const tile = (label, value, sub) => {
    const t = el('div', 'vr-kpi');
    t.append(el('div', 'vr-kpi-l', label));
    t.append(el('div', 'vr-kpi-v', value));
    if (sub) t.append(el('div', 'vr-kpi-s', sub));
    kpis.append(t);
  };
  tile('Market cap', `${fmtShort(ASSET.cap)} XVG`, 'price × circulating');
  tile('24h volume', `${fmtShort(ASSET.vol24)} XVG`, `${TRADES.length} settled trades`);
  tile('Holders', fmt(ASSET.holders), 'outputs carrying a balance');
  tile('Minted', `${Math.round((ASSET.minted / ASSET.supply) * 100)}%`, `${fmtShort(ASSET.minted)} of ${fmtShort(ASSET.supply)}`);
  host.append(kpis);
}

// --- charts ---------------------------------------------------------------------------------

let range = 90;

function charts() {
  const slice = HISTORY.slice(-range);
  const vslice = VOLUME.slice(-range);
  priceChart($('#vr-price'), { points: slice, height: 250 });
  volumeChart($('#vr-vol'), { points: vslice, height: 84 });

  const traded = slice.filter((p) => p.trade).length;
  $('#vr-price-note').textContent = `${traded} of the last ${range} days had a trade. `
    + 'Days with none hold the last price rather than inventing one, and the dots are the trades.';
}

function ranges() {
  const bar = $('#vr-ranges');
  bar.textContent = '';
  for (const [days, label] of [[7, '7D'], [30, '30D'], [90, '90D']]) {
    const b = el('button', `vr-segb${days === range ? ' on' : ''}`, label);
    b.onclick = () => {
      range = days;
      [...bar.children].forEach((c) => { c.className = 'vr-segb'; });
      b.className = 'vr-segb on';
      charts();
    };
    bar.append(b);
  }
}

// --- listings ---------------------------------------------------------------------------------

function listings() {
  const host = $('#vr-listings');
  host.textContent = '';

  const floor = Math.min(...LISTINGS.map(unitPrice));
  $('#vr-floor').textContent = `${fmtPrice(floor)} XVG`;

  for (const l of LISTINGS.slice().sort((a, b) => unitPrice(a) - unitPrice(b))) {
    const card = el('div', `vr-listing${l.extras.length ? ' carries' : ''}`);

    const head = el('div', 'vr-row');
    head.append(el('div', 'vr-listing-amt', disp(l.amount)));
    head.append(el('div', 'vr-grow'));
    head.append(el('div', 'vr-listing-unit', `${fmtPrice(unitPrice(l))} /unit`));
    card.append(head);

    card.append(el('div', 'vr-listing-total', `${fmt(l.xvg)} XVG total`));

    // Everything else on the carrier, before the button, always. A listing that hides this is how
    // someone sells an inscription for the price of a token.
    if (l.extras.length) {
      const warn = el('div', 'vr-carry');
      warn.append(el('div', 'vr-carry-h', 'This carrier also holds'));
      for (const x of l.extras) warn.append(el('div', 'vr-carry-i', x));
      card.append(warn);
    }

    const foot = el('div', 'vr-row foot');
    const b = el('button', 'vr-btn sm', 'Buy carrier');
    b.disabled = true;
    foot.append(b);
    foot.append(el('span', 'vr-nm', `listed ${l.age}`));
    card.append(foot);
    host.append(card);
  }
}

// --- tables ------------------------------------------------------------------------------------

function trades() {
  const body = $('#vr-trades');
  body.textContent = '';
  for (const t of TRADES) {
    const tr = el('tr');
    tr.append(el('td', '', disp(t.amount)));
    tr.append(el('td', 'vr-n', fmtPrice(t.xvg / (t.amount / 10 ** ASSET.divisibility))));
    tr.append(el('td', 'vr-n', fmt(t.xvg)));
    tr.append(el('td', 'vr-n', t.age));
    body.append(tr);
  }
}

/**
 * Concentration, as a meter per band rather than a pie.
 *
 * A pie of four slices is unreadable and the question here is not "what are the parts", it is "how
 * much does the top of the book control", which is a ratio against a limit.
 */
function holders() {
  const host = $('#vr-holders');
  host.textContent = '';
  for (const h of HOLDERS) {
    const row = el('div', 'vr-meter');
    const head = el('div', 'vr-row');
    head.append(el('span', 'vr-meter-l', h.label));
    head.append(el('div', 'vr-grow'));
    head.append(el('span', 'vr-meter-v', `${h.pct.toFixed(1)}%`));
    row.append(head);
    const track = el('div', 'vr-bar');
    const fill = el('i');
    fill.style.width = `${h.pct}%`;
    track.append(fill);
    row.append(track);
    host.append(row);
  }
}

function tabs() {
  const bar = $('#vr-tabs');
  const panes = { listings: $('#vr-pane-listings'), trades: $('#vr-pane-trades'), holders: $('#vr-pane-holders') };
  for (const b of bar.querySelectorAll('button')) {
    b.onclick = () => {
      for (const x of bar.querySelectorAll('button')) x.className = 'vr-tab';
      b.className = 'vr-tab on';
      for (const k of Object.keys(panes)) panes[k].hidden = k !== b.dataset.pane;
    };
  }
}

async function status() {
  const node = $('#vr-status');
  try {
    const info = await (await fetch('/api/info')).json();
    if (info.assets) {
      node.className = 'vr-status bad';
      node.textContent = 'This server reports assets ENABLED, which it should not be. Tell someone.';
      return;
    }
  } catch (_) { /* still true */ }
  node.textContent = `${ASSET.ticker} does not exist. Every number here is invented, the protocol is `
    + 'switched off on this server, and nothing on this page can spend a coin.';
}

status();
header();
ranges();
charts();
listings();
trades();
holders();
tabs();
