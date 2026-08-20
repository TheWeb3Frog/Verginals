// Minting: take a share of a coin whose creator left the door open.
//
// This page decides nothing. It shows what the indexer says is mintable, does the arithmetic out
// loud, and hands the terms to the wallet, which pays the price as a fee because that is what the
// protocol counts. Closed mints are listed too: somebody arriving after a window shut should read
// why rather than find an empty page and wonder if the site is broken.

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
      wrap.className = 'rb-mintwrap';
      const count = document.createElement('input');
      count.type = 'text';
      count.inputMode = 'numeric';
      count.value = '1';
      count.className = 'rb-count';
      count.setAttribute('aria-label', 'how many times');
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      const paint = () => {
        const n = Math.max(1, Math.min(20, parseInt(count.value.replace(/[^0-9]/g, ''), 10) || 1));
        btn.textContent = n === 1 ? 'Mint' : `Mint ${n}x`;
        btn.title = `${fmtN(whole(m.amount * n, m.divisibility))} coins for ${fmtXvg(m.priceUnits * n)} XVG`;
      };
      count.addEventListener('input', paint);
      paint();
      btn.addEventListener('click', () => {
        const n = Math.max(1, Math.min(20, parseInt(count.value.replace(/[^0-9]/g, ''), 10) || 1));
        mint(m, btn, n);
      });
      wrap.append(count, btn);
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
 * Is the wallet able to do this at all, and if not, say which wallet it is.
 *
 * A page that calls a method an older wallet does not have throws a raw TypeError at the user:
 * "window.verge.mintRune is not a function". That is a true sentence and a useless one. It names no
 * remedy and it looks like the site is broken rather than the extension being behind.
 */
async function needs(method) {
  if (!window.verge) return 'Install the Verginals wallet to do this.';
  if (typeof window.verge[method] === 'function') return null;
  let v = '';
  try { const r = await window.verge.walletVersion(); if (r && r.version) v = ' You have ' + r.version + '.'; }
  catch (_) { v = ''; }
  return 'Your Verginals wallet is too old for this: update it, then reload this page.' + v;
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
