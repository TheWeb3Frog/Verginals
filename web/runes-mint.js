// Minting: take a share of a coin whose creator left the door open.
//
// This page decides nothing. It shows what the indexer says is mintable, does the arithmetic out
// loud, and hands the terms to the wallet, which pays the price as a fee because that is what the
// protocol counts. Closed mints are listed too: somebody arriving after a window shut should read
// why rather than find an empty page and wonder if the site is broken.

import { mountChrome } from '/vgnav.js';

mountChrome({ active: 'coins', where: [{ text: 'Coins', href: '/runes/market' }, { text: 'Mint' }],
  right: 'the price is the network fee, and it goes to the miner' });

const $ = (id) => document.getElementById(id);
const COIN = 1_000_000;
const fmtXvg = (u) => (u / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtN = (n) => Number(n).toLocaleString();

const whole = (units, div) => (Number(units) / (10 ** Number(div || 0)));

async function load() {
  let res;
  try {
    res = await fetch('/api/runes/mintable').then((r) => (r.ok ? r.json() : null));
  } catch { res = null; }

  if (!res) {
    $('status').textContent = 'Minting is not open on this server yet.';
    return;
  }
  const all = res.mintable || [];
  if (!all.length) {
    $('status').textContent = 'No coin has been made with an open mint yet. When one is, it shows up here.';
    return;
  }
  $('status').hidden = true;

  const open = all.filter((m) => m.open);
  const shut = all.filter((m) => !m.open);
  if (open.length) { $('list').hidden = false; render($('mintList'), open, true); }
  if (shut.length) { $('closed').hidden = false; render($('closedList'), shut, false); }
  if (!open.length) $('list').hidden = true;
}

function render(ul, rows, canMint) {
  ul.innerHTML = '';
  for (const m of rows) {
    const li = document.createElement('li');
    li.className = 'rb-row';

    const id = document.createElement('div');
    id.className = 'rb-id';
    // The name is the way in. Somebody who wants to know what a coin IS before spending on it
    // should not have to guess that the row is clickable.
    const name = document.createElement('a');
    name.className = 'rb-name';
    name.href = '/runes/coin?rune=' + encodeURIComponent(m.runeRef);
    name.textContent = (m.symbol ? m.symbol + ' ' : '') + (m.display || m.ticker);
    const sub = document.createElement('span');
    // What one mint gives you, and how many are left. Two numbers, because the second is the one
    // that makes somebody act and the first is the one that makes it worth acting on.
    sub.textContent = `${fmtN(whole(m.amount, m.divisibility))} per mint`
      + (m.remaining == null ? '' : ` · ${fmtN(m.remaining)} left`)
      + (m.allowlisted ? ' · allowlist only' : '');
    id.append(name, sub);

    // How far along the coin is. Counted against what CAN be minted, which is the supply less the
    // premine: showing it against the whole supply would report a coin as half done when its
    // creator kept half of it, and that is a different fact.
    const openSupply = Math.max(0, m.supply - m.premine);
    const pct = openSupply > 0 ? Math.min(100, (m.minted / openSupply) * 100) : 0;
    const bar = document.createElement('div');
    bar.className = 'rb-bar';
    const fill = document.createElement('span');
    fill.style.width = pct.toFixed(2) + '%';
    bar.append(fill);
    const pctText = document.createElement('span');
    pctText.className = 'rb-pct';
    pctText.textContent = pct < 0.01 && m.minted === 0
      ? 'none minted yet'
      : `${pct.toFixed(pct < 1 ? 2 : 1)}% minted · ${fmtN(m.mintCount)} time(s)`;
    id.append(bar, pctText);

    const ask = document.createElement('div');
    ask.className = 'rb-ask';
    const price = document.createElement('b');
    price.textContent = m.priceUnits ? `${fmtXvg(m.priceUnits)} XVG` : 'free';
    const note = document.createElement('span');
    note.textContent = m.priceUnits ? 'paid as the fee' : 'you pay only the network fee';
    ask.append(price, note);

    if (canMint && !m.allowlisted) {
      // One mint is one transaction, always, because the indexer reads a single message per
      // transaction. Asking for ten means ten of them, chained, so the box is a count and the
      // button says what it will cost before it is pressed.
      const wrap = document.createElement('div');
      wrap.className = 'rm-act';

      // A stepper rather than a bare number box. The figure is a count of TRANSACTIONS, not an
      // amount, so it is small, bounded and adjusted rather than typed, and the two ends of the
      // range are one press away instead of a selection and a retype.
      const step = document.createElement('div');
      step.className = 'rm-step';
      const less = document.createElement('button');
      less.type = 'button'; less.className = 'rm-stepbtn'; less.textContent = '\u2212';
      less.setAttribute('aria-label', 'one fewer');
      const count = document.createElement('input');
      count.type = 'text';
      count.inputMode = 'numeric';
      count.value = '1';
      count.className = 'rm-count';
      count.setAttribute('aria-label', 'how many times');
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'rm-stepbtn'; more.textContent = '+';
      more.setAttribute('aria-label', 'one more');
      step.append(less, count, more);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vg-btn primary rm-mint';

      // Twenty is the ceiling because these are chained transactions and the mempool refuses a
      // longer chain of unconfirmed ancestors. It is also bounded by what is left to claim.
      const ceiling = Math.max(1, Math.min(20, m.remaining == null ? 20 : m.remaining));
      const read = () => {
        const n = parseInt(String(count.value).replace(/[^0-9]/g, ''), 10) || 1;
        return Math.max(1, Math.min(ceiling, n));
      };
      const paint = () => {
        const n = read();
        count.value = String(n);
        less.disabled = n <= 1;
        more.disabled = n >= ceiling;
        // The cost goes ON the button. It is the number that decides the press, and it was in a
        // tooltip nobody on a touch screen can ever open.
        const label = document.createElement('span');
        label.textContent = n === 1 ? 'Mint' : `Mint ${n}\u00d7`;
        btn.textContent = '';
        btn.append(label);
        if (m.priceUnits) {
          const cost = document.createElement('em');
          cost.className = 'rm-cost';
          cost.textContent = fmtXvg(m.priceUnits * n) + ' XVG';
          btn.append(cost);
        }
        btn.title = `${fmtN(whole(m.amount * n, m.divisibility))} coins`;
      };
      const nudge = (by) => { count.value = String(read() + by); paint(); };
      less.addEventListener('click', () => nudge(-1));
      more.addEventListener('click', () => nudge(1));
      count.addEventListener('input', () => {
        less.disabled = false; more.disabled = false;   // never trap a half-typed value
        const n = parseInt(String(count.value).replace(/[^0-9]/g, ''), 10);
        if (Number.isInteger(n)) paint();
      });
      count.addEventListener('blur', paint);
      paint();

      btn.addEventListener('click', () => mint(m, btn, read()));
      wrap.append(step, btn);
      li.append(id, ask, wrap);
    } else {
      const why = document.createElement('div');
      why.className = 'rb-ask';
      const b = document.createElement('b');
      b.textContent = m.allowlisted && canMint ? 'allowlist' : 'closed';
      const s = document.createElement('span');
      s.textContent = m.allowlisted && canMint
        ? 'needs an entitlement this page cannot prove'
        : (m.closedBecause || []).join(', ');
      why.append(b, s);
      li.append(id, ask, why);
    }
    ul.append(li);
  }
}

/**
 * Is this wallet able to do this, and if not, say exactly what to do.
 *
 * Method presence is NOT enough and that was learned the hard way. mintRune existed in 0.19 and
 * could not build an OP_RETURN until 0.23, because the fault was one level down in the transaction
 * builder. A page that only asked "does the method exist" waved that through and let a raw
 * TypeError reach somebody who had done nothing wrong.
 *
 * So each action names the build it needs. Presence still gets checked first, because a wallet old
 * enough to lack the method cannot answer walletVersion either.
 */
const NEEDS = {
  mintRune: '0.23.0',      // the OP_RETURN fix in buildAndSignP2PKH
  sendRune: '0.23.0',      // same fault, same fix
  placeRuneBid: '0.14.0',
  fundEtch: '0.21.0',
  runesSignRelease: '0.22.0',
};

function olderThan(have, want) {
  const a = String(have || '0').split('.').map(Number);
  const b = String(want).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return true;
    if ((a[i] || 0) > (b[i] || 0)) return false;
  }
  return false;
}

