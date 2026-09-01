// One bar, five intents, defined once and injected on every page.
//
// What it replaces: a shared bar, a second bar and a twelve-item tab strip, stacked before any
// content on the home page, with only three of those twelve reachable from the shared one. Six
// separate copies of the markup, which is how a nav link came to point at a page that had moved.
//
// Defined in JavaScript on purpose. Every page on this site already renders its content by fetching
// it, so a nav that needs the same is free, and one definition cannot drift from another.

const NAV = [
  {
    id: 'collect', label: 'Collect', title: 'Collect',
    items: [
      { href: '/#mint', text: 'Mint an Alpha', note: 'free' },
      { href: '/#explore', text: 'Explore' },
      { href: '/#market', text: 'Market' },
      { href: '/#collection', text: 'Alpha Collection' },
    ],
  },
  {
    id: 'create', label: 'Create', title: 'Create',
    items: [
      { href: '/#inscribe', text: 'Inscribe a file or text' },
      { href: '/etch', text: 'Etch a coin' },
      { href: '/#launchpad', text: 'Launch a collection' },
    ],
  },
  {
    id: 'coins', label: 'Coins', title: 'Coins, Verge Runes',
    items: [
      { href: '/runes/mint', text: 'Mint', key: 'open' },
      { href: '/runes/market', text: 'Market', key: 'coins' },
      { href: '/airdrop', text: 'Airdrop', note: 'free' },
      { href: '/runes', text: 'How it works' },
      { href: '/unlock', text: 'Recover a deposit' },
    ],
  },
  { id: 'play', label: 'Play', href: '/arena' },
  { id: 'stats', label: 'Stats', href: '/#stats' },
];

