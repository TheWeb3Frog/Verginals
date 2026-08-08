// Verge Assets interface preview.
//
// A separate module because the site serves every HTML response with default-src 'self', which
// refuses inline scripts. Nothing here talks to a wallet or signs anything: it reads /api/info to
// report the server's real state and everything else is a worked example computed in the page.
//
// The merkle verification in section 01 is genuine WebCrypto over sample leaves rather than a
// staged animation. A page arguing that a wallet can check its own balance should not fake the one
// thing it is arguing about.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmt = (n) => n.toLocaleString('en-US');

// --- sample data ------------------------------------------------------------------------------

// Named so nobody mistakes them for the live collection. Amounts are atomic units, as in the spec:
// GRUMPY has divisibility 2, so 125000 atomic units display as 1,250.00.
const SAMPLE = {
  asset: { ticker: 'GRUMPY', name: 'Grumpy Token', divisibility: 2, supply: 2100000000, minted: 1470000000 },
  balance: 125000,
  outpoint: 'b7d2f4a1c9e83b06f5a2d47c1e9b380a5c6f2d13e847a9b0c1d2e3f4a5b6c7d8:1',
  height: 9388000,
};

const TICKER_PRICE = {
  1: 100000, 2: 50000, 3: 25000, 4: 10000, 5: 5000, 6: 2500,
  7: 1000, 8: 500, 9: 250, 10: 100, 11: 50,
};
const priceOf = (len) => (len >= 12 ? 10 : TICKER_PRICE[len] || 0);

const display = (atomic, div) => (atomic / 10 ** div).toLocaleString('en-US', {
  minimumFractionDigits: div, maximumFractionDigits: div,
});

// --- the server's real state ------------------------------------------------------------------

async function realStatus() {
  const node = $('#vr-status');
  let info = null;
  try {
    info = await (await fetch('/api/info')).json();
  } catch (_) {
    node.textContent = 'Could not reach the API. Everything below still works: it is all computed here.';
    return;
  }
  // Said plainly. A preview that lets someone believe the protocol is live is worse than no preview.
  if (info.assets) {
    node.className = 'vr-status bad';
    node.textContent = 'This server reports assets ENABLED, which it should not be yet. Tell someone.';
    return;
  }
  node.textContent = 'Live server state: assets are switched off. Nothing on this page is real data, '
    + `and nothing here can spend a coin. Chain tip ${fmt(info.tip)}.`;
}

// --- 01 verification ---------------------------------------------------------------------------

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const cat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const bytesOf = (s) => new TextEncoder().encode(s);

/**
 * The card, in whichever of its three states.
 *
 * Unverified is the resting state and it is deliberately quiet: it means "not checked yet", which is
 * ordinary. Only a balance that contradicts a published root is loud, and then it names the indexer
 * whose root it disagrees with, because that is the actionable part.
 */
