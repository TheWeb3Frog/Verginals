// One coin, on its own page.
//
// Everything here comes from the state the indexer decides with, so nothing on screen is a number
// this server cannot stand behind. Two of them are easy to misread and carry their caveat in the
// page rather than in a footnote nobody reaches: the holder count counts coins and not people, and
// the mint progress is measured against what CAN be minted rather than the whole supply.

import { mountChrome } from '/vgnav.js?v=39';

mountChrome({ active: 'coins', where: [{ text: 'Coins', href: '/runes/market' }, { text: 'Market', href: '/runes/market' }, { text: 'Coin' }],
  right: 'one coin, and where it trades' });

import { mountTrade } from '/runes-trade.js';

const $ = (id) => document.getElementById(id);
const COIN = 1_000_000;
const fmtXvg = (u) => (u / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtN = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 });

function fact(host, k, v, cls) {
  const row = document.createElement('div');
  const dt = document.createElement('dt'); dt.textContent = k;
  const dd = document.createElement('dd'); dd.textContent = v;
  if (cls) dd.className = cls;
  row.append(dt, dd);
  host.append(row);
}

const ref = new URLSearchParams(location.search).get('rune');

async function load() {
  if (!ref) { $('status').textContent = 'No coin named in the address.'; return; }
  let c;
  try {
    const r = await fetch('/api/runes/coin?rune=' + encodeURIComponent(ref));
    if (r.status === 404) { $('status').textContent = 'No coin of that name has been etched.'; return; }
    c = await r.json();
  } catch { $('status').textContent = 'Could not reach the index.'; return; }
  if (!c || !c.runeRef) { $('status').textContent = 'That coin could not be read.'; return; }

  document.title = (c.display || c.ticker) + ' on Verge';
  $('status').hidden = true;
  $('coin').hidden = false;

  // The picture, if one has been set. It replaces the letter mark rather than sitting beside it:
  // a coin has one identity, not two.
  if (c.image) {
    const img = document.createElement('img');
    img.src = c.image;
    img.alt = '';
    img.className = 'rc-pic';
    $('rc-symbol').textContent = '';
    $('rc-symbol').append(img);
  } else {
    $('rc-symbol').textContent = c.symbol || (c.ticker || '?').slice(0, 1);
  }
  $('rc-name').textContent = c.display || c.ticker;
  $('rc-ref').textContent = c.runeRef;
  $('rc-block').textContent = Number(c.etchedAtHeight).toLocaleString();

  // --- supply
  const w = c.inWholeCoins;
  fact($('rc-supply'), 'Total supply', fmtN(w.supply));
  fact($('rc-supply'), 'Kept by the creator', w.premine > 0 ? fmtN(w.premine) : 'none');
  fact($('rc-supply'), 'Minted so far', fmtN(w.minted));
  fact($('rc-supply'), 'In circulation', fmtN(w.circulating));
  const pct = (c.mintedShare || 0) * 100;
  $('rc-fill').style.width = Math.min(100, pct).toFixed(2) + '%';
  $('rc-progress').textContent = c.openSupply === 0
    ? 'Nothing was left open to mint: the creator kept all of it.'
    : `${pct.toFixed(pct < 1 ? 2 : 1)}% of what can be minted has been`;

  // --- minting
  const m = c.mint;
  if (!m) {
    fact($('rc-mint'), 'Open mint', 'no, this coin has fixed terms');
  } else {
    fact($('rc-mint'), 'Status', m.open ? 'open to anyone' : (m.closedBecause || []).join(', ') || 'closed',
      m.open ? 'warn' : null);
    fact($('rc-mint'), 'Per mint', fmtN(m.amount / (10 ** c.divisibility)));
    fact($('rc-mint'), 'Network fee per claim', m.priceUnits ? fmtXvg(m.priceUnits) + ' XVG' : 'free');
    // The line that stops somebody hunting for a rug that cannot exist.
    fact($('rc-mint'), 'Goes to', 'the miner of the block, not the creator, not this site');
    fact($('rc-mint'), 'Mints taken', fmtN(m.mintCount));
    if (m.remaining != null) fact($('rc-mint'), 'Mints left', fmtN(m.remaining));
    if (m.allowlisted) fact($('rc-mint'), 'Allowlist', 'yes, an entitlement is needed');
  }

  // --- distribution
  const d = c.distribution;
  fact($('rc-dist'), 'Coins holding it', fmtN(d.carriers));
  fact($('rc-dist'), 'In circulation', fmtN(d.circulating / (10 ** c.divisibility)));
  if (d.carriers > 0) {
    fact($('rc-dist'), 'Largest single coin', fmtN(d.largest / (10 ** c.divisibility)));
    fact($('rc-dist'), 'Top ten hold', (d.topTenShare * 100).toFixed(1) + '%');
  }

  // --- the name deposit
  if (!c.nameDeposit) {
    $('rc-deposit-card').hidden = true;
  } else {
    const nd = c.nameDeposit;
    fact($('rc-deposit'), 'Locked for the name', fmtXvg(nd.lockedUnits) + ' XVG');
    fact($('rc-deposit'), 'Comes back on', new Date(nd.opensAt * 1000)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }));
    fact($('rc-deposit'), 'Paid to anybody', 'no');
    fact($('rc-deposit'), 'Burned', 'no');
  }

  // --- what you can do about it
  const acts = $('rc-actions');
  if (m && m.open && !m.allowlisted) {
    const a = document.createElement('a');
    a.className = 'vg-btn primary'; a.href = '/runes/mint'; a.textContent = 'Mint';
    acts.append(a);
  }
  const b = document.createElement('a');
  b.className = 'vg-btn'; b.href = '/runes/market'; b.textContent = 'All coins';
  acts.append(b);

  // Trading goes below the identity and above the detail, because it is what somebody arriving here
  // from the market came to do.
  mountTrade($('rc-trade'), c);

  mountImageUpload(c);
}

