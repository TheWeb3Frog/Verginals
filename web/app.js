'use strict';
// Verginals web UI (payment-request flow). Talks to src/server.js. No framework, no build step.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || String(data) || res.statusText);
  return data;
}

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const short = (h) => (h && h.length > 16 ? h.slice(0, 8) + '…' + h.slice(-6) : h);
// HTML-escape any value that can carry attacker-controlled bytes before it goes into innerHTML.
// Inscription content-types, collection metadata, etc. are untrusted; escaping them stops markup
// injection (defacement / phishing overlays) even where CSP already blocks script execution.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wireCopy(btnSel, getText) {
  $(btnSel).addEventListener('click', () => {
    const b = $(btnSel);
    navigator.clipboard.writeText(getText());
    const prev = b.textContent;
    b.textContent = 'copied ✓';
    setTimeout(() => (b.textContent = prev), 1200);
  });
}

// --- tab switching -----------------------------------------------------------------------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#panel-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'explore') { loadInscriptions(); startExploreAutoRefresh(); }
  else stopExploreAutoRefresh();
  if (t.dataset.tab === 'mint') loadMintStatus();
  if (t.dataset.tab === 'support') renderDonateQR();
}));

$$('.subtab').forEach((s) => s.addEventListener('click', () => {
  $$('.subtab').forEach((x) => x.classList.remove('active'));
  $$('.kind-pane').forEach((x) => x.classList.remove('active'));
  s.classList.add('active');
  $('#pane-' + s.dataset.kind).classList.add('active');
}));

function currentKind() { return $('.subtab.active').dataset.kind; }

// In-page navigation links (footer / prose sections) that jump to a tab.
function activateTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) { tab.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}
$$('[data-goto]').forEach((el) => el.addEventListener('click', (e) => {
  e.preventDefault();
  activateTab(el.dataset.goto);
}));

// --- Terms-acceptance gate ---------------------------------------------------------------
// Before any inscription or mint, the user must tick a box accepting the Terms of Use and
// acknowledging that inscriptions are permanent, public and irreversible. Consent is asked
// once per browser session (kept only in memory; nothing is sent to or stored by the server).
let consentGiven = false;
function requireConsent() {
  if (consentGiven) return Promise.resolve(true);
  const modal = $('#consent-modal');
  const box = $('#consent-box');
  const accept = $('#consent-accept');
  const cancel = $('#consent-cancel');
  const termsLink = modal ? modal.querySelector('a[data-goto="terms"]') : null;
  if (!modal || !box || !accept || !cancel) return Promise.resolve(true); // fail-open if markup missing
  return new Promise((resolve) => {
    box.checked = false;
    accept.disabled = true;
    modal.classList.remove('hidden');
    const onToggle = () => { accept.disabled = !box.checked; };
    const cleanup = (result) => {
      box.removeEventListener('change', onToggle);
      accept.removeEventListener('click', onAccept);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      if (termsLink) termsLink.removeEventListener('click', onCancel);
      modal.classList.add('hidden');
      resolve(result);
    };
    const onAccept = () => { if (box.checked) { consentGiven = true; cleanup(true); } };
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    box.addEventListener('change', onToggle);
    accept.addEventListener('click', onAccept);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    // Reading the full Terms closes the modal (the global data-goto handler switches tab).
    if (termsLink) termsLink.addEventListener('click', onCancel);
  });
}

// --- text stats --------------------------------------------------------------------------
$('#text-input').addEventListener('input', (e) => {
  const bytes = new TextEncoder().encode(e.target.value).length;
  $('#text-stats').textContent = `${bytes} byte${bytes > 1 ? 's' : ''}`;
});

// --- file handling -----------------------------------------------------------------------
let fileState = null; // { name, type, dataBase64, size }
const dz = $('#dropzone');
const fi = $('#file-input');
dz.addEventListener('click', () => fi.click());
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
fi.addEventListener('change', () => { if (fi.files[0]) readFile(fi.files[0]); });
$('#file-clear').addEventListener('click', (e) => { e.stopPropagation(); fileState = null; $('#drop-empty').classList.remove('hidden'); $('#drop-filled').classList.add('hidden'); fi.value = ''; });

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result).split(',')[1];
    fileState = { name: file.name, type: file.type, dataBase64: b64, size: file.size };
    $('#drop-empty').classList.add('hidden');
    $('#drop-filled').classList.remove('hidden');
    const prev = $('#file-preview');
    prev.innerHTML = '';
    if ((file.type || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.src = reader.result;
      prev.appendChild(img);
    } else {
      prev.innerHTML = '<span class="ficon">📄</span>';
    }
    $('#file-meta').innerHTML = `<strong>${file.name}</strong><br>${file.type || 'unknown type'}<br>${fmt(file.size)} bytes`;
  };
  reader.readAsDataURL(file);
}