const FOOT = [
  { href: '/#vision', text: 'Vision' },
  { href: '/#support', text: 'Support' },
  { href: '/#terms', text: 'Terms' },
  { href: '/privacy', text: 'Privacy' },
  { href: '/verginalswallet', text: 'Wallet extension' },
  { href: '/recovery-kit.html', text: 'Recovery kit' },
];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function buildNav(active) {
  const nav = el('nav', 'vg-nav');
  nav.setAttribute('aria-label', 'Site');
  const inner = el('div', 'vg-nav-in');

  const brand = el('a', 'vg-brand');
  brand.href = '/';
  brand.append(el('i'), document.createTextNode('VERGINALS'));
  inner.append(brand);

  const menu = el('ul', 'vg-menu');
  for (const group of NAV) {
    const li = el('li');
    if (group.href) {
      const a = el('a', 'vg-top' + (active === group.id ? ' is-on' : ''), group.label);
      a.href = group.href;
      if (active === group.id) a.setAttribute('aria-current', 'page');
      li.append(a);
    } else {
      const btn = el('button', 'vg-top' + (active === group.id ? ' is-on' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.append(document.createTextNode(group.label), el('span', 'caret', '▾'));
      const panel = el('div', 'vg-panel-menu');
      panel.append(el('p', 'vg-label', group.title));
      for (const item of group.items) {
        const a = el('a');
        a.href = item.href;
        a.append(el('span', '', item.text));
        // A count lands here once it is known. Left out entirely rather than shown as zero while
        // it loads, because "0 coins" and "not asked yet" are different facts.
        const em = el('em', '', item.note || '');
        if (item.key) em.dataset.count = item.key;
        a.append(em);
        panel.append(a);
      }
      li.append(btn, panel);

      // Decided once, here, because every handler below branches on it.
      const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      let shutTimer = null;

      const open = (on) => {
        for (const other of menu.querySelectorAll('li[data-open]')) {
          if (other !== li) { delete other.dataset.open; other.querySelector('.vg-top').setAttribute('aria-expanded', 'false'); }
        }
        if (on) li.dataset.open = '1'; else delete li.dataset.open;
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      };
      // A CLICK HERE NEVER CLOSES, when there is a pointer.
      //
      // It used to toggle, and that is the bug people actually hit. Hovering opens the panel; the
      // thing under the cursor then looks exactly like a button, so they click it; the toggle shuts
      // it again under the cursor. And because the pointer never LEFT the item, no mouseenter can
      // fire to bring it back, so the menu stays shut and the only way out is another click. That
      // is the "it disappears and I have to click to get it back" report, exactly.
      //
      // On a touch screen there is no hover, so the tap has to keep toggling or a panel could never
      // be dismissed.
      btn.addEventListener('click', () => { clearTimeout(shutTimer); open(fine ? true : !li.dataset.open); });
      // Hover only where there is a real pointer. On a touch screen a hover-open menu swallows the
      // first tap and the person thinks the link is broken.
      //
      // And it does not shut the instant the pointer leaves. Between the button and the panel there
      // is a seam, and a menu that closes on the way across it cannot be used at all: you aim at a
      // sub-item, cross the seam, and the thing you were aiming at is gone. The grace period is
      // short enough to feel immediate and long enough to survive the crossing.
      if (fine) {
        li.addEventListener('mouseenter', () => { clearTimeout(shutTimer); open(true); });
        // The safety net, and the reason the menu can no longer get stuck: mouseenter only fires on
        // ENTRY, so any path that closes the panel while the pointer is still inside leaves it shut
        // with no way to reopen by moving. This reopens it on the next movement over the item, so
        // "the pointer is on it" and "it is open" cannot drift apart, whatever closed it.
        li.addEventListener('mousemove', () => {
          if (li.dataset.open) return;
          clearTimeout(shutTimer);
          open(true);
        });
        li.addEventListener('mouseleave', () => {
          clearTimeout(shutTimer);
          shutTimer = setTimeout(() => open(false), 300);
        });
      }
      li.addEventListener('focusout', (e) => {
        if (!li.contains(e.relatedTarget)) open(false);
      });
    }
    menu.append(li);
  }
  inner.append(menu);

  const right = el('div', 'vg-nav-right');
  const tip = el('span', 'vg-tip');
  tip.dataset.tip = '1';
  right.append(tip);
  // THE CONNECT BUTTON, and it must keep this id.
  //
  // wallet.js finds #wallet-connect and drives everything from it: the connect flow, the three
  // states it can be in, the "Pay with Verginals Wallet" buttons, and the address autofill that
  // spares somebody pasting a Verge address into the mint form by hand. Replacing this with a
  // plain link to the wallet tab took all of that away and left people typing an address.
  const wallet = el('button', 'vg-btn primary vg-nav-wallet', 'Connect Wallet');
  wallet.type = 'button';
  wallet.id = 'wallet-connect';
  right.append(wallet);
  const burger = el('button', 'vg-burger', '☰');
  burger.type = 'button';
  burger.setAttribute('aria-label', 'Menu');
  burger.addEventListener('click', () => nav.classList.toggle('is-open'));
  right.append(burger);
  inner.append(right);

  nav.append(inner);
  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target)) {
      for (const li of menu.querySelectorAll('li[data-open]')) {
        delete li.dataset.open;
        const t = li.querySelector('.vg-top');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
      nav.classList.remove('is-open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    nav.classList.remove('is-open');
    for (const li of menu.querySelectorAll('li[data-open]')) {
      delete li.dataset.open;
      const t = li.querySelector('.vg-top');
      if (t) t.setAttribute('aria-expanded', 'false');
    }
  });
  return nav;
}

function buildContext(where, right) {
  if (!where) return null;
  const bar = el('div', 'vg-context');
  const inner = el('div', 'vg-context-in');
  const trail = el('div');
  where.forEach((step, i) => {
    if (i) trail.append(document.createTextNode('  /  '));
    if (step.href) {
      const a = el('a', '', step.text);
      a.href = step.href;
      trail.append(a);
    } else trail.append(document.createTextNode(step.text));
  });
  inner.append(trail);
  if (right) inner.append(el('span', '', right));
  bar.append(inner);
  return bar;
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
  // The claim that matters most, in the place a claim like this belongs: stated flatly, every page,
  // never argued.
  inner.append(el('span', 'vg-foot-claim', 'no account · no balance · no fee'));
  foot.append(inner);
  return foot;
}

/** Live figures for the bar and the Coins panel. Silent on failure: none of it is load-bearing. */
async function hydrate(nav) {
  const tip = nav.querySelector('[data-tip]');
  try {
    const info = await fetch('/api/info').then((r) => (r.ok ? r.json() : null));
    if (info && info.tip && tip) {
      tip.append(el('b', '', 'block '), document.createTextNode(Number(info.tip).toLocaleString()));
    }
  } catch { /* the height is a nicety, never a dependency */ }

  const slot = (key) => nav.querySelector(`[data-count="${key}"]`);
  try {
    const r = await fetch('/api/runes/coins').then((x) => (x.ok ? x.json() : null));
    const coins = (r && r.coins) || [];
    const open = coins.filter((c) => c.mint && c.mint.open).length;
    if (slot('coins')) slot('coins').textContent = coins.length ? `${coins.length} coins` : '';
    if (slot('open')) slot('open').textContent = open ? `${open} open` : '';
  } catch { /* same */ }
}

/**
 * Put the bar, the context strip and the footer on this page.
 *
 * `where` is the trail for the strip under the bar, e.g. [{text:'Coins',href:'/runes/market'},
 * {text:'Market'}]. Pass nothing and no strip is drawn.
 */
export function mountChrome({ active, where, right } = {}) {
  const nav = buildNav(active);
  document.body.prepend(nav);
  const ctx = buildContext(where, right);
  if (ctx) nav.after(ctx);
  const main = document.querySelector('main');
  if (main) main.after(buildFooter()); else document.body.append(buildFooter());
  hydrate(nav);
  // The bar arrives after the classic scripts have run, because a module is deferred and they are
  // not. Anything that wires itself to a control in here has to be told the control now exists.
  document.dispatchEvent(new CustomEvent('vg:chrome'));
  return nav;
}
