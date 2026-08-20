// Buying runes: pick a standing order, name an amount, sign an offer.
//
// This page holds nothing and decides nothing. It shows the book, does the arithmetic out loud so a
// buyer can see it before committing, and hands the terms to the wallet. Every number below is
// re-derived inside the wallet before anything is signed, and the wallet proves what the seller's
// coins hold against the root published on chain rather than believing this page.

const $ = (id) => document.getElementById(id);
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
    const name = document.createElement('b');
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

  if (!window.verge) {
    note.textContent = 'Install the Verginals wallet to place an offer.';
    note.classList.add('bad');
    return;
  }

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