function verifySection() {
  const host = $('#vr-verify');
  host.textContent = '';

  const card = el('div', 'vr-card');
  const row = el('div', 'vr-row');
  row.append(el('div', 'vr-ticker-badge', SAMPLE.asset.ticker.slice(0, 3)));

  const mid = el('div', 'vr-grow');
  mid.append(el('div', 'vr-name', SAMPLE.asset.name));
  mid.append(el('div', 'vr-sub', `${SAMPLE.asset.ticker} · on one output`));
  row.append(mid);

  const right = el('div', '');
  right.append(el('div', 'vr-amount', display(SAMPLE.balance, SAMPLE.asset.divisibility)));
  const state = el('span', 'vr-tag', 'UNVERIFIED');
  right.append(state);
  row.append(right);
  card.append(row);

  const steps = el('div', 'vr-steps');
  card.append(steps);

  const actions = el('div', 'vr-row');
  actions.style.marginTop = '14px';
  const go = el('button', 'vr-btn', 'Verify against the on-chain root');
  const bad = el('button', 'vr-btn ghost', 'Show a failed check');
  actions.append(go, bad, el('span', 'vr-tag sample', 'SAMPLE DATA'));
  card.append(actions);
  host.append(card);

  const line = (label, value) => {
    const s = el('div', 'vr-step');
    s.append(el('b', '', label));
    if (value) s.append(el('span', 'vr-hash', value));
    steps.append(s);
    // One frame later, so the transition has something to animate from.
    requestAnimationFrame(() => { s.className = 'vr-step on'; });
    return s;
  };

  const run = async (tamper) => {
    go.disabled = true; bad.disabled = true;
    steps.textContent = '';
    state.className = 'vr-tag';
    state.textContent = 'CHECKING';

    // leaf = SHA256(outpoint || assetRef || amount), per §8.1.
    const amount = tamper ? SAMPLE.balance + 100 : SAMPLE.balance;
    const leaf = await sha256(bytesOf(`${SAMPLE.outpoint}|${SAMPLE.asset.ticker}|${amount}`));
    line('leaf', hex(leaf).slice(0, 32) + '…');

    // Three sibling hashes: a real proof, just a small tree.
    let node = leaf;
    const siblings = ['sibling-a', 'sibling-b', 'sibling-c'];
    for (let i = 0; i < siblings.length; i++) {
      const sib = await sha256(bytesOf(siblings[i]));
      node = await sha256(cat(node, sib));
      await new Promise((r) => setTimeout(r, 260));
      line(`+ sibling ${i + 1}`, hex(node).slice(0, 32) + '…');
    }

    // The published root is the one the honest leaf produces, so tampering with the amount misses.
    const honestLeaf = await sha256(bytesOf(`${SAMPLE.outpoint}|${SAMPLE.asset.ticker}|${SAMPLE.balance}`));
    let expect = honestLeaf;
    for (const s of siblings) expect = await sha256(cat(expect, await sha256(bytesOf(s))));

    await new Promise((r) => setTimeout(r, 260));
    const match = hex(node) === hex(expect);
    line(`root published at height ${fmt(SAMPLE.height)}`, hex(expect).slice(0, 32) + '…');

    if (match) {
      state.className = 'vr-tag ok';
      state.textContent = 'VERIFIED';
      line('computed root matches the published one. The balance is yours and no indexer had to be believed.');
    } else {
      state.className = 'vr-tag bad';
      state.textContent = 'DOES NOT MATCH';
      const s = line('computed root does not match the root published at this height.');
      s.append(el('span', 'vr-sub', ' The indexer that served this balance disagrees with the chain. Its identity is in the checkpoint message.'));
    }
    go.disabled = false; bad.disabled = false;
  };

  go.onclick = () => run(false);
  bad.onclick = () => run(true);
}

// --- 02 ticker pricing --------------------------------------------------------------------------

// The separator is fixed by the protocol, never chosen: two etchers picking different characters
// would produce names that look identical to a human and differ to an indexer.
const SPACER = '\u2022';

/** Where the separators sit, as a set of positions. Display only, never part of the name. */
let spacers = new Set([2, 4, 6, 9]);

const spacedName = (bare) => {
  let out = '';
  for (let i = 0; i < bare.length; i++) {
    out += bare[i];
    if (i < bare.length - 1 && spacers.has(i)) out += SPACER;
  }
  return out;
};

