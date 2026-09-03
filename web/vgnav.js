// One sidebar, one top bar, defined once and injected on every page.
//
// What it replaces: a horizontal strip of five items, three of which opened a hover panel. Those
// panels were the single most reported piece of this site. A hover menu has to survive the pointer
// crossing a seam, a click that lands on the button underneath it, and a touch screen with no
// hover at all, and it kept failing at least one of the three.
//
// A sidebar has none of those problems, because nothing is hidden. Every destination on the site is
// on screen at once, which is why ord.net and opensea are laid out this way and why it also happens
// to be the easier thing to build correctly.
//
// Defined in JavaScript on purpose. Every page here already renders its content by fetching it, so
// a nav that does the same is free, and one definition cannot drift from another.

// Twelve destinations in three groups, and the count is the design.
//
// The rail is collapsed to its icons until somebody points at it, so every entry has to be legible
// as a symbol alone and the column has to be short enough to read at a glance. Sixteen entries in
// four groups was a wall. What came out of it went to the footer links below, which is where things
// you need once belong: how it works, the launchpad, stats, and recovering a deposit.
//
// The icons are inline SVG, not emoji. Emoji render differently on every platform and at this size
// half of them are unreadable; these are one stroke weight, one grid, and they take the colour of
// the row they sit in.
const ICON = {
  home: 'M3 9.2 10 3.5l7 5.7V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1Z',
  cat: 'M4 8.5 4 4l3.2 2.2h5.6L16 4v4.5m-12 0v4A4.5 4.5 0 0 0 8.5 17h3A4.5 4.5 0 0 0 16 12.5v-4m-12 0h12M7.5 11h.01M12.5 11h.01',
  explore: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm3-10.5-1.8 4.2L7 13l1.8-4.2Z',
  grid: 'M3.5 3.5h5.5v5.5H3.5Zm7.5 0h5.5v5.5H11ZM3.5 11h5.5v5.5H3.5Zm7.5 0h5.5v5.5H11Z',
  tag: 'M9.6 3.5H16a.5.5 0 0 1 .5.5v6.4a1 1 0 0 1-.3.7l-5.6 5.6a1 1 0 0 1-1.4 0l-6.4-6.4a1 1 0 0 1 0-1.4l5.6-5.6a1 1 0 0 1 .7-.3Zm3.4 3.4h.01',
  chart: 'M3.5 16.5h13M6 13.5V9m4 4.5V5m4 8.5v-6',
  coin: 'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm0-11v7m-2.6-5.2h3.9a1.6 1.6 0 0 1 0 3.2H8.7a1.6 1.6 0 0 0 0 3.2h3.9',
  etch: 'M13.2 3.6a1.9 1.9 0 0 1 2.7 2.7L7.6 14.6l-3.6.9.9-3.6ZM11.8 5l2.7 2.7',
  drop: 'M10 2.8a5.5 5.5 0 0 0-5.5 5.5h11A5.5 5.5 0 0 0 10 2.8Zm0 0v5.5m-5.5 0 3.4 8.4m7.6-8.4-3.4 8.4m-4.2-8.4 4.2 8.4',
  pen: 'M4 16h12M12.6 3.9a1.7 1.7 0 0 1 2.4 2.4l-7.4 7.4-3.2.8.8-3.2Z',
  swords: 'M14.5 3.5h2v2l-6.6 6.6-2-2ZM5.5 3.5h-2v2l6.6 6.6 2-2M6.2 12.2 3.7 14.7l1.6 1.6 2.5-2.5m6-1.6 2.5 2.5-1.6 1.6-2.5-2.5',
  launch: 'M10 13V3.5m0 0L6.8 6.7M10 3.5l3.2 3.2M3.5 12v3a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-3',
  wallet: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h10.5a1 1 0 0 1 1 1v1.5m-13-1v8A1.5 1.5 0 0 0 5 16h11a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H5a1.5 1.5 0 0 1-1.5-1.5ZM13.5 11h.01',
};

const NAV = [
  {
    title: 'Collect',
    items: [
      { href: '/#home', text: 'Home', icon: 'home' },
      { href: '/#mint', text: 'Mint an Alpha', icon: 'cat', note: 'free' },
      { href: '/#explore', text: 'Explore', icon: 'explore' },
      { href: '/#collection', text: 'Collection', icon: 'grid' },
      { href: '/#market', text: 'Market', icon: 'tag' },
    ],
  },
  {
    title: 'Coins',
    items: [
      { href: '/runes/market', text: 'Coin market', icon: 'chart', key: 'coins' },
      { href: '/runes/mint', text: 'Mint a coin', icon: 'coin', key: 'open' },
      { href: '/etch', text: 'Etch a coin', icon: 'etch' },
      { href: '/airdrop', text: 'Airdrop', icon: 'drop', note: 'free' },
    ],
  },
  {
    title: 'More',
    items: [
      { href: '/#inscribe', text: 'Inscribe', icon: 'pen' },
      { href: '/#launchpad', text: 'Launch a collection', icon: 'launch' },
      { href: '/arena', text: 'Arena', icon: 'swords' },
      { href: '/#wallet', text: 'My wallet', icon: 'wallet' },
    ],
  },
];