/**
 * Offer the etcher a picture for their coin.
 *
 * Shown only to the wallet that etched it, and only once that wallet is connected. Everybody else
 * never sees the control: the server refuses them anyway, but a button that exists to be refused is
 * a button that wastes somebody's time and makes the site look like it is guessing.
 *
 * The picture is held by this server, not on the chain. The panel says so, because a coin's supply
 * and a coin's logo having different permanence is exactly the sort of thing a page should not let
 * somebody assume.
 */
function mountImageUpload(c) {
  const host = $('rc-image');
  if (!host || !c.etcher) return;

  const draw = (address) => {
    host.textContent = '';
    if (address !== c.etcher) { host.hidden = true; return; }
    host.hidden = false;

    const label = document.createElement('label');
    label.className = 'vg-btn rc-pick';
    label.textContent = c.image ? 'Change the picture' : 'Add a picture';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.hidden = true;
    label.append(input);

    const say = document.createElement('span');
    say.className = 'rc-image-say';
    say.textContent = `PNG, JPEG, WEBP or GIF, up to ${Math.round((c.imageMaxBytes || 102400) / 1024)} KB.`;

    host.append(label, say);

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      say.textContent = 'Reading...';
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const dataBase64 = btoa(bin);

        say.textContent = 'Waiting for your wallet to sign...';
        const ch = await fetch('/api/runes/image/challenge', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address }),
        }).then((r) => r.json());
        if (ch.error) throw new Error(ch.error);

        const signature = await window.VerginalsArena.signMessage(ch.challenge);

        say.textContent = 'Saving...';
        const r = await fetch('/api/runes/image', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runeRef: c.runeRef, address, nonce: ch.nonce, signature, dataBase64 }),
        }).then((x) => x.json());
        if (r.error) throw new Error(r.error);

        // Cache-busted, or the browser shows the picture that was just replaced.
        const img = document.createElement('img');
        img.src = r.url + '?t=' + Date.now();
        img.alt = '';
        img.className = 'rc-pic';
        $('rc-symbol').textContent = '';
        $('rc-symbol').append(img);
        say.textContent = 'Saved.';
        label.textContent = 'Change the picture';
        label.append(input);
      } catch (e) {
        say.textContent = e.message || 'that did not work';
        say.classList.add('rc-image-bad');
      }
    });
  };

  const w = window.VerginalsArena;
  if (!w) return;
  draw(w.address());
  // The bar's connect button announces itself, so the control appears the moment the right wallet
  // arrives rather than only on a reload.
  document.addEventListener('vg:wallet', (e) => draw(e.detail && e.detail.address));
}

load();
