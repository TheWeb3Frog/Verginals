// Buying and selling one coin, on that coin's own page.
//
// It lives here rather than on a market-wide screen because a trade is always about one coin, and
// the numbers that decide it are the ones already on this page. Two panels, one card: what is on
// offer, and what you can offer.
//
// The wallet re-derives every figure below before it signs, and proves the other side's coins
// against the root published on chain. Nothing here is trusted by anything. It is arithmetic shown
// out loud so nobody has to sign a number they have not read.

const COIN = 1_000_000;

const fmtXvg = (u) => (u / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtN = (n, max = 8) => Number(n).toLocaleString(undefined, { maximumFractionDigits: max });

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Which build of the wallet each action needs.
 *
 * A method existing is not the same as a method working, and that was learned the expensive way:
 * mintRune was on the provider from 0.19 and could not build an OP_RETURN until 0.23, so a page
 * that only asked "is the method there" let a raw TypeError reach somebody who had done nothing
 * wrong. Every action names the build that made it work.
 */
const NEEDS = { placeRuneBid: '0.14.0', publishRuneOrder: '0.27.0', withdrawRuneOrder: '0.27.0' };

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
  return olderThan(have, want) ? `This needs Verginals wallet ${want} or newer. You have ${have}.` : null;
}

/**
 * A price, from the number a person typed to the ratio the protocol fills against.
 *
 * The order carries XVG atomic units per ATOMIC rune unit, and somebody selling a coin with six
 * decimals for a thousandth of an XVG would need a third of a unit there. So it stays a RATIO:
 * numerator in XVG atomic units per whole coin, denominator 10^divisibility. Both whole numbers,
 * no rounding, and priceFor multiplies before it divides so nothing is lost on the way.
 */
function priceRatio(xvgPerCoin, divisibility) {
  return { units: Math.round(Number(xvgPerCoin) * COIN), per: Math.pow(10, Number(divisibility) || 0) };
}

/** What one whole coin costs under this order, in XVG atomic units. The inverse of priceRatio. */
function perCoin(minPrice, divisibility) {
  return (Number(minPrice.units) / Number(minPrice.per)) * Math.pow(10, Number(divisibility) || 0);
}

/** The order's floor for `amount` atomic units, rounded UP exactly as the wallet and the node do. */
function priceFor(order, amount) {
  const units = BigInt(order.minPrice.units) * BigInt(amount);
  const per = BigInt(order.minPrice.per);
  return Number((units + per - 1n) / per);
}

