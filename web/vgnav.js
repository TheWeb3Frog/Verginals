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

const NAV = [
  {
    title: 'Verginals',
    items: [
      { href: '/#home', text: 'Home' },
      { href: '/#mint', text: 'Mint an Alpha', note: 'free' },
      { href: '/#explore', text: 'Explore' },
      { href: '/#collection', text: 'Collection' },
      { href: '/#market', text: 'Market' },
    ],
  },
  {
    title: 'Coins',
    items: [
      { href: '/runes/market', text: 'Coin market', key: 'coins' },
      { href: '/runes/mint', text: 'Mint a coin', key: 'open' },
      { href: '/etch', text: 'Etch a coin' },
      { href: '/airdrop', text: 'Airdrop', note: 'free' },
      { href: '/runes', text: 'How it works' },
    ],
  },
  {
    title: 'Create',
    items: [
      { href: '/#inscribe', text: 'Inscribe' },
      { href: '/#launchpad', text: 'Launchpad' },
    ],
  },
  {
    title: 'More',
    items: [
      { href: '/arena', text: 'Arena' },
      { href: '/#wallet', text: 'My wallet' },
      { href: '/#stats', text: 'Stats' },
      { href: '/unlock', text: 'Recover a deposit' },
    ],
  },
];

const FOOT = [
  { href: '/#vision', text: 'Vision' },
  { href: '/#support', text: 'Support' },
  { href: '/#terms', text: 'Terms' },
  { href: '/privacy', text: 'Privacy' },
  { href: '/verginalswallet', text: 'Wallet extension' },
  { href: '/recovery-kit.html', text: 'Recovery kit' },
];

const STORE_URL = 'https://chromewebstore.google.com/detail/ficjfnjaiopghnpohemapfbilflfflip';

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
  brand.append(el('i'), document.createTextNode('VERGINALS'));
  side.append(brand);

  const scroll = el('nav', 'vg-side-scroll');
  for (const group of NAV) {
    scroll.append(el('p', 'vg-side-label', group.title));
    const list = el('ul', 'vg-side-list');
    for (const item of group.items) {
      const li = el('li');
      const a = el('a', 'vg-side-link' + (isHere(item.href, active) ? ' is-on' : ''));
      a.href = item.href;
      a.append(el('span', '', item.text));
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
  const install = el('a', 'vg-side-install', 'Get the wallet');
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