// --- step 1: create payment request ------------------------------------------------------
let pollTimer = null;
let currentJob = null;

$('#btn-quote').addEventListener('click', async () => {
  $('#quote-error').textContent = '';
  if (!(await requireConsent())) return;
  const btn = $('#btn-quote');
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const body = { network: $('#network').value, amountPerInputXVG: Number($('#amount').value) };
    body.to = $('#to-address').value.trim();
    if (!body.to) throw new Error('Enter the Verge address where the inscription should live.');
    if (currentKind() === 'text') {
      body.kind = 'text';
      body.text = $('#text-input').value;
      if (!body.text) throw new Error('Text content is empty.');
    } else {
      if (!fileState) throw new Error('Choose a file.');
      body.kind = 'file';
      body.filename = fileState.name;
      body.contentType = fileState.type || undefined;
      body.dataBase64 = fileState.dataBase64;
    }
    const quote = await api('/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    renderPayment(quote);
  } catch (e) {
    $('#quote-error').textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Create payment request →';
  }
});

function renderPayment(q) {
  currentJob = q.jobId;
  $('#payment').classList.remove('hidden');
  $('#pay-success').classList.add('hidden');
  $('#pay-error').textContent = '';
  $('#paystatus').classList.remove('hidden');

  $('#pay-amount').textContent = fmt(q.totalXVG) + ' XVG';
  $('#pay-address').textContent = q.depositAddress;
  $('#pay-uri').href = q.paymentURI;

  const b = q.breakdown;
  const rows = [
    ['Type', q.contentType],
    ['Size', fmt(q.bodySize) + ' B'],
    ['Inputs', q.numInputs],
    ['Total to send', fmt(q.totalXVG) + ' XVG'],
    ['Returned to you', fmt(b.carrierReturnedXVG) + ' XVG'],
  ];
  if (b.serviceFeeXVG > 0) rows.push(['Service fee', fmt(b.serviceFeeXVG) + ' XVG']);
  rows.push(['Net cost', fmt(b.netCostXVG) + ' XVG']);
  $('#pay-summary').innerHTML = rows
    .map(([k, v]) => `<div class="kv"><b>${v}</b><span>${k}</span></div>`).join('');

  // QR of the verge: payment URI (scannable by mobile wallets)
  const holder = $('#qrcode');
  holder.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(q.paymentURI);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch (_) {
    holder.innerHTML = '<div class="hint">(QR unavailable, copy the address)</div>';
  }

  $('#paystatus-text').textContent = `Waiting for your payment of ${fmt(q.totalXVG)} XVG…`;
  $('#payment').scrollIntoView({ behavior: 'smooth' });
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const id = currentJob;
  pollTimer = setInterval(async () => {
    if (currentJob !== id) return clearInterval(pollTimer);
    try {
      const j = await api('/api/job/' + id);
      if (j.status === 'awaiting_payment') {
        const got = j.receivedXVG != null ? fmt(j.receivedXVG) : '0';
        $('#paystatus-text').textContent = `Waiting for your payment… (received ${got} / ${fmt(j.totalXVG)} XVG)`;
      } else if (j.status === 'funding') {
        $('#paystatus-text').textContent = 'Payment detected: building & broadcasting your inscription…';
      } else if (j.status === 'done') {
        clearInterval(pollTimer);
        paymentDone(j);
      } else if (j.status === 'error') {
        clearInterval(pollTimer);
        $('#paystatus').classList.add('hidden');
        $('#pay-error').textContent = '✗ ' + (j.error || 'something went wrong');
      }
    } catch (e) {
      $('#pay-error').textContent = '✗ ' + e.message;
    }
  }, 2500);
}

