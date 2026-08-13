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
// The mint figures are derived, not typed in, because typed-in ones drift: an earlier version had a
// cap of 21,000 mints beside a premine of 1,000,000, which together exceed the supply, so the mint
// would in fact have closed early. premine + perMint * mintCap must equal supply, exactly.
const SAMPLE = {
  asset: {
    ticker: 'GRUMPY', name: 'Grumpy Token', divisibility: 2,
    supply: 2100000000,   // 21,000,000.00
    premine: 100000000,   //  1,000,000.00
    perMint: 100000,      //      1,000.00
    mintCap: 20000,       // 1,000,000 + 20,000 x 1,000 = 21,000,000
    mintsUsed: 14000,
  },
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

/**
 * The field holds the DISPLAY form and you type a space to get a separator.
 *
 * The first version of this made you click into the gaps between letters, which nobody would guess
 * and which is miserable on a phone. Typing is what people do, and a space is what they already
 * reach for. The identity is derived from what is typed rather than edited separately, so there is
 * one thing on screen and no way for the two to disagree.
 */
const bareOf = (shown) => shown.split(SPACER).join('');

// The protocol's limit, and it counts CHARACTERS, not what is on screen. A separator is not a
// character, so the DOM's own maxLength is the wrong tool: it would count the bullets and cut a
// spaced name short.
const MAX_TICKER = 26;
const LOCK_DAYS = 1460;

/** The date a price paid today comes back, which is the only form the wait is legible in. */
const releaseDate = () => new Date(Date.now() + LOCK_DAYS * 86400 * 1000)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Clean up as the user types, without ever fighting the cursor more than one character. */
function normalizeTyped(raw) {
  let out = '';
  let letters = 0;
  for (const ch of raw.toUpperCase()) {
    const isSep = ch === ' ' || ch === SPACER || ch === '-' || ch === '.';
    if (isSep) {
      // A separator sits between two characters, so a leading one has nothing to sit after, and two
      // in the same gap cannot be expressed at all. Both are simply not inserted.
      if (out.length && !out.endsWith(SPACER)) out += SPACER;
      continue;
    }
    if (!/[A-Z0-9]/.test(ch)) continue;
    // Refuse the 27th character rather than accepting it and complaining afterwards. Separators
    // stay available at the cap, since they cost nothing and change no length.
    if (letters >= MAX_TICKER) continue;
    out += ch;
    letters += 1;
  }
  return out;
}

function tickerSection() {
  const host = $('#vr-ticker');
  host.textContent = '';
  const card = el('div', 'vr-card');

  const label = el('label', 'vr-label', 'Ticker (A-Z and 0-9, up to 26, case-folded and permanent)');
  const input = el('input', 'vr-in big');
  input.value = 'DOG' + SPACER + 'GO' + SPACER + 'TO' + SPACER + 'THE' + SPACER + 'MOON';
  input.setAttribute('aria-label', 'ticker');
  input.setAttribute('aria-describedby', 'vr-ticker-hint');
  card.append(label, input);

  const hint = el('div', 'vr-hint');
  hint.id = 'vr-ticker-hint';
  card.append(hint);

  const out = el('div', '');
  out.style.marginTop = '16px';
  card.append(out);
  host.append(card);

  const draw = () => {
    // Keep the caret where the user left it: normalising can only ever remove characters before it,
    // so counting how many were dropped is enough to put it back.
    const caret = input.selectionStart;
    const before = input.value;
    const shown = normalizeTyped(before);
    if (shown !== before) {
      input.value = shown;
      const dropped = before.length - shown.length;
      const at = Math.max(0, caret - dropped);
      input.setSelectionRange(at, at);
    }

    const bare = bareOf(shown);

    // The counter is always visible rather than appearing on error, so the limit is something the
    // user can see coming instead of something that stops them mid-word.
    hint.textContent = '';
    const count = el('span', `vr-count${bare.length >= MAX_TICKER ? ' full' : ''}`,
      `${bare.length}/${MAX_TICKER}`);
    hint.append(count);
    hint.append(document.createTextNode(bare.length >= MAX_TICKER
      ? ' characters. That is the limit, though you can still add separators: they are not characters.'
      : ' characters. Press space for a separator, which is display only and costs nothing.'));

    out.textContent = '';
    if (!bare) {
      out.append(el('div', 'vr-sub', 'Type a ticker to see what it costs.'));
      return;
    }

    const price = priceOf(bare.length);
    const kv = (k, v) => {
      const r = el('div', 'vr-kv');
      r.append(el('span', '', k), el('span', '', v));
      out.append(r);
    };
    // Trailing separators are dropped here for the same reason the protocol ignores them: a
    // half-typed name should not read as a different name.
    kv('Renders as', shown.replace(new RegExp(`${SPACER}+$`), ''));
    kv('Its identity', bare);
    kv('Length that is priced', `${bare.length} characters, separators not counted`);
    kv('Locked', `${fmt(price)} XVG, for 1460 days`);
    kv('Yours again on', releaseDate());
    kv('Fifty of them', `${fmt(price * 50)} XVG locked at once`);

    const note = el('p', 'vr-sub');
    note.style.marginTop = '10px';
    if (bare.length <= 4) {
      note.textContent = 'Short and expensive on purpose. One project can afford this; an operator '
        + 'taking every good name of this length cannot.';
    } else if (bare.length >= 12) {
      note.textContent = 'Twelve or more is nearly free, so a descriptive honest name is never '
        + 'priced out. That is the other half of the mechanism.';
    } else {
      note.textContent = 'The middle of the curve: affordable for one, punishing in bulk.';
    }
    out.append(note);

    const spacerNote = el('p', 'vr-sub');
    spacerNote.style.marginTop = '10px';
    spacerNote.textContent = `A separator is not a character. ${shown} and ${bare} are the same `
      + 'asset, priced on the same length, so nobody can squat a name by re-spacing it. This is how '
      + 'Bitcoin Runes does it too: the bullets live in a separate field and never touch the name.';
    out.append(spacerNote);

    const lock = el('p', 'vr-sub');
    lock.style.marginTop = '10px';
    lock.textContent = 'Nothing is burned and nobody is paid. The price goes into an output only you '
      + 'can spend, and only once the four years are up. That is what makes fifty registrations '
      + 'ruinous without putting a single address into the protocol.';
    out.append(lock);

    const cost = el('p', 'vr-sub');
    cost.style.marginTop = '10px';
    cost.textContent = 'Waiting is not free, and that is the point: four years of it costs you '
      + 'somewhere between a third and two thirds of the amount, depending on what you would '
      + 'otherwise have done with the coins. Getting them back needs the release tool, because '
      + 'Verge Core cannot sign the script that holds them. The procedure is inscribed on chain, '
      + 'beside the asset, so it does not depend on this site still being here in four years.';
    out.append(cost);
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
  card.append(grid);

  const summary = el('div', '');
  summary.style.marginTop = '16px';
  const kv = (k, v) => {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', k), el('span', '', v));
    summary.append(r);
  };
  kv('This etching is', 'a fungible token (supply above 1)');
  kv('Ticker price', '2,500 XVG for six characters, locked not spent');
  kv('That price returns', releaseDate());
  kv('Inscription + fees', '~0.6 XVG, these are spent');
  kv('Changeable later', 'nothing, by anyone, ever');
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
  const a = SAMPLE.asset;
  mid.append(el('div', 'vr-sub',
    `${display(a.perMint, a.divisibility)} per mint · closes at height 9,400,000`));
  row.append(mid);
  row.append(el('span', 'vr-tag ok', 'ELIGIBLE'));
  open.append(row);

  // The bar tracks the supply that EXISTS, so it counts the premine. The mint counter tracks the
  // open mint alone. They are different fractions and saying so beats leaving them to be misread.
  const issued = a.premine + a.perMint * a.mintsUsed;
  const pct = Math.round((issued / a.supply) * 100);
  const bar = el('div', 'vr-bar');
  const fill = el('i');
  fill.style.width = `${pct}%`;
  bar.append(fill);
  open.append(bar);
  open.append(el('div', 'vr-sub',
    `${pct}% of the supply issued, premine included · ${fmt(a.mintsUsed)} of ${fmt(a.mintCap)} mints used`));

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

  // The ticker price has to appear somewhere the owner will look, or paying it feels like losing it.
  const locked = el('div', 'vr-card');
  locked.style.marginTop = '12px';
  locked.append(el('div', 'vr-sub', 'AND ONE COIN YOU CANNOT TOUCH YET'));

  const lockHead = el('div', 'vr-row');
  lockHead.style.marginTop = '10px';
  const lm = el('div', 'vr-grow');
  lm.append(el('div', 'vr-name', '2,500.00 XVG'));
  lm.append(el('div', 'vr-sub', 'the ticker price for GRUMPY'));
  lockHead.append(lm);
  lockHead.append(el('span', 'vr-tag warn', 'LOCKED'));
  locked.append(lockHead);

  const lockRows = el('div', '');
  lockRows.style.marginTop = '12px';
  for (const [k, v] of [['Unlocks on', releaseDate()], ['Goes to', 'you, and nobody else, ever']]) {
    const r = el('div', 'vr-kv');
    r.append(el('span', '', k), el('span', '', v));
    lockRows.append(r);
  }
  locked.append(lockRows);
  locked.append(el('div', 'vr-sub',
    'Not a fee and not a burn: it is still your money, it is simply unreachable until the date. '
    + 'Showing it as a balance with a date is the whole difference between a protocol that charges '
    + 'you and one that asks you to wait.'));
  host.append(locked);
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
  item('No payout address, anywhere in the protocol.',
    'The ticker price is locked and comes back to whoever paid it, so there is no treasury, no split '
    + 'to negotiate, and no line in the spec that has to name somebody. It also means the etch fee '
    + 'cannot quietly become a revenue stream later: there is no field it could be paid into.');
  item('No royalties, and no owner of any kind.',
    'The indexer could enforce a royalty, which is more than Ethereum manages, and an earlier draft '
    + 'did. Taking a percentage needs a sale price, and a UTXO chain cannot tell a payment from '
    + 'change, so the price had to come from outside the chain and two indexers could disagree on it '
    + 'without either being wrong. Nothing here may rest on a number that is not in a block.');
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