const FOOT = [
  { href: '/runes', text: 'How coins work' },
  { href: '/#stats', text: 'Stats' },
  { href: '/unlock', text: 'Recover a deposit' },
  { href: '/#vision', text: 'Vision' },
  { href: '/#support', text: 'Support' },
  { href: '/#terms', text: 'Terms' },
  { href: '/privacy', text: 'Privacy' },
  { href: '/verginalswallet', text: 'Wallet extension' },
  { href: '/recovery-kit.html', text: 'Recovery kit' },
];

const STORE_URL = 'https://chromewebstore.google.com/detail/ficjfnjaiopghnpohemapfbilflfflip';

/**
 * The Verginals mark: the same V the favicon draws, inline so it is one request fewer and can be
 * sized by CSS. It was a plain gradient square, which is a placeholder, not a logo.
 */
function logoMark() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'vg-logo');
  svg.setAttribute('aria-hidden', 'true');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.setAttribute('id', 'vgLogoG');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
  for (const [off, col] of [['0', '#4cc2f1'], ['1', '#1aa3e0']]) {
    const stop = document.createElementNS(NS, 'stop');
    stop.setAttribute('offset', off);
    stop.setAttribute('stop-color', col);
    grad.append(stop);
  }
  const defs = document.createElementNS(NS, 'defs');
  defs.append(grad);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '32'); bg.setAttribute('height', '32');
  bg.setAttribute('rx', '7'); bg.setAttribute('fill', '#0b1017');
  const v = document.createElementNS(NS, 'path');
  v.setAttribute('d', 'M8 9 L16 23 L24 9');
  v.setAttribute('fill', 'none');
  v.setAttribute('stroke', 'url(#vgLogoG)');
  v.setAttribute('stroke-width', '3.6');
  v.setAttribute('stroke-linecap', 'round');
  v.setAttribute('stroke-linejoin', 'round');
  svg.append(defs, bg, v);
  return svg;
}

