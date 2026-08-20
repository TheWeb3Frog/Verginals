// Buying runes: pick a standing order, name an amount, sign an offer.
//
// This page holds nothing and decides nothing. It shows the book, does the arithmetic out loud so a
// buyer can see it before committing, and hands the terms to the wallet. Every number below is
// re-derived inside the wallet before anything is signed, and the wallet proves what the seller's
// coins hold against the root published on chain rather than believing this page.

const $ = (id) => document.getElementById(id);

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

const COIN = 1_000_000;
const fmtXvg = (u) => (u / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtN = (n) => Number(n).toLocaleString();

let orders = [];
let chosen = null;

/** The order's floor for `amount`, rounded UP exactly as the wallet and the node do. */
function priceFor(order, amount) {
  const units = BigInt(order.minPrice.units) * BigInt(amount);
  const per = BigInt(order.minPrice.per);
  return Number((units + per - 1n) / per);
}

const eachOf = (order) => order.minPrice.units / order.minPrice.per;

async function load() {
  let res;
  try {
    res = await fetch('/api/runes/orders').then((r) => (r.ok ? r.json() : null));
  } catch { res = null; }

  if (!res) {
    $('status').textContent = 'The book is not open yet. Nothing has been listed for sale.';
    return;
  }
  orders = (res.orders || []).filter((o) => o.remaining > 0);
  if (!orders.length) {
    $('status').textContent = 'Nobody is selling right now. When somebody is, they show up here.';
    return;
  }
  $('status').hidden = true;
  $('orders').hidden = false;
  render();
}

function render() {
  const list = $('orderList');
  list.innerHTML = '';
  for (const row of orders) {
    const li = document.createElement('li');
    li.className = 'rb-row';

    const id = document.createElement('div');
    id.className = 'rb-id';
    const name = document.createElement('a');
    name.className = 'rb-name';
    name.href = '/runes/coin?rune=' + encodeURIComponent(row.order.runeRef);
    name.textContent = row.order.runeRef;
    const left = document.createElement('span');
    left.textContent = `${fmtN(row.remaining)} still on offer`;
    id.append(name, left);

    const ask = document.createElement('div');
    ask.className = 'rb-ask';
    const price = document.createElement('b');
    price.textContent = `${fmtXvg(eachOf(row.order))} XVG each`;
    const floor = document.createElement('span');
    floor.textContent = row.order.minFill ? `${fmtN(row.order.minFill)} minimum` : 'no minimum';
    ask.append(price, floor);

    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Buy';
    btn.addEventListener('click', () => choose(row));

    li.append(id, ask, btn);
    list.append(li);
  }
}

function choose(row) {
  chosen = row;
  $('buy').hidden = false;
  $('buyFor').textContent = `${row.order.runeRef}, ${fmtXvg(eachOf(row.order))} XVG each, `
    + `${fmtN(row.remaining)} on offer.`;
  $('amount').value = '';
  $('amount').focus();
  recalc();
  $('buy').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * The arithmetic, shown before anything is signed.
 *
 * A refusal here is a courtesy, not a defence: the wallet checks all of it again, and so does the
 * seller. Saying why the button is off is only so nobody has to guess.
 */
function recalc() {
  const note = $('buyNote');
  const btn = $('place');
  note.classList.remove('bad');
  const raw = $('amount').value.replace(/[^0-9]/g, '');
  $('amount').value = raw ? fmtN(Number(raw)) : '';
  const amount = Number(raw || 0);

  if (!amount) {
    $('tPay').textContent = $('tEach').textContent = $('tKeeps').textContent = '-';
    note.textContent = '';
    btn.disabled = true;
    return;
  }

  const pay = priceFor(chosen.order, amount);
  $('tPay').textContent = `${fmtXvg(pay)} XVG`;
  $('tEach').textContent = `${fmtXvg(pay / amount)} XVG`;
  $('tKeeps').textContent = fmtN(Math.max(0, chosen.remaining - amount));

  if (amount > chosen.remaining) {
    note.textContent = `Only ${fmtN(chosen.remaining)} of this order is still on offer.`;
    note.classList.add('bad');
    btn.disabled = true;
    return;
  }
  if (chosen.order.minFill && amount < chosen.order.minFill) {
    note.textContent = `This seller does not fill below ${fmtN(chosen.order.minFill)}.`;
    note.classList.add('bad');
    btn.disabled = true;
    return;
  }
  note.textContent = 'Your wallet will check the seller’s coins against the published root before it signs.';
  btn.disabled = false;
}

async function place() {
  const btn = $('place');
  const note = $('buyNote');
  const amount = Number($('amount').value.replace(/[^0-9]/g, ''));
  if (!amount || !chosen) return;

  // Same guard as the mint page, for the same reason: an older wallet has no placeRuneBid and would
  // throw a raw TypeError that reads as a broken site.
  if (!window.verge) {
    note.textContent = 'Install the Verginals wallet to place an offer.';
    note.classList.add('bad');
    return;
  }
  const tooOld = await needs('placeRuneBid');
  if (tooOld) { note.textContent = tooOld; note.classList.add('bad'); return; }

  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Check your wallet…';
  note.classList.remove('bad');
  note.textContent = '';
  try {
    await window.verge.connect();
    const r = await window.verge.placeRuneBid({
      order: chosen.order,
      amount,
      alreadySold: chosen.sold || 0,
    });
    note.textContent = `Offer placed: ${fmtN(r.gets)} for ${fmtXvg(r.pays)} XVG. `
      + 'It sits on the book until the seller takes it, or until you spend one of the coins behind it.';
    btn.textContent = was;
    await load();
  } catch (e) {
    note.textContent = (e && e.message) || 'That offer could not be placed.';
    note.classList.add('bad');
    btn.disabled = false;
    btn.textContent = was;
  }
}

$('amount').addEventListener('input', recalc);
$('place').addEventListener('click', place);
$('cancel').addEventListener('click', () => { $('buy').hidden = true; chosen = null; });
load();