export function mountTrade(host, coin) {
  const div = Number(coin.divisibility || 0);
  const scale = Math.pow(10, div);
  const whole = (units) => Number(units) / scale;
  const atomic = (typed) => Math.round(Number(typed) * scale);

  let orders = [];
  let address = null;
  let holdings = null;   // atomic units of THIS coin, once a wallet is connected

  const card = el('section', 'rt-card');
  const tabs = el('div', 'rt-tabs');
  const tabBuy = el('button', 'rt-tab is-on', 'Buy');
  const tabSell = el('button', 'rt-tab', 'Sell');
  tabBuy.type = tabSell.type = 'button';
  tabs.append(tabBuy, tabSell);

  const buyPane = el('div', 'rt-pane');
  const sellPane = el('div', 'rt-pane');
  sellPane.hidden = true;
  card.append(tabs, buyPane, sellPane);
  host.append(card);

  const show = (which) => {
    tabBuy.classList.toggle('is-on', which === 'buy');
    tabSell.classList.toggle('is-on', which === 'sell');
    buyPane.hidden = which !== 'buy';
    sellPane.hidden = which !== 'sell';
  };
  tabBuy.addEventListener('click', () => show('buy'));
  tabSell.addEventListener('click', () => { show('sell'); paintSell(); });

  // --- the book -------------------------------------------------------------------------------

  async function loadOrders() {
    try {
      const r = await fetch('/api/runes/orders?rune=' + encodeURIComponent(coin.runeRef));
      const j = r.ok ? await r.json() : null;
      orders = ((j && j.orders) || []).filter((o) => o.remaining > 0)
        .sort((a, b) => perCoin(a.order.minPrice, div) - perCoin(b.order.minPrice, div));
    } catch { orders = []; }
  }

  function paintBuy() {
    buyPane.textContent = '';
    if (!orders.length) {
      const empty = el('div', 'rt-empty');
      empty.append(el('p', '', 'Nobody is selling this coin yet.'));
      const hint = el('p', 'rt-quiet', 'If you hold some, you can be the first: ');
      const link = el('button', 'rt-link', 'list it for sale');
      link.type = 'button';
      link.addEventListener('click', () => { show('sell'); paintSell(); });
      hint.append(link, document.createTextNode('.'));
      empty.append(hint);
      buyPane.append(empty);
      return;
    }

    const list = el('ul', 'rt-asks');
    for (const row of orders) {
      const li = el('li', 'rt-ask');
      const left = el('div', 'rt-ask-id');
      left.append(el('b', '', fmtXvg(perCoin(row.order.minPrice, div)) + ' XVG each'));
      left.append(el('span', '', fmtN(whole(row.remaining), div) + ' available'
        + (row.order.minFill ? `, ${fmtN(whole(row.order.minFill), div)} minimum` : '')));
      const go = el('button', 'rt-buy', 'Buy');
      go.type = 'button';
      go.addEventListener('click', () => openOffer(row));
      li.append(left, go);
      list.append(li);
    }
    buyPane.append(list);
  }

  function openOffer(row) {
    buyPane.textContent = '';
    const form = el('div', 'rt-form');
    form.append(el('p', 'rt-quiet',
      `Buying from a listing at ${fmtXvg(perCoin(row.order.minPrice, div))} XVG each. `
      + `${fmtN(whole(row.remaining), div)} available.`));

    const field = el('label', 'rt-field');
    field.append(el('span', '', 'How many ' + coin.display));
    const input = el('input', 'rt-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.placeholder = fmtN(whole(row.remaining), div);
    field.append(input);
    form.append(field);

    const terms = el('dl', 'rt-terms');
    const line = (k) => {
      const d = document.createElement('div');
      const dd = el('dd', '', '-');
      d.append(el('dt', '', k), dd);
      terms.append(d);
      return dd;
    };
    const tPay = line('You pay');
    const tEach = line('Works out at');
    const tLeft = line('Seller keeps');
    form.append(terms);

    const note = el('p', 'rt-note');
    const actions = el('div', 'rt-actions');
    const place = el('button', 'rt-go', 'Place the offer');
    const back = el('button', 'rt-back', 'Back');
    place.type = back.type = 'button';
    place.disabled = true;
    actions.append(place, back);
    form.append(note, actions);
    buyPane.append(form);

    back.addEventListener('click', () => paintBuy());

    const recalc = () => {
      note.classList.remove('bad');
      const typed = Number(String(input.value).replace(/[^0-9.]/g, ''));
      if (!typed) {
        tPay.textContent = tEach.textContent = tLeft.textContent = '-';
        note.textContent = '';
        place.disabled = true;
        return;
      }
      const units = atomic(typed);
      const pay = priceFor(row.order, units);
      tPay.textContent = fmtXvg(pay) + ' XVG';
      tEach.textContent = fmtXvg(pay / typed) + ' XVG each';
      tLeft.textContent = fmtN(whole(Math.max(0, row.remaining - units)), div);

      if (units > row.remaining) {
        note.textContent = `Only ${fmtN(whole(row.remaining), div)} of this listing is left.`;
        note.classList.add('bad');
        place.disabled = true;
        return;
      }
      if (row.order.minFill && units < row.order.minFill) {
        note.textContent = `This seller does not fill below ${fmtN(whole(row.order.minFill), div)}.`;
        note.classList.add('bad');
        place.disabled = true;
        return;
      }
      note.textContent = 'Your wallet will prove the seller’s coins against the published root '
        + 'before it signs, and nothing leaves it until the seller accepts.';
      place.disabled = false;
    };
    input.addEventListener('input', recalc);
    input.focus();

    place.addEventListener('click', async () => {
      const units = atomic(Number(String(input.value).replace(/[^0-9.]/g, '')));
      if (!units) return;
      const tooOld = await needs('placeRuneBid');
      if (tooOld) { note.textContent = tooOld; note.classList.add('bad'); return; }
      place.disabled = true;
      const was = place.textContent;
      place.textContent = 'Check your wallet…';
      note.classList.remove('bad');
      try {
        await window.verge.connect();
        const r = await window.verge.placeRuneBid({ order: row.order, amount: units, alreadySold: row.sold || 0 });
        buyPane.textContent = '';
        const done = el('div', 'rt-done');
        done.append(el('b', '', 'Offer placed'));
        done.append(el('p', '', `${fmtN(whole(r.gets), div)} ${coin.display} for ${fmtXvg(r.pays)} XVG. `
          + 'It waits on the book until the seller accepts it, and you can take it back by spending '
          + 'any of the coins behind it.'));
        buyPane.append(done);
        await loadOrders();
      } catch (e) {
        note.textContent = (e && e.message) || 'That offer could not be placed.';
        note.classList.add('bad');
        place.disabled = false;
        place.textContent = was;
      }
    });
  }

  // --- listing yours --------------------------------------------------------------------------

  async function connect() {
    if (!window.verge) return null;
    try {
      const r = await window.verge.connect();
      address = (r && (r.address || r[0])) || (await window.verge.getAddress());
      if (address && typeof address === 'object') address = address.address;
    } catch { return null; }
    try {
      const held = await window.verge.getRunes();
      const mine = ((held && held.runes) || []).find((x) => x.ref === coin.runeRef);
      holdings = mine ? Number(mine.units) : 0;
    } catch { holdings = null; }
    return address;
  }

  const mineOf = () => orders.filter((o) => address && o.order.address === address);

  function paintSell() {
    sellPane.textContent = '';

    if (!window.verge) {
      const box = el('div', 'rt-empty');
      box.append(el('p', '', 'Selling needs the Verginals wallet, because only your own key can '
        + 'sign a listing. This site never holds one.'));
      sellPane.append(box);
      return;
    }

    if (address === null) {
      const box = el('div', 'rt-empty');
      box.append(el('p', '', 'Connect your wallet to see what you hold and put some up for sale.'));
      const b = el('button', 'rt-go', 'Connect wallet');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Check your wallet…';
        const got = await connect();
        if (!got) { b.disabled = false; b.textContent = 'Connect wallet'; return; }
        await loadOrders();
        paintSell();
      });
      box.append(b);
      sellPane.append(box);
      return;
    }

    const have = el('p', 'rt-quiet');
    if (holdings === null) {
      have.textContent = 'Your wallet could not verify what you hold of this coin right now, so no '
        + 'balance is shown. You can still list, and the listing binds nothing.';
    } else {
      have.textContent = `You hold ${fmtN(whole(holdings), div)} ${coin.display}.`;
    }
    sellPane.append(have);

    if (holdings === 0) {
      sellPane.append(el('p', 'rt-note', 'Nothing to list yet. '
        + (coin.mint && coin.mint.open ? 'This coin has an open mint, so you can claim some.' : '')));
    }

    const form = el('div', 'rt-form');
    const amountField = el('label', 'rt-field');
    amountField.append(el('span', '', 'How many to sell'));
    const amount = el('input', 'rt-input');
    amount.type = 'text'; amount.inputMode = 'decimal'; amount.autocomplete = 'off';
    amount.placeholder = holdings ? fmtN(whole(holdings), div) : '1000';
    amountField.append(amount);

    const priceField = el('label', 'rt-field');
    priceField.append(el('span', '', 'Price per coin, in XVG'));
    const price = el('input', 'rt-input');
    price.type = 'text'; price.inputMode = 'decimal'; price.autocomplete = 'off';
    price.placeholder = '0.5';
    priceField.append(price);

    const pair = el('div', 'rt-pair');
    pair.append(amountField, priceField);
    form.append(pair);

    const total = el('p', 'rt-total', 'Set an amount and a price.');
    const note = el('p', 'rt-note');
    const list = el('button', 'rt-go', 'List for sale');
    list.type = 'button';
    list.disabled = true;
    form.append(total, note, list);
    sellPane.append(form);

    const recalc = () => {
      note.classList.remove('bad');
      const a = Number(String(amount.value).replace(/[^0-9.]/g, ''));
      const p = Number(String(price.value).replace(/[^0-9.]/g, ''));
      if (!a || !p) {
        total.textContent = 'Set an amount and a price.';
        list.disabled = true;
        return;
      }
      const ratio = priceRatio(p, div);
      if (ratio.units <= 0) {
        total.textContent = 'That price rounds to nothing.';
        list.disabled = true;
        return;
      }
      total.textContent = `${fmtN(a, div)} ${coin.display} at ${fmtXvg(ratio.units)} XVG each `
        + `is ${fmtXvg(ratio.units * a)} XVG for the lot.`;
      if (holdings !== null && atomic(a) > holdings) {
        note.textContent = `You only hold ${fmtN(whole(holdings), div)}. A listing above that can `
          + 'never be filled in full.';
        note.classList.add('bad');
      } else {
        note.textContent = 'This publishes a price. It moves nothing, it binds nothing, and every '
          + 'offer that arrives still has to be accepted by you, in your wallet.';
      }
      list.disabled = false;
    };
    amount.addEventListener('input', recalc);
    price.addEventListener('input', recalc);

    list.addEventListener('click', async () => {
      const a = Number(String(amount.value).replace(/[^0-9.]/g, ''));
      const p = Number(String(price.value).replace(/[^0-9.]/g, ''));
      if (!a || !p) return;
      const tooOld = await needs('publishRuneOrder');
      if (tooOld) { note.textContent = tooOld; note.classList.add('bad'); return; }
      list.disabled = true;
      const was = list.textContent;
      list.textContent = 'Check your wallet…';
      note.classList.remove('bad');
      try {
        await window.verge.publishRuneOrder({
          runeRef: coin.runeRef,
          sell: atomic(a),
          minPrice: priceRatio(p, div),
          minFill: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
          nonce: String(Date.now()),
        });
        await loadOrders();
        paintSell();
        paintBuy();
      } catch (e) {
        note.textContent = (e && e.message) || 'That listing could not be published.';
        note.classList.add('bad');
        list.disabled = false;
        list.textContent = was;
      }
    });

    const mine = mineOf();
    if (mine.length) {
      sellPane.append(el('h3', 'rt-sub', 'Your listings'));
      const ul = el('ul', 'rt-asks');
      for (const row of mine) {
        const li = el('li', 'rt-ask');
        const left = el('div', 'rt-ask-id');
        left.append(el('b', '', fmtXvg(perCoin(row.order.minPrice, div)) + ' XVG each'));
        left.append(el('span', '', fmtN(whole(row.remaining), div) + ' still on offer'
          + (row.sold ? `, ${fmtN(whole(row.sold), div)} sold` : '')));
        const off = el('button', 'rt-back', 'Take down');
        off.type = 'button';
        off.addEventListener('click', async () => {
          off.disabled = true;
          off.textContent = 'Check your wallet…';
          try {
            await window.verge.withdrawRuneOrder({ order: row.order });
            await loadOrders();
            paintSell();
            paintBuy();
          } catch (e) {
            off.disabled = false;
            off.textContent = 'Take down';
            note.textContent = (e && e.message) || 'That listing could not be taken down.';
            note.classList.add('bad');
          }
        });
        li.append(left, off);
        ul.append(li);
      }
      sellPane.append(ul);
    }
  }

  loadOrders().then(() => { paintBuy(); });
}

export { priceRatio, perCoin, priceFor };