function tickerSection() {
  const host = $('#vr-ticker');
  host.textContent = '';
  const card = el('div', 'vr-card');

  const label = el('label', 'vr-label', 'Ticker (A-Z and 0-9, up to 26, case-folded and permanent)');
  const input = el('input', 'vr-in');
  input.value = 'DOGGOTOTHEMOON';
  input.maxLength = 26;
  input.setAttribute('aria-label', 'ticker');
  card.append(label, input);

  const spacerBox = el('div', '');
  spacerBox.style.marginTop = '16px';
  card.append(spacerBox);

  const out = el('div', '');
  out.style.marginTop = '16px';
  card.append(out);
  host.append(card);

  const draw = () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw !== input.value) input.value = raw;
    spacerBox.textContent = '';
    out.textContent = '';
    if (!raw) {
      out.append(el('div', 'vr-sub', 'Type a ticker to see what it costs.'));
      return;
    }
    // Drop any position the name no longer has, so shortening the ticker cannot leave a trailing
    // separator behind.
    spacers = new Set([...spacers].filter((i) => i <= raw.length - 2));

    // The spacer editor: one gap between each pair of characters, clickable.
    spacerBox.append(el('div', 'vr-label', 'Separators (click between two characters)'));
    const strip = el('div', 'vr-spacer-strip');
    for (let i = 0; i < raw.length; i++) {
      strip.append(el('span', 'vr-ch', raw[i]));
      if (i === raw.length - 1) break;
      const gap = el('button', `vr-gap${spacers.has(i) ? ' on' : ''}`, spacers.has(i) ? SPACER : '');
      gap.title = spacers.has(i) ? 'Remove this separator' : 'Add a separator here';
      gap.setAttribute('aria-label', `separator after character ${i + 1}`);
      gap.onclick = () => {
        // No two in a row: a doubled separator renders an empty segment and reads as a typo.
        if (spacers.has(i)) spacers.delete(i);
        else if (!spacers.has(i - 1) && !spacers.has(i + 1)) spacers.add(i);
        draw();
      };
      strip.append(gap);
    }
    spacerBox.append(strip);

    const shown = spacedName(raw);
    const price = priceOf(raw.length);
    const kv = (k, v) => {
      const r = el('div', 'vr-kv');
      r.append(el('span', '', k), el('span', '', v));
      out.append(r);
    };
    kv('Renders as', shown);
    kv('Its identity', raw);
    kv('Length that is priced', `${raw.length} characters, the bare name`);
    kv('Price', `${fmt(price)} XVG`);
    kv('Fifty of them', `${fmt(price * 50)} XVG`);

    const note = el('p', 'vr-sub');
    note.style.marginTop = '10px';
    if (raw.length <= 4) {
      note.textContent = 'Short and expensive on purpose. One project can afford this; an operator '
        + 'taking every good name of this length cannot.';
    } else if (raw.length >= 12) {
      note.textContent = 'Twelve or more is nearly free, so a descriptive honest name is never '
        + 'priced out. That is the other half of the mechanism.';
    } else {
      note.textContent = 'The middle of the curve: affordable for one, punishing in bulk.';
    }
    out.append(note);

    const spacerNote = el('p', 'vr-sub');
    spacerNote.style.marginTop = '10px';
    spacerNote.textContent = 'Separators are display only and cost nothing. ' + shown + ' and ' + raw
      + ' are the same asset, so nobody can squat a name by re-spacing it, and the length price '
      + 'keeps meaning what it says. Wallets show the spaced form and search the bare one.';
    out.append(spacerNote);

    const split = el('p', 'vr-sub');
    split.style.marginTop = '10px';
    split.textContent = 'Where this payment goes is fixed in the protocol and immutable once the '
      + 'first asset is etched. The split is still being agreed, so this preview does not state it.';
    out.append(split);
  };

  input.addEventListener('input', draw);
  draw();
}

// --- 03 etching ---------------------------------------------------------------------------------