function paymentDone(j) {
  $('#paystatus').classList.add('hidden');
  const el = $('#pay-success');
  el.classList.remove('hidden');
  el.innerHTML = `✅ <strong>Inscription broadcast!</strong><br>
    reveal txid: <code>${j.revealTxid}</code><br>
    location: <code>${j.location}</code><br>
    destination: <code>${j.to}</code><br>
    returned to you: ${fmt(j.carrierReturnedXVG)} XVG · net cost: ${fmt(j.netCostXVG)} XVG<br>
    <span class="hint">It will appear in the Explore tab once the block is mined/confirmed.</span>`;
}

// --- explore -----------------------------------------------------------------------------
let exploreTimer = null;
let ownerFilter = null; // when set, Explore shows only verginals held by this address

async function loadInscriptions() {
  const g = $('#gallery');
  if (!g.children.length || g.querySelector('.empty')) g.innerHTML = '<div class="empty">Indexing…</div>';
  try {
    const data = await api('/api/inscriptions' + (ownerFilter ? '?owner=' + encodeURIComponent(ownerFilter) : ''));
    const scope = ownerFilter ? `your verginals (${short(ownerFilter)})` : 'all verginals';
    const meta = `${scope} · ${data.count} inscription(s) · blocks ${data.indexFrom}–${data.indexedThrough}`;
    $('#explore-meta').textContent = data.pendingCount
      ? `${meta} · ${data.pendingCount} unconfirmed`
      : meta;
    if (data.indexReady === false && !ownerFilter) {
      $('#explore-meta').textContent += ' · (full index still building…)';
    }
    if (!data.inscriptions.length) {
      g.innerHTML = ownerFilter
        ? `<div class="empty">No verginals found at this address yet.${data.indexReady === false ? '<br><span class="hint">The full index is still building; recently confirmed ones may not appear until it catches up.</span>' : ''}</div>`
        : '<div class="empty">No inscriptions in the indexed range yet.</div>';
      return;
    }
    // Show unconfirmed (mempool) first, then confirmed newest-first.
    const pending = data.inscriptions.filter((i) => i.status === 'pending');
    const confirmed = data.inscriptions.filter((i) => i.status !== 'pending').reverse();
    g.innerHTML = '';
    pending.concat(confirmed).forEach((ins) => g.appendChild(card(ins)));
  } catch (e) {
    g.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

// Light auto-refresh while the Explore panel is active, so pending → confirmed flips live.
function startExploreAutoRefresh() {
  stopExploreAutoRefresh();
  exploreTimer = setInterval(() => {
    if ($('#panel-explore').classList.contains('active')) loadInscriptions();
    else stopExploreAutoRefresh();
  }, 15000);
}
function stopExploreAutoRefresh() {
  if (exploreTimer) { clearInterval(exploreTimer); exploreTimer = null; }
}

function card(ins) {
  const c = document.createElement('div');
  c.className = 'ins-card';
  const media = document.createElement('div');
  media.className = 'ins-media';
  const ct = ins.contentType || '';
  const url = '/api/content/' + ins.txid;
  if (ct.startsWith('image/')) {
    const img = document.createElement('img'); img.src = url; img.loading = 'lazy'; media.appendChild(img);
  } else if (ct.startsWith('text/')) {
    const pre = document.createElement('div'); pre.className = 'txtprev'; pre.textContent = '…';
    fetch(url).then((r) => r.text()).then((t) => (pre.textContent = t.slice(0, 400))).catch(() => (pre.textContent = '(text)'));
    media.appendChild(pre);
  } else {
    const blob = document.createElement('div'); blob.className = 'blob'; blob.textContent = '📦'; media.appendChild(blob);
  }
  const body = document.createElement('div');
  body.className = 'ins-body';
  const pending = ins.status === 'pending';
  const badge = pending
    ? '<span class="badge pending">⏳ unconfirmed</span>'
    : `<span class="badge ok">✓ ${fmt(ins.confirmations)} conf</span>`;
  const numLabel = ins.number != null ? `#${ins.number}` : (ins.mine ? 'yours' : 'verginal');
  const where = pending ? 'mempool' : `block ${ins.genesisHeight}`;
  body.innerHTML = `<div class="num">${numLabel} ${badge}</div>
    <div class="ct">${esc(ins.contentType) || 'n/a'}</div>
    <div class="meta">${fmt(ins.bodySize)} bytes · ${where}<br>${esc(short(ins.txid))}</div>`;
  // On-chain traits (ord tag-5 CBOR metadata), when the inscription carries them.
  const md = Array.isArray(ins.metadata) ? ins.metadata.find((m) => m && Array.isArray(m.attributes)) : null;
  if (md && md.attributes.length) {
    const traits = document.createElement('div');
    traits.className = 'traits card-traits';
    traits.innerHTML = md.attributes
      .map((a) => `<span class="trait"><b>${esc(a.trait_type)}</b>${esc(a.value)}</span>`)
      .join('');
    body.appendChild(traits);
  }
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.textContent = 'view content ↗';
  body.appendChild(a);
  c.appendChild(media); c.appendChild(body);
  return c;
}
$('#btn-refresh').addEventListener('click', loadInscriptions);

// --- "show mine" owner filter -----------------------------------------------------------
function applyOwnerFilter() {
  const addr = $('#owner-input').value.trim();
  if (!addr) return;
  ownerFilter = addr;
  $('#btn-allins').classList.remove('hidden');
  loadInscriptions();
}
$('#btn-mine').addEventListener('click', applyOwnerFilter);
$('#owner-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyOwnerFilter(); });
$('#btn-allins').addEventListener('click', () => {
  ownerFilter = null;
  $('#owner-input').value = '';
  $('#btn-allins').classList.add('hidden');
  loadInscriptions();
});

// --- mint (Alpha Verginals) --------------------------------------------------------------
let mintEnabled = false;
let mintPollTimer = null;
let mintJob = null;
let pendingVerginal = null; // stashed at reserve time, unveiled once payment confirms

async function loadMintStatus() {
  try {
    const s = await api('/api/mint/status');
    if (!s.enabled) { mintEnabled = false; return null; }
    mintEnabled = true;
    $('#tab-mint').classList.remove('hidden');
    $('#mint-title').textContent = 'Alpha ' + (s.name || 'Verginals');
    $('#mint-minted').textContent = fmt(s.minted);
    $('#mint-supply').textContent = fmt(s.supply);
    const pct = s.supply ? Math.min(100, (s.minted / s.supply) * 100) : 0;
    $('#mint-bar').style.width = pct.toFixed(2) + '%';
    $('#mint-fair').innerHTML =
      `Provably fair · commitment <code>${short(s.commitment)}</code>` +
      (s.revealed && s.seed ? ` · seed revealed <code>${short(s.seed)}</code>` : '') +
      ` · ${fmt(s.remaining)} left`;
    // Launch campaign badge. Driven entirely by the server: it shows only while the promo is active
    // and disappears on its own once the free allocation is used up, with no site change needed.
    const promoEl = $('#mint-promo');
    if (promoEl) {
      const p = s.promo;
      if (p && p.active) {
        promoEl.innerHTML = `🎁 Launch gift: we cover the inscription fees on the first ${fmt(p.limit)} mints, so you can mint with <b>no XVG</b> in your wallet. <b>${fmt(p.remaining)}</b> left.`;
        promoEl.classList.remove('hidden');
      } else {
        promoEl.classList.add('hidden');
      }
    }
    if (s.soldOut) showMintSoldOut(s);
    return s;
  } catch (_) {
    mintEnabled = false;
    return null;
  }
}

function showMintSoldOut(s) {
  $('#mint-form').classList.add('hidden');
  $('#mint-soldout').classList.remove('hidden');
  $('#mint-seed').innerHTML = s.seed
    ? `Fairness seed: <code>${s.seed}</code><br><span class="hint">Verify: SHA256(seed) must equal commitment <code>${short(s.commitment)}</code>.</span>`
    : '<span class="hint">The seed will be revealed shortly.</span>';
}

$('#btn-mint').addEventListener('click', async () => {
  $('#mint-error').textContent = '';
  const btn = $('#btn-mint');
  const to = $('#mint-address').value.trim();
  if (!to) { $('#mint-error').textContent = '✗ Enter the Verge address where your Verginal should live.'; return; }
  if (!(await requireConsent())) return;
  btn.disabled = true; btn.textContent = 'Reserving your Verginal…';
  try {
    const r = await api('/api/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
    if (r.soldOut) { showMintSoldOut(r); return; }
    renderMint(r);
  } catch (e) {
    $('#mint-error').textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Mint a random Verginal →';
  }
});

function renderMint(r) {
  mintJob = r.jobId;
  pendingVerginal = r.verginal;
  $('#mint-form').classList.add('hidden');
  $('#mint-active').classList.remove('hidden');

  // reset the reveal to its sealed state
  $('#reveal-box').classList.remove('revealed');
  $('#reveal-back').innerHTML = '';

  // Promo mint: the deposit is already funded on our side, so hide every payment control and just
  // wait for the inscription to broadcast. Everything else in the reveal flow is identical.
  if (r.promo && r.promo.applied) {
    const payblock = $('#mint-payblock');
    if (payblock) payblock.classList.add('hidden');
    $('#mint-paystatus').classList.remove('hidden');
    $('#mint-pay-error').textContent = '';
    $('#btn-mint-again').classList.add('hidden');
    $('#mint-paystatus-text').textContent = 'Inscription fees are on us. Inscribing and broadcasting your Verginal…';
    $('#mint-active').scrollIntoView({ behavior: 'smooth' });
    startMintPolling();
    return;
  }
  const payblock = $('#mint-payblock');
  if (payblock) payblock.classList.remove('hidden');

  $('#mint-amount').textContent = fmt(r.totalXVG) + ' XVG';
  $('#mint-pay-address').textContent = r.depositAddress;
  $('#mint-uri').href = r.paymentURI;

  const b = r.breakdown;
  const rows = [
    ['Inputs', r.numInputs],
    ['Total to send', fmt(r.totalXVG) + ' XVG'],
    ['Returned to you', fmt(b.carrierReturnedXVG) + ' XVG'],
  ];
  if (b.serviceFeeXVG > 0) rows.push(['Service fee', fmt(b.serviceFeeXVG) + ' XVG']);
  rows.push(['Net cost', fmt(b.netCostXVG) + ' XVG']);
  $('#mint-summary').innerHTML = rows.map(([k, v]) => `<div class="kv"><b>${v}</b><span>${k}</span></div>`).join('');

  const holder = $('#mint-qrcode');
  holder.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(r.paymentURI);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch (_) {
    holder.innerHTML = '<div class="hint">(QR unavailable, copy the address)</div>';
  }

  $('#mint-paystatus').classList.remove('hidden');
  $('#mint-pay-error').textContent = '';
  $('#btn-mint-again').classList.add('hidden');
  $('#mint-paystatus-text').textContent = `Waiting for your payment of ${fmt(r.totalXVG)} XVG…`;
  $('#mint-active').scrollIntoView({ behavior: 'smooth' });
  startMintPolling();
}

function startMintPolling() {
  if (mintPollTimer) clearInterval(mintPollTimer);
  const id = mintJob;
  mintPollTimer = setInterval(async () => {
    if (mintJob !== id) return clearInterval(mintPollTimer);
    try {
      const j = await api('/api/job/' + id);
      if (j.status === 'awaiting_payment') {
        const got = j.receivedXVG != null ? fmt(j.receivedXVG) : '0';
        $('#mint-paystatus-text').textContent = `Waiting for your payment… (received ${got} / ${fmt(j.totalXVG)} XVG)`;
      } else if (j.status === 'funding') {
        $('#mint-paystatus-text').textContent = 'Payment detected: inscribing & broadcasting your Verginal…';
      } else if (j.status === 'done') {
        clearInterval(mintPollTimer);
        mintDone(j);
      } else if (j.status === 'error') {
        clearInterval(mintPollTimer);
        $('#mint-paystatus').classList.add('hidden');
        $('#mint-pay-error').textContent = '✗ ' + (j.error || 'something went wrong');
      }
    } catch (e) {
      $('#mint-pay-error').textContent = '✗ ' + e.message;
    }
  }, 2500);
}

function mintDone(j) {
  $('#mint-paystatus').classList.add('hidden');
  revealVerginal(pendingVerginal, j);
  $('#btn-mint-again').classList.remove('hidden');
  loadMintStatus(); // bump the live counter
}

function revealVerginal(v, j) {
  if (!v) return;
  const traits = (v.attributes || [])
    .map((a) => `<span class="trait"><b>${esc(a.trait_type)}</b>${esc(a.value)}</span>`).join('');
  $('#reveal-back').innerHTML = `
    <img class="reveal-img" src="${esc(v.imageUrl)}" alt="${esc(v.name)}" />
    <div class="reveal-info">
      <div class="reveal-name">${esc(v.name)} <span class="badge ok">#${esc(v.number)}</span></div>
      <div class="traits">${traits}</div>
      <div class="hint reveal-tx">reveal txid: <code>${esc(short(j.revealTxid))}</code></div>
    </div>`;
  // let the DOM settle, then flip
  requestAnimationFrame(() => $('#reveal-box').classList.add('revealed'));
}

$('#btn-mint-again').addEventListener('click', () => {
  mintJob = null;
  pendingVerginal = null;
  $('#mint-active').classList.add('hidden');
  $('#mint-form').classList.remove('hidden');
  $('#mint-address').focus();
});

// --- copy buttons ------------------------------------------------------------------------
wireCopy('#copy-amount', () => String($('#pay-amount').textContent).replace(/[^\d.]/g, ''));
wireCopy('#copy-address', () => $('#pay-address').textContent);
wireCopy('#mint-copy-amount', () => String($('#mint-amount').textContent).replace(/[^\d.]/g, ''));
wireCopy('#mint-copy-address', () => $('#mint-pay-address').textContent);
if ($('#copy-donate')) wireCopy('#copy-donate', () => $('#donate-address').textContent);

// --- "Open in wallet" links --------------------------------------------------------------
// A verge: URI only launches if the user has a desktop wallet that registered the scheme.
// Browsers give no reliable failure callback, so we use the focus-leaves heuristic: if the
// page never loses focus shortly after the click, assume nothing handled it and nudge the
// user toward the QR code / copy fields instead of failing silently in the console.
function wireWalletLink(id) {
  const a = $('#' + id);
  if (!a) return;
  a.addEventListener('click', () => {
    const uri = a.getAttribute('href');
    if (!uri || uri === '#') return;
    let left = false;
    const onHide = () => { left = true; };
    window.addEventListener('blur', onHide, { once: true });
    document.addEventListener('visibilitychange', onHide, { once: true });
    setTimeout(() => {
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onHide);
      if (left) return; // a wallet opened, all good
      let hint = a.nextElementSibling;
      if (!hint || !hint.classList.contains('wallet-hint')) {
        hint = document.createElement('div');
        hint.className = 'hint wallet-hint';
        a.insertAdjacentElement('afterend', hint);
      }
      hint.textContent = 'No Verge wallet opened. Scan the QR code, or copy the amount and deposit address above into your wallet manually.';
    }, 1200);
  });
}
wireWalletLink('pay-uri');
wireWalletLink('mint-uri');

// --- donation QR ------------------------------------------------------------------------
function renderDonateQR() {
  const holder = $('#donate-qr');
  const addrEl = $('#donate-address');
  if (!holder || !addrEl || holder.dataset.done) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(addrEl.textContent.trim());
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    holder.dataset.done = '1';
  } catch (_) {
    holder.innerHTML = '<div class="hint">(QR unavailable, copy the address)</div>';
  }
}

// --- showcase carousel -------------------------------------------------------------------
// One Alpha Verginal at a time (Fire → Water → Earth), auto-rotating with clickable dots.
(function showcaseCarousel() {
  const img = $('#sc-img');
  const nameEl = $('#sc-name');
  const houseEl = $('#sc-house');
  const dots = $$('.sc-dot');
  if (!img || !nameEl || !houseEl || !dots.length) return;

  const slides = [
    { num: 1, house: 'fire',  label: 'Fire'  },
    { num: 2, house: 'water', label: 'Water' },
    { num: 4, house: 'earth', label: 'Earth' },
  ];
  let i = 0;
  let timer = null;

  function show(n) {
    i = (n + slides.length) % slides.length;
    const s = slides[i];
    img.src = '/api/collection/image/' + s.num;
    img.alt = 'Alpha Verginal, House of ' + s.label;
    nameEl.textContent = 'Verginals #' + s.num;
    houseEl.textContent = s.label;
    houseEl.className = 'sc-house ' + s.house;
    dots.forEach((d, k) => d.classList.toggle('active', k === i));
  }
  function start() { stop(); timer = setInterval(() => show(i + 1), 3500); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  dots.forEach((d) => d.addEventListener('click', () => { show(Number(d.dataset.i)); start(); }));
  show(0);
  start();
})();

// --- boot --------------------------------------------------------------------------------
(async () => {
  try {
    const info = await api('/api/info');
    $('#netinfo').innerHTML = `network <strong>${info.network}</strong><br>height ${fmt(info.tip)}`;
    // The server is pinned to one network; align the selector so the user can't pick a mismatch.
    if (info.network) $('#network').value = info.network;
  } catch (e) {
    $('#netinfo').textContent = 'node unreachable';
  }
  loadMintStatus(); // reveals the Mint tab only when the server has a collection loaded
})();