async function needs(method) {
  if (!window.verge) return 'Install the Verginals wallet to do this.';
  if (typeof window.verge[method] !== 'function') {
    return 'Your Verginals wallet is too old for this: update it, then reload this page.';
  }
  const want = NEEDS[method];
  if (!want) return null;
  let have = null;
  try { const r = await window.verge.walletVersion(); have = r && r.version; } catch (_) { have = null; }
  if (!have) return `This needs Verginals wallet ${want} or newer, and this wallet is too old to say which build it is.`;
  if (olderThan(have, want)) {
    return `This needs Verginals wallet ${want} or newer. You have ${have}.`;
  }
  return null;
}

async function mint(m, btn, times) {
  const missing = await needs('mintRune');
  if (missing) { alert(missing); return; }
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Check your wallet...';
  try {
    await window.verge.connect();
    const r = await window.verge.mintRune({ runeRef: m.runeRef, priceUnits: m.priceUnits, times });
    // Say how many actually went out. A chain can stop part way, and somebody told only "done"
    // would not know they hold nine of the ten they paid for.
    btn.textContent = r && r.minted > 1 ? `Minted ${r.minted}x` : 'Minted';
    if (r && r.stoppedBecause) {
      alert(`${r.minted} of ${r.asked} mints went out. The rest stopped: ${r.stoppedBecause}`);
    }
    // Reload rather than decrement a number on screen: the count that matters is the one the
    // indexer holds, and somebody else may have taken one while this was being signed.
    setTimeout(load, 1200);
    console.log('mint broadcast', r && r.txid);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = was;
    alert((e && e.message) || 'That mint could not be sent.');
  }
}

load();