function etchSection() {
  const host = $('#vr-etch');
  host.textContent = '';
  const card = el('div', 'vr-card');

  const grid = el('div', 'vr-grid2');
  const field = (label, value, permanent) => {
    const wrap = el('div', '');
    const l = el('label', 'vr-label', label);
    if (permanent) l.append(el('span', 'vr-perm', 'PERMANENT'));
    const i = el('input', 'vr-in');
    i.value = value;
    i.readOnly = true;
    wrap.append(l, i);
    grid.append(wrap);
    return i;
  };
  field('Name', 'Grumpy Token', false);
  field('Ticker', 'GRUMPY', true);
  field('Supply cap', '21,000,000.00', true);
  field('Divisibility', '2 decimals', true);
  field('Premine', '1,000,000.00 to you', true);
  field('Royalty', 'none', true);
  card.append(grid);

  const summary = el('div', '');
  summary.style.marginTop = '16px';
  const kv = (k, v) => {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', k), el('span', '', v));
    summary.append(r);
  };
  kv('This etching is', 'a fungible token (supply above 1)');
  kv('Ticker price', '2,500 XVG for six characters');
  kv('Inscription + fees', '~0.6 XVG');
  kv('Changeable later', 'the name only');
  card.append(summary);

  const foot = el('div', 'vr-row');
  foot.style.marginTop = '16px';
  const b = el('button', 'vr-btn', 'Etch permanently');
  b.disabled = true;
  foot.append(b, el('span', 'vr-tag sample', 'PREVIEW, NOT WIRED'));
  card.append(foot);

  host.append(card);
}

// --- 04 mint --------------------------------------------------------------------------------

function mintSection() {
  const host = $('#vr-mint');
  host.textContent = '';

  const open = el('div', 'vr-card');
  const row = el('div', 'vr-row');
  row.append(el('div', 'vr-ticker-badge', 'GRU'));
  const mid = el('div', 'vr-grow');
  mid.append(el('div', 'vr-name', 'Grumpy Token'));
  mid.append(el('div', 'vr-sub', '1,000.00 per mint · closes at height 9,400,000'));
  row.append(mid);
  row.append(el('span', 'vr-tag ok', 'ELIGIBLE'));
  open.append(row);

  const pct = Math.round((SAMPLE.asset.minted / SAMPLE.asset.supply) * 100);
  const bar = el('div', 'vr-bar');
  const fill = el('i');
  fill.style.width = `${pct}%`;
  bar.append(fill);
  open.append(bar);
  open.append(el('div', 'vr-sub', `${pct}% minted · ${fmt(14700)} of ${fmt(21000)} mints used`));

  const kv = (host2, k, v) => {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', k), el('span', '', v));
    host2.append(r);
  };
  const detail = el('div', '');
  detail.style.marginTop = '12px';
  kv(detail, 'Allowlist', 'yes, 4,096 entries');
  kv(detail, 'Your proof', 'found, max 5,000.00');
  kv(detail, 'You have minted', '0 times');
  open.append(detail);

  const act = el('div', 'vr-row');
  act.style.marginTop = '14px';
  const b = el('button', 'vr-btn', 'Mint 1,000.00 GRUMPY');
  b.disabled = true;
  act.append(b, el('span', 'vr-tag sample', 'PREVIEW, NOT WIRED'));
  open.append(act);
  host.append(open);

  // The refusal, shown next to it: this is the state that decides whether the screen is honest.
  const shut = el('div', 'vr-card');
  const r2 = el('div', 'vr-row');
  r2.append(el('div', 'vr-ticker-badge', 'XMP'));
  const m2 = el('div', 'vr-grow');
  m2.append(el('div', 'vr-name', 'Example Token'));
  m2.append(el('div', 'vr-sub', 'Allowlisted mint'));
  r2.append(m2);
  r2.append(el('span', 'vr-tag warn', 'NOT ON THE LIST'));
  shut.append(r2);
  shut.append(el('div', 'vr-sub',
    'None of your coins is in this allowlist, so a mint would be rejected by every indexer and you '
    + 'would still pay the fee. Checked before the button, not after the broadcast.'));
  host.append(shut);
}

// --- 05 holdings --------------------------------------------------------------------------------