/** One icon, drawn from the table above. Inherits the row's colour and never carries its own. */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', 'vg-side-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON[name] || ICON.grid);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** Does this link point at where we already are? Used to mark the current page, nothing else. */
function isHere(href, active) {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const [hp, hh] = href.split('#');
  const target = (hp.replace(/\/$/, '') || '/');
  if (target !== path) return false;
  if (!hh) return true;
  return active ? hh === active : (location.hash.replace(/^#/, '') || 'home') === hh;
}

function buildSide(active) {
  const side = el('aside', 'vg-side');
  side.setAttribute('aria-label', 'Site');

  const brand = el('a', 'vg-brand');
  brand.href = '/';
  brand.setAttribute('aria-label', 'Verginals, home');
  brand.append(logoMark(), el('span', 'vg-side-text', 'VERGINALS'));
  side.append(brand);

  const scroll = el('nav', 'vg-side-scroll');
  for (const group of NAV) {
    scroll.append(el('p', 'vg-side-label', group.title));
    const list = el('ul', 'vg-side-list');
    for (const item of group.items) {
      const li = el('li');
      const a = el('a', 'vg-side-link' + (isHere(item.href, active) ? ' is-on' : ''));
      a.href = item.href;
      // The label is also the tooltip: collapsed, the icon is all there is, and a pointer that
      // waits half a second should not have to wait for the rail to open to find out what it is.
      a.title = item.text;
      a.append(icon(item.icon), el('span', 'vg-side-text', item.text));
      // A count lands here once it is known. Left out rather than shown as zero while it loads,
      // because "0 coins" and "not asked yet" are different facts.
      const em = el('em', '', item.note || '');
      if (item.key) em.dataset.count = item.key;
      a.append(em);
      li.append(a);
      list.append(li);
    }
    scroll.append(list);
  }
  side.append(scroll);

  const foot = el('div', 'vg-side-foot');
  const install = el('a', 'vg-side-install');
  install.append(icon('wallet'), el('span', 'vg-side-text', 'Get the wallet'));
  install.href = STORE_URL;
  install.target = '_blank';
  install.rel = 'noopener';
  foot.append(install);
  const links = el('div', 'vg-side-mini');
  for (const f of FOOT) {
    const a = el('a', '', f.text);
    a.href = f.href;
    links.append(a);
  }
  foot.append(links);
  side.append(foot);
  return side;
}

/**
 * The top bar: the burger, where you are, and the connect button.
 *
 * It exists at every width, not only on a phone. The connect button is the primary action on this
 * site and burying it inside a drawer somebody has to open first would be worse than the hover
 * menus this replaces.
 */
function buildTop(where, right) {
  const bar = el('header', 'vg-top');
  const inner = el('div', 'vg-top-in');

  const burger = el('button', 'vg-burger');
  burger.type = 'button';
  burger.setAttribute('aria-label', 'Menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.append(el('i'), el('i'), el('i'));
  inner.append(burger);

  const trail = el('div', 'vg-crumb');
  (where || []).forEach((step, i) => {
    if (i) trail.append(document.createTextNode('  /  '));
    if (step.href) {
      const a = el('a', '', step.text);
      a.href = step.href;
      trail.append(a);
    } else trail.append(el('span', '', step.text));
  });
  inner.append(trail);

  const rightSide = el('div', 'vg-top-right');
  if (right) rightSide.append(el('span', 'vg-top-say', right));
  const tip = el('span', 'vg-tip');
  tip.dataset.tip = '1';
  rightSide.append(tip);
  // THE CONNECT BUTTON, and it must keep this id and stay the only one on the page.
  //
  // wallet.js finds #wallet-connect and drives everything from it: the connect flow, its three
  // states, the pay-with-wallet buttons and the address autofill. Removing it once already took all
  // of that away silently, and a second copy of the id would be just as bad, because
  // document.querySelector would only ever wire the first.
  const wallet = el('button', 'vg-btn primary vg-nav-wallet', 'Connect Wallet');
  wallet.type = 'button';
  wallet.id = 'wallet-connect';
  rightSide.append(wallet);
  inner.append(rightSide);

  bar.append(inner);
  return { bar, burger };
}

function buildFooter() {
  const foot = el('footer', 'vg-foot');
  const inner = el('div', 'vg-foot-in');
  inner.append(el('span', 'vg-label', 'Verginals'));
  for (const f of FOOT) {
    const a = el('a', '', f.text);
    a.href = f.href;
    inner.append(a);
  }
  // The claim that matters most, stated flatly, every page, never argued.
  inner.append(el('span', 'vg-foot-claim', 'no account · no balance · no fee'));
  foot.append(inner);
  return foot;
}

/** Live figures for the bar and the sidebar. Silent on failure: none of it is load-bearing. */
async function hydrate(root) {
  const tip = root.querySelector('[data-tip]');
  try {
    const info = await fetch('/api/info').then((r) => (r.ok ? r.json() : null));
    if (info && info.tip && tip) {
      tip.append(el('b', '', 'block '), document.createTextNode(Number(info.tip).toLocaleString()));
    }
  } catch { /* the height is a nicety, never a dependency */ }

  const slot = (key) => root.querySelector(`[data-count="${key}"]`);
  try {
    const r = await fetch('/api/runes/coins').then((x) => (x.ok ? x.json() : null));
    const coins = (r && r.coins) || [];
    const open = coins.filter((c) => c.mint && c.mint.open).length;
    if (slot('coins')) slot('coins').textContent = coins.length ? `${coins.length}` : '';
    if (slot('open')) slot('open').textContent = open ? `${open} open` : '';
  } catch { /* same */ }
}

/**
 * Put the sidebar, the top bar and the footer on this page.
 *
 * `where` is the trail shown in the top bar, e.g. [{text:'Coins',href:'/runes/market'},
 * {text:'Market'}]. `active` names the hash this page counts as, for pages that live under one.
 */
export function mountChrome({ active, where, right } = {}) {
  document.body.classList.add('vg-sided');

  const side = buildSide(active);
  const { bar, burger } = buildTop(where, right);
  document.body.prepend(bar);
  document.body.prepend(side);

  const scrim = el('div', 'vg-scrim');
  document.body.append(scrim);

  const setOpen = (on) => {
    document.body.classList.toggle('vg-side-open', on);
    burger.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  burger.addEventListener('click', () => setOpen(!document.body.classList.contains('vg-side-open')));
  scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // Following a link inside the drawer has to shut it, or a same-page hash link leaves the drawer
  // covering the thing it just navigated to.
  side.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });

  const main = document.querySelector('main');
  if (main) main.after(buildFooter()); else document.body.append(buildFooter());
  hydrate(document);
  // The chrome arrives after the classic scripts have run, because a module is deferred and they
  // are not. Anything that wires itself to a control in here has to be told it now exists.
  document.dispatchEvent(new CustomEvent('vg:chrome'));
  return side;
}