function holdingsSection() {
  const host = $('#vr-holdings');
  host.textContent = '';

  const card = el('div', 'vr-card');
  card.append(el('div', 'vr-sub', 'ONE COIN, THREE THINGS ON IT'));

  const head = el('div', 'vr-row');
  head.style.marginTop = '10px';
  const m = el('div', 'vr-grow');
  m.append(el('div', 'vr-name', '0.42 XVG'));
  m.append(el('div', 'vr-sub', `${SAMPLE.outpoint.slice(0, 20)}…:1`));
  head.append(m);
  head.append(el('span', 'vr-tag warn', 'NEVER SPENT AS CHANGE'));
  card.append(head);

  const list = el('div', '');
  list.style.marginTop = '12px';
  for (const [name, amount] of [['GRUMPY', '1,250.00'], ['Verginal #118', '1 item']]) {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', name), el('span', '', amount));
    list.append(r);
  }
  card.append(list);
  card.append(el('div', 'vr-sub',
    'Spend this coin for a fee and everything on it goes with it. The protocol will not destroy the '
    + 'balance, it moves it to whoever you paid, which is a different kind of gone.'));
  host.append(card);
}

// --- 06 swap --------------------------------------------------------------------------------

function swapSection() {
  const host = $('#vr-swap');
  host.textContent = '';
  const card = el('div', 'vr-card');

  const row = el('div', 'vr-row');
  const mid = el('div', 'vr-grow');
  mid.append(el('div', 'vr-name', 'Sell this carrier for 5,000 XVG'));
  mid.append(el('div', 'vr-sub', 'One partially signed transaction. Atomic or nothing.'));
  row.append(mid);
  row.append(el('span', 'vr-tag warn', 'SELLS EVERYTHING BELOW'));
  card.append(row);

  const list = el('div', '');
  list.style.marginTop = '12px';
  for (const [k, v] of [['GRUMPY', '1,250.00'], ['Verginal #118', '1 item'], ['XVG on the coin', '0.42']]) {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', k), el('span', '', v));
    list.append(r);
  }
  card.append(list);

  card.append(el('div', 'vr-sub',
    'To sell part of a holding, split the carrier first, in a separate transaction. The listing then '
    + 'names only what you meant to sell.'));

  const act = el('div', 'vr-row');
  act.style.marginTop = '14px';
  const split = el('button', 'vr-btn ghost', 'Split first');
  const sell = el('button', 'vr-btn', 'List the whole carrier');
  split.disabled = true; sell.disabled = true;
  act.append(split, sell, el('span', 'vr-tag sample', 'PREVIEW, NOT WIRED'));
  card.append(act);
  host.append(card);
}

// --- 07 what is missing -------------------------------------------------------------------------

function outsSection() {
  const host = $('#vr-outs');
  host.textContent = '';
  const ul = el('ul', 'vr-outs');
  const item = (title, body) => {
    const li = el('li', '');
    li.append(el('b', '', title));
    li.append(document.createTextNode(` ${body}`));
    ul.append(li);
  };
  item('No price chart, no market cap, no "trending".',
    'None of it can be honest on day one, and a token page that opens with a fake-looking chart '
    + 'teaches people to read the whole screen as marketing.');
  item('No portfolio total in XVG or dollars.',
    'Adding up assets with no liquidity produces a number that is wrong in a way that feels precise. '
    + 'Balances are shown per asset until there is a real market to price them against.');
  item('No one-click "create token" wizard.',
    'An etching is permanent. The form shows every irreversible field before the button rather than '
    + 'hiding them behind a friendly flow.');
  item('No indexer picker in the interface.',
    'A dropdown asks the user to decide who to believe, which they cannot evaluate. The wallet '
    + 'compares roots across indexers itself and only speaks up when they disagree.');
  item('No royalty enforcement claimed as absolute.',
    'It binds everyone who follows the protocol, and a hostile fork of the indexer can ignore it. '
    + 'The spec says so plainly and so should any screen that shows a royalty.');
  host.append(ul);
}

// --- boot -----------------------------------------------------------------------------------

realStatus();
verifySection();
tickerSection();
etchSection();
mintSection();
holdingsSection();
swapSection();
outsSection();
