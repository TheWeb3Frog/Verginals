
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
  if (t.dataset.tab === 'home') loadHome();
  if (t.dataset.tab === 'explore') { loadInscriptions(); startExploreAutoRefresh(); }
  else stopExploreAutoRefresh();
  if (t.dataset.tab === 'mint') loadMintStatus();
  if (t.dataset.tab === 'stats') loadStats();
  if (t.dataset.tab === 'launchpad') loadLaunchpad();
  if (t.dataset.tab === 'market') loadMarket();
  if (t.dataset.tab === 'collection') loadCollection();
  if (t.dataset.tab === 'arena') loadArena();
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

// --- linkable tabs -----------------------------------------------------------------------
//
// The tabs used to answer to clicks and to nothing else, which meant no other page could point at
// one. A link to the market from the etch page had nowhere to go, and that is the real reason this
// site had no menu: half of it had no addresses.
//
// The hash is now the address of a tab. /#market opens the market, the back button walks the tabs,
// and a link somebody pastes lands where they meant it to.
function tabFromHash() {
  const name = (location.hash || '').replace(/^#/, '');
  if (!name) return;
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab && !tab.classList.contains('active')) tab.click();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  // replaceState, not a hash assignment: writing location.hash would push an entry per click and
  // bury the page somebody actually arrived from under a pile of tab switches.
  try { history.replaceState(null, '', '#' + t.dataset.tab); } catch (_) { /* file:// and old browsers */ }
}));
window.addEventListener('hashchange', tabFromHash);
// AFTER this script finishes evaluating, not during it. Called inline, this clicked a tab whose
// handler reaches for `exploreTimer`, which is declared two hundred lines below and was therefore
// still in its temporal dead zone: a ReferenceError on every load that carried a hash. It was
// survivable while nothing linked to a tab. The site bar links to eight of them.
queueMicrotask(tabFromHash);
// The home panel is the one that starts active, so no tab click ever fires for it and its loader
// would never run on a plain visit to the site.
queueMicrotask(() => { if ($('#panel-home') && $('#panel-home').classList.contains('active')) loadHome(); });

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
  // Verge caps a transaction at ~100 KB, so a single-tx inscription can carry ~68 KB at most.
  if (file.size > 68 * 1024) {
    $('#quote-error').textContent = `✗ ${file.name} is ${Math.round(file.size / 1024)} KB. The Verge network caps an inscription at ~68 KB; compress the file and try again.`;
    return;
  }
  $('#quote-error').textContent = '';
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

// --- optional metadata editor (name / description / traits, inscribed on-chain as tag 5) ---
const metaFields = $('#meta-fields');
$('#meta-toggle').addEventListener('click', () => {
  const open = metaFields.classList.toggle('hidden');
  $('#meta-toggle').textContent = open ? 'add metadata +' : 'remove metadata ✕';
  if (!open && !$('#meta-traits').children.length) addTraitRow();
  updateMetaSize();
});

function addTraitRow(type = '', value = '') {
  const row = document.createElement('div');
  row.className = 'trait-row';
  row.innerHTML = `
    <input type="text" class="trait-type" maxlength="48" placeholder="trait (e.g. Background)" />
    <input type="text" class="trait-value" maxlength="120" placeholder="value (e.g. Cool Green)" />
    <button class="link trait-del" type="button" title="remove">✕</button>`;
  row.querySelector('.trait-type').value = type;
  row.querySelector('.trait-value').value = value;
  row.querySelector('.trait-del').addEventListener('click', () => { row.remove(); updateMetaSize(); });
  row.querySelectorAll('input').forEach((i) => i.addEventListener('input', updateMetaSize));
  $('#meta-traits').appendChild(row);
}
$('#meta-add-trait').addEventListener('click', () => addTraitRow());
$('#meta-name').addEventListener('input', updateMetaSize);
$('#meta-desc').addEventListener('input', updateMetaSize);

/** The metadata object exactly as sent to the server, or null when everything is empty. */
function collectMetadata() {
  if (metaFields.classList.contains('hidden')) return null;
  const md = {};
  const name = $('#meta-name').value.trim();
  const desc = $('#meta-desc').value.trim();
  if (name) md.name = name;
  if (desc) md.description = desc;
  const attributes = [];
  $$('#meta-traits .trait-row').forEach((row) => {
    const t = row.querySelector('.trait-type').value.trim();
    const v = row.querySelector('.trait-value').value.trim();
    if (t && v) attributes.push({ trait_type: t, value: v });
  });
  if (attributes.length) md.attributes = attributes;
  return Object.keys(md).length ? md : null;
}

function updateMetaSize() {
  const md = collectMetadata();
  const el = $('#meta-size');
  if (!md) { el.textContent = ''; return; }
  // CBOR is a touch more compact than JSON; the JSON size is an honest upper bound.
  const bytes = new TextEncoder().encode(JSON.stringify(md)).length;
  el.textContent = `~${bytes} bytes of metadata will be inscribed on-chain (max 3 KB)`;
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
    const md = collectMetadata();
    if (md) body.metadata = md;
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
let traitFilter = null; // { type, value } client-side filter, set by clicking a trait chip
let lastList = []; // inscriptions from the last load, display order (used by filter + detail)
let listedMap = new Map(); // carrier outpoint -> priceUnits, for the "for sale" badge on cards
let MARKET_FEE_BPS = 0; // marketplace fee (basis points), from /api/info; shown to sellers

function hasTrait(ins, type, value) {
  const md = Array.isArray(ins.metadata) ? ins.metadata.find((m) => m && Array.isArray(m.attributes)) : null;
  return !!(md && md.attributes.some((a) => a && a.trait_type === type && String(a.value) === value));
}

function setTraitFilter(type, value) {
  traitFilter = type ? { type, value } : null;
  closeDetail();
  activateTab('explore');
  renderGallery();
}

/** Jump to the Alpha collection page filtered to one badge family (from the Stats page chips). */
function setBadgeFilter(family) {
  coll.badge = family;
  closeDetail();
  activateTab('collection');
  loadCollection();
}

function renderGallery() {
  const g = $('#gallery');
  const bar = $('#filterbar');
  const list = traitFilter ? lastList.filter((i) => hasTrait(i, traitFilter.type, traitFilter.value)) : lastList;
  if (traitFilter) {
    bar.classList.remove('hidden');
    bar.innerHTML = `<span class="trait"><b>${esc(traitFilter.type)}</b>${esc(traitFilter.value)}</span>
      <span>${list.length} result${list.length === 1 ? '' : 's'}</span>
      <button class="link" id="filter-clear" type="button">clear ✕</button>`;
    $('#filter-clear').addEventListener('click', () => setTraitFilter(null));
  } else {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
  g.innerHTML = '';
  if (!list.length) {
    // A filter that matches nothing is a fact this page owns. An empty chain is not, while the
    // index is still reading it, so that case says what is actually true instead.
    if (traitFilter) {
      g.innerHTML = '<div class="vg-empty"><p>No inscribed Verginal carries this trait yet.</p></div>';
      return;
    }
    indexProgress().then((prog) => {
      g.innerHTML = '';
      if (prog && prog.scanning) { g.append(scanningNotice(prog, loadInscriptions)); return; }
      g.innerHTML = ownerFilter
        ? '<div class="vg-empty"><p>Nothing found at this address.</p></div>'
        : '<div class="vg-empty"><p>Nothing inscribed in the indexed range yet.</p></div>';
    });
    return;
  }
  list.forEach((ins) => g.appendChild(card(ins)));
}

/** Refresh the outpoint -> price map used to badge "for sale" cards. Best-effort, never throws. */
async function refreshListedMap() {
  try {
    const m = await api('/api/market/listings');
    listedMap = new Map(m.listings.map((l) => [l.carrier, l.priceUnits]));
  } catch (_) { /* leave the previous map on error */ }
}

async function loadInscriptions() {
  const g = $('#gallery');
  if (!g.children.length || g.querySelector('.empty')) g.innerHTML = '<div class="empty">Indexing…</div>';
  try {
    const data = await api('/api/inscriptions' + (ownerFilter ? '?owner=' + encodeURIComponent(ownerFilter) : ''));
    const scope = ownerFilter ? `verginals held by ${short(ownerFilter)}` : 'all verginals';
    const meta = `${scope} · ${data.count} inscription(s) · blocks ${data.indexFrom}–${data.indexedThrough}`;
    $('#explore-meta').textContent = data.pendingCount
      ? `${meta} · ${data.pendingCount} unconfirmed`
      : meta;
    if (data.indexReady === false && !ownerFilter) {
      $('#explore-meta').textContent += ' · (full index still building…)';
    }
    // Show unconfirmed (mempool) first, then confirmed newest-first.
    const pending = data.inscriptions.filter((i) => i.status === 'pending');
    const confirmed = data.inscriptions.filter((i) => i.status !== 'pending').reverse();
    lastList = pending.concat(confirmed);
    await refreshListedMap();
    renderGallery();
    return lastList;
  } catch (e) {
    g.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    return [];
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
  c.className = 'ins-card clickable';
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
  // Gallery cards are labelled by the global INSCRIPTION number (#0, #1, #2 ...), so the whole
  // explore page reads in one consistent on-chain order. The collection name (e.g. Verginals
  // #3055) is revealed in the detail view on click. Pending items have no inscription number yet.
  const numLabel = ins.number != null ? `#${ins.number}`
    : (ins.collectionNumber != null ? `#${ins.collectionNumber}` : (ins.mine ? 'yours' : 'verginal'));
  const where = pending ? 'mempool' : `block ${ins.genesisHeight}`;
  const salePrice = ins.location ? listedMap.get(ins.location) : null;
  const saleBadge = salePrice != null ? `<span class="badge sale">🏷️ ${fmt(salePrice / 1e6)} XVG</span>` : '';
  body.innerHTML = `<div class="num">${numLabel} ${badge}</div>
    ${saleBadge ? `<div class="card-sale">${saleBadge}</div>` : ''}
    <div class="ct">${esc(ins.contentType) || 'n/a'}</div>
    <div class="meta">${fmt(ins.bodySize)} bytes · ${where}<br>${esc(short(ins.txid))}</div>`;
  // On-chain traits (ord tag-5 CBOR metadata), when the inscription carries them.
  const md = Array.isArray(ins.metadata) ? ins.metadata.find((m) => m && Array.isArray(m.attributes)) : null;
  if (md && md.attributes.length) {
    const traits = document.createElement('div');
    traits.className = 'traits card-traits';
    md.attributes.forEach((a) => {
      const chip = document.createElement('span');
      chip.className = 'trait trait-click';
      chip.innerHTML = `<b>${esc(a.trait_type)}</b>${esc(a.value)}`;
      chip.title = 'show every Verginal with this trait';
      chip.addEventListener('click', (e) => { e.stopPropagation(); setTraitFilter(a.trait_type, String(a.value)); });
      traits.appendChild(chip);
    });
    body.appendChild(traits);
  }
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.textContent = 'view content ↗';
  a.addEventListener('click', (e) => e.stopPropagation());
  body.appendChild(a);
  c.appendChild(media); c.appendChild(body);
  c.addEventListener('click', () => openDetail(ins));
  return c;
}
$('#btn-refresh').addEventListener('click', loadInscriptions);

// --- detail view (modal, deep-linkable as /v/<collection number|txid>) ----------------------
const detailModal = $('#detail-modal');

// Deep-link key: the COLLECTION number when this inscription is a collection mint (that is
// the number people know it by), else the txid. Never the global inscription counter: the
// two sequences collide (inscription #4 is not Alpha #4).
function detailKey(ins) { return ins.collectionNumber != null ? String(ins.collectionNumber) : ins.txid; }

function openDetail(ins, push = true) {
  const url = '/api/content/' + ins.txid;
  const media = $('#detail-media');
  media.innerHTML = '';
  const ct = ins.contentType || '';
  if (ct.startsWith('image/')) {
    const img = document.createElement('img'); img.src = url; media.appendChild(img);
  } else if (ct.startsWith('text/')) {
    const pre = document.createElement('div'); pre.className = 'txtprev'; pre.textContent = '…';
    fetch(url).then((r) => r.text()).then((t) => (pre.textContent = t.slice(0, 1200))).catch(() => (pre.textContent = '(text)'));
    media.appendChild(pre);
  } else {
    const blob = document.createElement('div'); blob.className = 'blob'; blob.textContent = '📦'; media.appendChild(blob);
  }

  const mdEntry = Array.isArray(ins.metadata) ? ins.metadata.find((m) => m && typeof m === 'object' && !Array.isArray(m)) : null;
  const name = mdEntry && mdEntry.name ? String(mdEntry.name) : (ins.collectionNumber != null ? `Verginals #${ins.collectionNumber}` : 'Inscription');
  const pending = ins.status === 'pending';
  const badge = pending
    ? '<span class="badge pending">⏳ unconfirmed</span>'
    : `<span class="badge ok">✓ ${fmt(ins.confirmations)} conf</span>`;
  $('#detail-title').innerHTML = `${esc(name)} ${badge}`;

  const desc = $('#detail-desc');
  if (mdEntry && mdEntry.description) {
    desc.textContent = String(mdEntry.description);
    desc.classList.remove('hidden');
  } else {
    desc.classList.add('hidden');
  }

  // Traits first from the on-chain metadata; rarity percentages overlay once fetched.
  const traitsEl = $('#detail-traits');
  traitsEl.innerHTML = '';
  const attrs = (mdEntry && Array.isArray(mdEntry.attributes)) ? mdEntry.attributes : [];
  const chipFor = (a, pct) => {
    const chip = document.createElement('span');
    chip.className = 'trait trait-click';
    chip.innerHTML = `<b>${esc(a.trait_type)}</b>${esc(a.value)}${pct != null ? `<i class="pct">${pct}%</i>` : ''}`;
    chip.title = 'show every Verginal with this trait';
    chip.addEventListener('click', () => setTraitFilter(a.trait_type, String(a.value)));
    return chip;
  };
  attrs.forEach((a) => traitsEl.appendChild(chipFor(a)));

  const rankEl = $('#detail-rank');
  rankEl.classList.add('hidden');
  if (ins.collectionNumber != null && !ins.collectionSlug) {
    // Alpha mint: the rarity engine is keyed by COLLECTION number (never the inscription counter).
    api('/api/collection/rarity/' + ins.collectionNumber).then((r) => {
      const badges = (r.badges || []).map((b) => `<span class="rarity-badge ${badgeClass(b)}">${esc(b)}</span>`).join('');
      rankEl.innerHTML = `Rarity rank <b>#${fmt(r.rank)}</b> of ${fmt(r.supply)} · score ${fmt(r.score)}`
        + (badges ? `<div class="rarity-badges">${badges}</div>` : '');
      rankEl.classList.remove('hidden');
      traitsEl.innerHTML = '';
      r.traits.forEach((t) => traitsEl.appendChild(chipFor(t, t.pct)));
    }).catch(() => { /* rarity unavailable: keep the on-chain chips */ });
  } else if (ins.collectionSlug) {
    // Launchpad mint: annotate the on-chain chips with percentages from that collection's
    // trait distribution (there is no per-item rank endpoint for launchpad collections yet).
    api('/api/launchpad/' + ins.collectionSlug + '/rarity').then((r) => {
      const pctOf = (type, value) => {
        const t = r.traits.find((x) => x.trait_type === type);
        const v = t && t.values.find((x) => String(x.value) === String(value));
        return v ? v.pct : null;
      };
      traitsEl.innerHTML = '';
      attrs.forEach((a) => traitsEl.appendChild(chipFor(a, pctOf(a.trait_type, a.value))));
    }).catch(() => { /* keep plain chips */ });
  }

  const where = pending ? 'in the mempool' : `block ${fmt(ins.genesisHeight)}`;
  const ownerBit = ins.ownerAddress
    ? ` · held by <a class="link" id="detail-owner">${esc(short(ins.ownerAddress))}</a>`
    : '';
  const inscrBit = ins.number != null ? `inscription #${fmt(ins.number)} · ` : '';
  $('#detail-meta').innerHTML =
    `${inscrBit}${esc(ins.contentType) || 'n/a'} · ${fmt(ins.bodySize)} bytes · ${where}${ownerBit}<br>` +
    `tx <a class="link" href="https://verge-blockchain.info/tx/${esc(ins.txid)}" target="_blank" rel="noopener noreferrer">${esc(short(ins.txid))}</a>`;
  const ownerLink = $('#detail-owner');
  if (ownerLink) ownerLink.addEventListener('click', () => {
    closeDetail();
    showOwnerGallery(ins.ownerAddress);
  });

  renderDetailMarket(ins); // buy / sell / offer panel (async, fills in when ready)

  $('#detail-content').href = url;
  const shareUrl = 'https://verginals.com/v/' + detailKey(ins);
  const shareText = ins.number != null
    ? `${name}, inscribed forever on the Verge blockchain ⚡`
    : 'Inscribed forever on the Verge blockchain ⚡';
  $('#detail-share').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(shareUrl);

  detailModal.classList.remove('hidden');
  if (push) history.pushState({ v: detailKey(ins) }, '', '/v/' + detailKey(ins));
}

function closeDetail(push = true) {
  if (detailModal.classList.contains('hidden')) return;
  detailModal.classList.add('hidden');
  if (push && /^\/v\//.test(location.pathname)) history.pushState({}, '', '/');
}

$('#detail-close').addEventListener('click', () => closeDetail());
detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\/v\/([A-Za-z0-9]+)$/);
  if (m) openDetailByKey(m[1]);
  else closeDetail(false);
});

/** Open the detail view from a /v/<collection number|txid> deep link, loading the list if needed. */
async function openDetailByKey(key) {
  const list = lastList.length ? lastList : await loadInscriptions();
  const ins = list.find((i) => (i.collectionNumber != null && String(i.collectionNumber) === key) || i.txid === key)
    || list.find((i) => String(i.number) === key); // legacy links that used the inscription counter
  if (ins) openDetail(ins, false);
}

// --- marketplace (trustless listings & offers, driven from the detail view) -----------------
const MKT_COIN = 1_000_000;
const toUnits = (xvg) => Math.round(Number(xvg) * MKT_COIN);
const nameOf = (ins) => (ins.collectionNumber != null ? `Verginals #${ins.collectionNumber}` : (ins.number != null ? `Inscription #${ins.number}` : 'this inscription'));
/** True for content types that render as an <img>; other inscriptions get a typed placeholder tile. */
const isImageType = (ct) => typeof ct === 'string' && /^image\//i.test(ct);
/** A thumbnail for any inscription: the image itself, or a small typed placeholder. */
function thumbHtml(ins) {
  if (ins && isImageType(ins.contentType)) return `<img src="/api/content/${esc(ins.txid)}" loading="lazy" alt="" />`;
  const kind = ins && ins.contentType ? String(ins.contentType).split(';')[0].split('/')[1] || 'file' : 'item';
  return `<div class="blob">${esc(kind.slice(0, 6))}</div>`;
}

// Spot XVG/USD, fetched once on load and refreshed lazily. Purely indicative: prices are always
// paid in XVG, the dollar figure is a convenience and is simply hidden when we have no rate.
let XVG_USD = null;
async function loadPrice() {
  try {
    const p = await api('/api/price');
    if (p && typeof p.usd === 'number') XVG_USD = p.usd;
  } catch (_) { /* leave XVG_USD null, the UI falls back to plain XVG */ }
}
/** Format an XVG amount as a "≈ $x.xx" string, or '' when no rate is available. */
function usdStr(xvg) {
  if (XVG_USD == null || !(xvg > 0)) return '';
  const v = xvg * XVG_USD;
  const digits = v >= 100 ? 0 : v >= 1 ? 2 : 4;
  return '≈ $' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
/** Live-update a "≈ $x" hint under a price/offer input as the user types. */
function liveUsd(input, target) {
  if (!input || !target) return;
  const upd = () => { target.textContent = usdStr(Number(input.value)); };
  input.addEventListener('input', upd);
  upd();
}

/** Render the buy/sell/offer panel inside the open detail view for one inscription. */
async function renderDetailMarket(ins) {
  const box = $('#detail-market');
  box.innerHTML = '';
  const carrier = ins.location && /^[0-9a-f]{64}:\d+$/.test(ins.location) ? ins.location : null;
  // Any inscription that still sits on its own carrier can be traded, not just collection mints.
  if (!carrier) return;

  let item;
  try { item = await api('/api/market/item/' + carrier); } catch { return; }
  if (item.carriesInscription === false) return; // the sat has moved off this outpoint

  const M = window.VerginalsMarket;
  const canTrade = !!(M && M.supported());
  const me = M ? M.address() : null;
  const isOwner = me && item.ownerAddress && me === item.ownerAddress;
  const name = nameOf(ins);

  const wrap = document.createElement('div');
  wrap.className = 'mk';
  const status = document.createElement('div');
  status.className = 'mk-status';

  const run = async (label, fn) => {
    status.textContent = '';
    const btns = wrap.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    status.textContent = label + '…';
    try {
      const r = await fn();
      status.innerHTML = `✅ done${r && r.txid ? ` · tx <code>${esc(short(r.txid))}</code>` : ' · submitted'}`;
      setTimeout(() => renderDetailMarket(ins), 1500); // refresh the panel to the new state
    } catch (e) {
      status.textContent = '✗ ' + e.message;
      btns.forEach((b) => (b.disabled = false));
    }
  };

  // The listed price is always shown (read-only); actions only when the wallet can trade.
  if (item.listed) {
    const price = item.priceUnits;
    const xvg = price / MKT_COIN;
    const usd = usdStr(xvg);
    const head = document.createElement('div');
    head.className = 'mk-price';
    head.innerHTML = `For sale: <b>${fmt(xvg)} XVG</b>${usd ? ` <span class="mk-usd">${usd}</span>` : ''}`;
    wrap.appendChild(head);
    if (canTrade && isOwner) {
      wrap.appendChild(btn('Cancel listing', 'ghost', () => run('Cancelling', () => M.cancel(carrier))));
    } else if (canTrade && !isOwner) {
      wrap.appendChild(btn(`Buy now for ${fmt(xvg)} XVG`, 'primary', () => run('Buying', () => M.buy(carrier, price, name))));
    }
  } else if (canTrade && isOwner) {
    const form = document.createElement('div');
    form.className = 'mk-form';
    form.innerHTML = `
      <label class="mk-label" for="mk-price">Set your price</label>
      <div class="mk-field">
        <input type="number" inputmode="decimal" min="0" step="0.1" id="mk-price" placeholder="0.00" />
        <span class="mk-suffix">XVG</span>
      </div>
      <div class="mk-usd" id="mk-price-usd"></div>
      <div class="mk-fee" id="mk-price-fee"></div>`;
    liveUsd(form.querySelector('#mk-price'), form.querySelector('#mk-price-usd'));
    if (MARKET_FEE_BPS > 0) {
      const priceInput = form.querySelector('#mk-price');
      const feeLine = form.querySelector('#mk-price-fee');
      const pct = (MARKET_FEE_BPS / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
      const updateFee = () => {
        const xvg = Number(priceInput.value);
        if (!(xvg > 0)) { feeLine.textContent = ''; return; }
        const net = xvg * (1 - MARKET_FEE_BPS / 10000);
        feeLine.textContent = `You receive ${net.toLocaleString(undefined, { maximumFractionDigits: 2 })} XVG after the ${pct}% marketplace fee (funds the tournament prize pool).`;
      };
      priceInput.addEventListener('input', updateFee);
    }
    form.appendChild(btn('List for sale', 'primary block', () => {
      const xvg = Number($('#mk-price').value);
      if (!(xvg > 0)) { status.textContent = '✗ Enter a price.'; return; }
      run('Listing', () => M.list(carrier, toUnits(xvg), name));
    }));
    wrap.appendChild(form);
  }

  // Anyone who is not the owner can make an offer (when their wallet supports it).
  if (canTrade && !isOwner) {
    const form = document.createElement('div');
    form.className = 'mk-form';
    form.innerHTML = `
      <label class="mk-label" for="mk-offer">Make an offer</label>
      <div class="mk-field">
        <input type="number" inputmode="decimal" min="0" step="0.1" id="mk-offer" placeholder="0.00" />
        <span class="mk-suffix">XVG</span>
      </div>
      <div class="mk-usd" id="mk-offer-usd"></div>`;
    liveUsd(form.querySelector('#mk-offer'), form.querySelector('#mk-offer-usd'));
    form.appendChild(btn('Send offer', 'ghost block', () => {
      const xvg = Number($('#mk-offer').value);
      if (!(xvg > 0)) { status.textContent = '✗ Enter an offer.'; return; }
      if (item.carrierValue == null) { status.textContent = '✗ Cannot read the item right now.'; return; }
      run('Offering', () => M.offer(carrier, item.ownerAddress, item.carrierValue, toUnits(xvg), name));
    }));
    wrap.appendChild(form);
  }

  // Offers on this item are always visible; the owner can accept one if their wallet supports it.
  if (item.bids && item.bids.length) {
    const ob = document.createElement('div');
    ob.className = 'mk-offers';
    ob.innerHTML = '<div class="mk-offers-h">Offers</div>';
    item.bids.forEach((bid) => {
      const r = document.createElement('div');
      r.className = 'mk-offer';
      const bxvg = bid.priceUnits / MKT_COIN, busd = usdStr(bxvg);
      r.innerHTML = `<span><b>${fmt(bxvg)} XVG</b>${busd ? ` <span class="mk-usd">${busd}</span>` : ''} from ${esc(short(bid.buyerAddress))}</span>`;
      if (canTrade && isOwner) r.appendChild(btn('Accept', 'primary sm', () => run('Accepting', () => M.accept(carrier, bid.buyerAddress, bid.priceUnits, name))));
      ob.appendChild(r);
    });
    wrap.appendChild(ob);
  }

  // Wallet capability hint: install, or update to the trading version.
  if (!M || !M.installed()) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = 'Install the <a class="link" href="/verginalswallet" target="_blank" rel="noopener noreferrer">Verginals Wallet</a> to buy, sell or make offers.';
    wrap.appendChild(hint);
  } else if (!canTrade) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Update your Verginals Wallet to the latest version to trade (buy, sell and offers).';
    wrap.appendChild(hint);
  }
  wrap.appendChild(status);
  box.appendChild(wrap);
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** The three figures a market is actually read for, from the listings themselves. */
function paintMarketStats(listings) {
  const box = $('#market-stats');
  if (!box) return;
  box.innerHTML = '';
  const stat = (label, value, sub) => {
    const d = document.createElement('div');
    d.className = 'vg-stat';
    const l = document.createElement('span'); l.className = 'vg-label'; l.textContent = label;
    const b = document.createElement('b'); b.className = 'vg-num vg-n-md'; b.textContent = value;
    d.append(l, b);
    if (sub) { const x = document.createElement('span'); x.className = 'vg-stat-sub'; x.textContent = sub; d.append(x); }
    box.append(d);
  };
  const prices = listings.map((l) => Number(l.priceUnits)).filter((n) => n > 0);
  stat('Listed', fmt(listings.length));
  // The floor is the lowest ask, and with nothing listed there is no floor. Reported as absent
  // rather than as nought, which would read as somebody giving one away.
  stat('Floor', prices.length ? fmt(Math.min(...prices) / 1e6) + ' XVG' : 'no asks');
  stat('Fee', '0 XVG', 'we take nothing');
}

/**
 * Is the index still reading the chain?
 *
 * A restart costs a full rescan, and during it every panel that depends on the index answers with
 * an empty or partial list. Those panels then draw "Loading..." for twenty minutes, or worse, draw
 * an empty state that claims nothing exists. The site looks broken after every deploy, and it is
 * not broken: it is reading.
 *
 * Answers null when the question cannot be asked, which is a third state and must not be mistaken
 * for "finished".
 */
async function indexProgress() {
  try {
    const info = await api('/api/info');
    if (!info || info.tip == null || info.indexedThrough == null) return null;
    const behind = info.tip - info.indexedThrough;
    return { scanning: behind > 2, done: info.indexedThrough, tip: info.tip,
      pct: info.tip ? Math.min(100, (info.indexedThrough / info.tip) * 100) : null };
  } catch { return null; }
}

/** The notice a panel shows instead of pretending. Comes back on its own; nobody is told to refresh. */
function scanningNotice(p, again) {
  const box = document.createElement('div');
  box.className = 'vg-empty';
  const line = document.createElement('p');
  line.innerHTML = '<b>Still reading the chain</b>'
    + (p && p.pct != null ? `, ${p.pct.toFixed(2)}% of the way.` : '.');
  const say = document.createElement('p');
  say.textContent = 'Everything found so far is shown. This fills in on its own, and nothing is '
    + 'missing from the chain itself.';
  box.append(line, say);
  if (again) setTimeout(again, 15000);
  return box;
}

// --- market tab: all Verginals currently for sale -------------------------------------------

// Floor first, because that is the question a marketplace is opened with. The listings used to be
// drawn in whatever order the book returned them, so the cheapest one could be anywhere on the page
// and the floor figure at the top pointed at a card nobody could find.
const mkt = { sort: 'price-asc', ranks: new Map(), bound: false };

/** Collection number to rarity rank, fetched once. Rank is half of what a buyer is comparing. */
async function marketRanks() {
  if (mkt.ranks.size) return mkt.ranks;
  try {
    const r = await api('/api/collection/items');
    for (const it of (r && r.items) || []) if (it.rank != null) mkt.ranks.set(it.number, it.rank);
  } catch (_) { /* the price is still worth showing without it */ }
  return mkt.ranks;
}

function bindMarketSorts() {
  if (mkt.bound) return;
  const bar = $('#mk-sorts');
  if (!bar) return;
  mkt.bound = true;
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-msort]');
    if (!b) return;
    mkt.sort = b.dataset.msort;
    $$('#mk-sorts .vg-pill').forEach((p) => p.classList.toggle('is-on', p === b));
    loadMarket();
  });
}

/** Order the listings the way the pressed pill says. */
function sortListings(listings, byLoc) {
  const numOf = (l) => { const i = byLoc.get(l.carrier); return i && i.collectionNumber != null ? i.collectionNumber : null; };
  const rankOf = (l) => { const n = numOf(l); const r = n == null ? null : mkt.ranks.get(n); return r == null ? Infinity : r; };
  const rows = [...listings];
  if (mkt.sort === 'price-desc') return rows.sort((a, b) => b.priceUnits - a.priceUnits);
  if (mkt.sort === 'rank') return rows.sort((a, b) => rankOf(a) - rankOf(b) || a.priceUnits - b.priceUnits);
  if (mkt.sort === 'new') return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return rows.sort((a, b) => a.priceUnits - b.priceUnits);
}

async function loadMarket() {
  bindMarketSorts();
  const g = $('#market-gallery');
  // Say what is happening BEFORE the wait, not after it. This function needs the inscription list
  // to match a listing to its art, and during a rescan that request is slow, so the panel sat on
  // "Loading" for twenty minutes with listings it already had. The notice is drawn first and
  // replaced by the grid the moment the data lands.
  indexProgress().then((prog) => {
    if (prog && prog.scanning && !g.querySelector('.ins-card')) {
      g.innerHTML = '';
      g.append(scanningNotice(prog, loadMarket));
    }
  });
  try {
    const [data, list] = await Promise.all([
      api('/api/market/listings'),
      lastList.length ? Promise.resolve(lastList) : loadInscriptions(),
    ]);
    // Guarded: an answer without a listings array used to throw here, and the throw took the
    // whole market panel with it rather than showing an empty one.
    const listings = (data && Array.isArray(data.listings)) ? data.listings : [];
    await marketRanks();
    $('#market-meta').textContent = `${listings.length} for sale`;
    paintMarketStats(listings);
    if (!listings.length) {
      // An empty market is the screen most visitors see, so it makes an offer rather than an
      // apology, and it says where the button actually is.
      // Empty and unfinished are different facts, and only one of them is this page's to claim.
      const prog = await indexProgress();
      g.innerHTML = '';
      if (prog && prog.scanning) { g.append(scanningNotice(prog, loadMarket)); return; }
      g.innerHTML = '<div class="vg-empty">'
        + '<p><b>Nobody is selling right now.</b></p>'
        + '<p>Open one of your Verginals in My Wallet and list it. You set the price, the coin stays '
        + 'in your wallet until somebody takes it, and the sale settles in one transaction.</p>'
        + '<a class="vg-btn primary" href="#wallet" data-goto="wallet">Open My Wallet</a>'
        + '</div>';
      return;
    }
    const byLoc = new Map(list.map((i) => [i.location, i]));
    g.innerHTML = '';
    sortListings(listings, byLoc).forEach((l) => {
      const ins = byLoc.get(l.carrier);
      const c = document.createElement('div');
      c.className = 'ins-card clickable';
      const img = ins ? thumbHtml(ins) : '<div class="blob">🏷️</div>';
      const label = ins ? (ins.collectionNumber != null ? `#${ins.collectionNumber}` : (ins.number != null ? `#${ins.number}` : 'Inscription')) : 'Inscription';
      const xvg = l.priceUnits / MKT_COIN, usd = usdStr(xvg);
      const num = ins && ins.collectionNumber != null ? ins.collectionNumber : null;
      const rank = num == null ? null : mkt.ranks.get(num);
      c.innerHTML = `<div class="ins-media">${img}${rank != null ? `<span class="mk-rank">rank ${fmt(rank)}</span>` : ''}</div>
        <div class="ins-body"><div class="num">${label}</div>
        <div class="mk-price">${fmt(xvg)} XVG</div>${usd ? `<div class="mk-usd">${usd}</div>` : ''}</div>`;
      if (ins) c.addEventListener('click', () => openDetail(ins));
      g.appendChild(c);
    });
  } catch (e) {
    g.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

// --- Alpha collection page (stats, rarity-aware item grid with trait filters + activity feed) ---
const coll = {
  items: [],            // minted items with rarity, from /api/collection/items
  insByNum: new Map(),  // collection number -> inscription (txid, location, owner)
  priceByCarrier: new Map(), // listed carrier -> priceUnits
  traits: [],           // aggregate trait distribution (for the filter dropdown)
  view: 'items', sort: 'price-asc', trait: '', badge: '', forSaleOnly: false, bound: false,
};

function collAgo(ts) {
  if (!ts) return '';
  // Defensive about the unit as well as the server being fixed: a record written in milliseconds
  // reads as a date in the year 58,000, and the clamp below used to turn that into "0s ago", which
  // is the most confident possible way to be wrong.
  const t = Number(ts) > 1e11 ? Math.round(Number(ts) / 1000) : Number(ts);
  const s = Math.floor(Date.now() / 1000) - t;
  // A timestamp in the future is bad data, not "just now". Saying nothing beats saying zero.
  if (s < 0) return '';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function loadCollection() {
  if (!coll.bound) bindCollControls();
  const grid = $('#coll-items');
  try {
    const [market, itemsResp, listResp, insResp] = await Promise.all([
      api('/api/collection/market').catch(() => null),
      api('/api/collection/items').catch(() => ({ items: [], traits: [] })),
      api('/api/market/listings').catch(() => ({ listings: [] })),
      api('/api/inscriptions').catch(() => ({ inscriptions: [] })),
    ]);
    const insByNum = new Map();
    const owners = new Set();
    (insResp.inscriptions || []).forEach((i) => {
      if (i.collectionNumber != null && !i.collectionSlug) {
        insByNum.set(i.collectionNumber, i);
        if (i.ownerAddress) owners.add(i.ownerAddress);
      }
    });
    // Holders are counted client-side from the inscriptions we already fetched (the server skips a
    // costly index scan). Fall back to the server's number only if we somehow have none.
    renderCollStats(market, owners.size);
    coll.items = itemsResp.items || [];
    coll.traits = itemsResp.traits || [];
    coll.insByNum = insByNum;
    coll.priceByCarrier = new Map((listResp.listings || []).map((l) => [l.carrier, l.priceUnits]));
    buildTraitFilter();
    buildBadgeFilter();
    renderCollView();

    // SAY WHEN THE ART IS NOT THERE YET.
    //
    // The tiles come from the mint's own state, so their names, ranks and prices are right the
    // moment the server is up. The pictures do not: /api/content serves an inscription out of the
    // index, and during a rescan every one of them is a 404. So this page rendered thirteen hundred
    // blank squares and said nothing, which reads as a collection that has lost its art rather than
    // as a server that is still reading. Explore and the market already say it; this did not.
    const prog = await indexProgress();
    const old = $('#coll-scanning');
    if (old) old.remove();
    if (prog && prog.scanning) {
      const note = scanningNotice(prog, loadCollection);
      note.id = 'coll-scanning';
      grid.parentNode.insertBefore(note, grid);
    }
  } catch (e) {
    grid.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

function renderCollStats(m, holders) {
  const box = $('#coll-stats');
  if (!m) { box.innerHTML = ''; return; }
  const floorXvg = m.floorUnits != null ? m.floorUnits / MKT_COIN : null;
  const volXvg = m.volumeUnits ? m.volumeUnits / MKT_COIN : 0;
  const stat = (label, value, sub) =>
    `<div class="coll-stat"><span class="cs-val">${value}</span><span class="cs-lbl">${label}</span>${sub ? `<span class="cs-sub">${sub}</span>` : ''}</div>`;
  box.innerHTML = [
    stat('Floor', floorXvg != null ? `${fmt(floorXvg)} XVG` : '-', floorXvg != null ? usdStr(floorXvg) : ''),
    stat('Listed', m.listedCount != null ? m.listedCount : '-'),
    stat('Items', m.minted != null ? fmt(m.minted) : '-', m.total ? `of ${fmt(m.total)}` : ''),
    stat('Holders', holders != null ? fmt(holders) : '-'),
    stat('Volume', volXvg ? `${fmt(volXvg)} XVG` : '-', volXvg ? usdStr(volXvg) : ''),
  ].join('');
}

function buildTraitFilter() {
  const sel = $('#coll-trait');
  if (!sel) return;
  const cur = coll.trait;
  let html = '<option value="">All traits</option>';
  coll.traits.forEach((t) => {
    const opts = (t.values || []).map((v) => `<option value="${esc(t.trait_type)}=${esc(v.value)}">${esc(t.trait_type)}: ${esc(v.value)} (${v.count})</option>`).join('');
    html += `<optgroup label="${esc(t.trait_type)}">${opts}</optgroup>`;
  });
  sel.innerHTML = html;
  sel.value = cur;
}

/** The listed price (units) for an item, via its inscription's carrier, or null if not listed. */
function collPrice(item) {
  const ins = coll.insByNum.get(item.number);
  if (!ins || !ins.location) return null;
  const p = coll.priceByCarrier.get(ins.location);
  return p != null ? p : null;
}

function renderCollView() {
  $('#coll-items').classList.toggle('hidden', coll.view !== 'items');
  $('#coll-activity').classList.toggle('hidden', coll.view !== 'activity');
  $('#coll-controls').classList.toggle('hidden', coll.view !== 'items');
  if (coll.view === 'items') renderCollItems();
  else renderCollActivity();
}

function renderCollItems() {
  const grid = $('#coll-items');
  let rows = coll.items.map((it) => ({ it, price: collPrice(it), ins: coll.insByNum.get(it.number) }));
  if (coll.forSaleOnly) rows = rows.filter((r) => r.price != null);
  if (coll.trait) {
    const [tt, tv] = coll.trait.split('=');
    rows = rows.filter((r) => (r.it.traits || []).some((x) => x.trait_type === tt && x.value === tv));
  }
  if (coll.badge) {
    rows = rows.filter((r) => (r.it.badges || []).some((b) => badgeFamily(b) === coll.badge));
  }
  const rank = (r) => (r.it.rank || 1e9);
  const priceKey = (r) => (r.price == null ? Infinity : r.price);
  if (coll.sort === 'price-asc') rows.sort((a, b) => priceKey(a) - priceKey(b) || a.it.number - b.it.number);
  else if (coll.sort === 'price-desc') rows.sort((a, b) => (b.price || -1) - (a.price || -1) || a.it.number - b.it.number);
  else if (coll.sort === 'rank') rows.sort((a, b) => rank(a) - rank(b));
  else rows.sort((a, b) => a.it.number - b.it.number);

  if (!rows.length) { grid.innerHTML = '<div class="empty">No items match this filter.</div>'; return; }
  grid.innerHTML = '';
  rows.forEach(({ it, price, ins }) => {
    const c = document.createElement('div');
    c.className = 'coll-card' + (ins ? ' clickable' : '');
    const xvg = price != null ? price / MKT_COIN : null;
    const media = ins ? `<img src="/api/content/${esc(ins.txid)}" loading="lazy" alt="" />` : '<div class="blob">✦</div>';
    const topBadge = (it.badges || [])[0];
    const badgePill = topBadge ? `<span class="coll-badge-pill ${badgeClass(topBadge)}">${esc(topBadge)}</span>` : '';
    c.innerHTML = `
      <div class="coll-media">${media}<span class="coll-rank">#${it.rank}</span>${badgePill}</div>
      <div class="coll-cbody">
        <div class="coll-cnum">Verginals #${it.number}</div>
        ${xvg != null ? `<div class="coll-cprice">${fmt(xvg)} XVG</div>` : '<div class="coll-cunlisted">Not listed</div>'}
      </div>`;
    if (ins) c.addEventListener('click', () => openDetail(ins));
    grid.appendChild(c);
  });
}

async function renderCollActivity() {
  const box = $('#coll-activity');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { activity } = await api('/api/collection/activity?limit=50');
    if (!activity || !activity.length) { box.innerHTML = '<div class="empty">No activity yet. Sales and listings will show here.</div>'; return; }
    box.innerHTML = '';
    // Built as elements rather than as a string, because the two things in a row that somebody
    // wants to click are the Verginal and the wallet, and both need a handler.
    //
    // A row was previously a dead end: it named a Verginal you could not open and a wallet you
    // could not look at, which is the only two questions anybody has about a sale.
    const item = (n) => {
      const label = n != null ? `Verginals #${n}` : 'Verginal';
      const ins = n != null ? coll.insByNum.get(n) : null;
      // Only clickable once the index knows where that inscription is. During a rescan it is plain
      // text rather than a link that goes nowhere.
      if (!ins) {
        const span = document.createElement('span');
        span.className = 'ca-item';
        span.textContent = label;
        return span;
      }
      const a = document.createElement('a');
      a.className = 'ca-item ca-link';
      a.href = '#';
      a.textContent = label;
      a.addEventListener('click', (e) => { e.preventDefault(); openDetail(ins); });
      return a;
    };
    const wallet = (addr) => {
      const a = document.createElement('a');
      a.className = 'ca-addr ca-link';
      a.href = '/gallery/' + encodeURIComponent(addr || '');
      a.title = addr || '';
      a.textContent = short(addr);
      a.addEventListener('click', (e) => { e.preventDefault(); showOwnerGallery(addr); });
      return a;
    };

    activity.forEach((a) => {
      const xvg = a.priceUnits / MKT_COIN;
      const row = document.createElement('div');
      row.className = 'coll-act';

      const type = document.createElement('span');
      type.className = `ca-type ca-${a.type}`;
      type.textContent = a.type === 'sale' ? 'Sale' : 'Listed';

      const price = document.createElement('span');
      price.className = 'ca-price';
      price.textContent = `${fmt(xvg)} XVG`;

      const who = document.createElement('span');
      who.className = 'ca-who';
      if (a.type === 'sale') {
        who.append(wallet(a.sellerAddress), document.createTextNode(' \u2192 '), wallet(a.buyerAddress));
      } else {
        who.append(document.createTextNode('by '), wallet(a.sellerAddress));
      }

      const time = document.createElement('span');
      time.className = 'ca-time';
      time.textContent = collAgo(a.at);

      row.append(type, item(a.collectionNumber), price, who, time);
      box.appendChild(row);
    });
  } catch (e) {
    box.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

function bindCollControls() {
  coll.bound = true;
  document.querySelectorAll('#panel-collection .subtab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#panel-collection .subtab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    coll.view = b.dataset.cview;
    renderCollView();
  }));
  $('#coll-sort').addEventListener('change', (e) => { coll.sort = e.target.value; renderCollItems(); });
  $('#coll-trait').addEventListener('change', (e) => { coll.trait = e.target.value; renderCollItems(); });
  $('#coll-badge').addEventListener('change', (e) => { coll.badge = e.target.value; renderCollItems(); });
  $('#coll-forsale').addEventListener('change', (e) => { coll.forSaleOnly = e.target.checked; renderCollItems(); });
}

/** The badge family of a badge string ("Prismatic Grey" -> "Prismatic"). */
function badgeFamily(b) {
  if (b.startsWith('Double Rainbow')) return 'Double Rainbow';
  if (b.startsWith('Perfect')) return 'Perfect Pair';
  return b.split(' ')[0]; // Prismatic, Chromatic
}

/** CSS class for a badge's look, by family. */
function badgeClass(b) {
  const f = badgeFamily(b);
  if (f === 'Double Rainbow') return 'b-rainbow';
  if (f === 'Prismatic') return 'b-prism';
  if (f === 'Monochrome') return 'b-mono';
  if (f === 'Duotone') return 'b-duo';
  if (f === 'Tailored') return 'b-tailored';
  if (f === 'Camouflage') return 'b-camo';
  if (f === 'Perfect Pair') return 'b-pair';
  return 'b-chroma';
}

// Display order for badge filters and chips: rarest / most prestigious first.
const BADGE_ORDER = ['Double Rainbow', 'Prismatic', 'Monochrome', 'Duotone', 'Perfect Pair', 'Chromatic', 'Tailored', 'Camouflage'];

/** Build the badge filter dropdown from the badges present on the loaded items. */
function buildBadgeFilter() {
  const sel = $('#coll-badge');
  if (!sel) return;
  const counts = new Map();
  coll.items.forEach((it) => (it.badges || []).forEach((b) => {
    const f = badgeFamily(b);
    counts.set(f, (counts.get(f) || 0) + 1);
  }));
  const present = BADGE_ORDER.filter((f) => counts.has(f));
  let html = '<option value="">All badges</option>';
  present.forEach((f) => { html += `<option value="${esc(f)}">${esc(f)} (${counts.get(f)})</option>`; });
  sel.innerHTML = html;
  sel.value = coll.badge || '';
  sel.classList.toggle('hidden', present.length === 0);
}

// --- "show mine" owner filter (a shareable holder gallery: /gallery/<address>) ------------
function showOwnerGallery(addr, push = true) {
  ownerFilter = addr;
  traitFilter = null;
  $('#owner-input').value = addr;
  $('#btn-allins').classList.remove('hidden');
  const shareBtn = $('#btn-share-gallery');
  shareBtn.classList.remove('hidden');
  const shareUrl = 'https://verginals.com/gallery/' + addr;
  shareBtn.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent('My Verginals, inscribed forever on the Verge blockchain ⚡') + '&url=' + encodeURIComponent(shareUrl);
  if (push) history.pushState({ gallery: addr }, '', '/gallery/' + addr);
  activateTab('explore');
  loadInscriptions();
}

function applyOwnerFilter() {
  const addr = $('#owner-input').value.trim();
  if (!addr) return;
  showOwnerGallery(addr);
}
$('#btn-mine').addEventListener('click', applyOwnerFilter);
$('#owner-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyOwnerFilter(); });
$('#btn-allins').addEventListener('click', () => {
  ownerFilter = null;
  $('#owner-input').value = '';
  $('#btn-allins').classList.add('hidden');
  $('#btn-share-gallery').classList.add('hidden');
  if (/^\/gallery\//.test(location.pathname)) history.pushState({}, '', '/');
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
    $('#tab-stats').classList.remove('hidden'); // stats need the collection endpoints
    // The headline is the collection's pitch and is written in the page, not here: the supply is
    // fixed at 3,333 and has been since before the first mint. Only the moving figures move.
    $('#mint-minted').textContent = fmt(s.minted);
    // LEFT, not the total. The label above it says Left, and the two were the same element until
    // the front door was rebuilt, which is exactly how a figure ends up under the wrong word.
    $('#mint-supply').textContent = fmt(s.remaining);
    const pct = s.supply ? Math.min(100, (s.minted / s.supply) * 100) : 0;
    $('#mint-bar').style.width = pct.toFixed(2) + '%';
    $('#mint-fair').innerHTML =
      `Committed draw · commitment <code>${short(s.commitment)}</code>` +
      (s.revealed && s.seed ? ` · seed revealed <code>${short(s.seed)}</code>` : '');
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

/**
 * The reveal.
 *
 * Ordered on purpose: the seal breaks, the art lands alone with nothing drawn over it, and the
 * facts follow a beat later. A card that arrives complete is a database row. A card that arrives in
 * that order is somebody opening something, and this is the one moment on the site that is supposed
 * to feel like anything at all.
 *
 * Everything after the image is best-effort. The rank needs another request and the House is read
 * off the traits, so both are added when they arrive and simply omitted when they do not: a reveal
 * that waits for a rarity lookup before showing somebody their own art has its priorities backwards.
 */
function revealVerginal(v, j) {
  if (!v) return;
  const stage = $('#rv-stage');
  const chrome = $('#reveal-back');

  const img = document.createElement('img');
  img.className = 'rv-art';
  img.alt = v.name || ('Verginal #' + v.number);
  img.src = v.imageUrl;

  const land = () => {
    stage.innerHTML = '';
    stage.append(img);
    $('#reveal-box').classList.add('is-open');
    // The beat. Long enough to read as a sequence, short enough that nobody waits for it.
    setTimeout(() => chrome.classList.add('is-in'), 420);
  };
  // Wait for the bytes, but never for long: a seal that will not break is worse than a plain cut.
  if (img.complete) land();
  else {
    img.addEventListener('load', land, { once: true });
    img.addEventListener('error', land, { once: true });
    setTimeout(land, 2500);
  }

  const house = (v.attributes || []).find((a) => /house/i.test(a.trait_type || ''));
  chrome.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'rv-head';
  const name = document.createElement('h3');
  name.className = 'vg-d3';
  // The name already carries the number: the collection stores "Verginals #1", so appending it
  // again read "Verginals #1 #1" on the one screen somebody actually looks at.
  name.textContent = v.name || ('Verginals #' + v.number);
  head.append(name);
  if (house) {
    const chip = document.createElement('span');
    chip.className = 'vg-chip rv-house ' + String(house.value).toLowerCase();
    chip.textContent = 'House of ' + house.value;
    head.append(chip);
  }
  chrome.append(head);

  const facts = document.createElement('div');
  facts.className = 'rv-facts';
  const fact = (label, value, cls) => {
    const d = document.createElement('div');
    d.className = 'vg-stat';
    const l = document.createElement('span'); l.className = 'vg-label'; l.textContent = label;
    const b = document.createElement('b'); b.className = 'rv-fact ' + (cls || ''); b.textContent = value;
    d.append(l, b);
    facts.append(d);
    return b;
  };
  const rankEl = fact('Rank', '...', 'vg-num');
  const scoreEl = fact('Score', '...', 'vg-num');
  chrome.append(facts);

  api('/api/collection/rarity/' + v.number).then((r) => {
    if (!r || r.rank == null) throw new Error('no rank');
    rankEl.textContent = fmt(r.rank);
    const of = document.createElement('span');
    of.className = 'rv-of';
    of.textContent = ' / ' + fmt(r.supply);
    rankEl.append(of);
    scoreEl.textContent = r.score != null ? fmt(r.score) : '-';
  }).catch(() => {
    // Omitted rather than shown as zero. A rank of nought would be a lie about a real object.
    rankEl.closest('.vg-stat').remove();
    scoreEl.closest('.vg-stat').remove();
  });

  const acts = document.createElement('div');
  acts.className = 'rv-acts';
  const arena = document.createElement('a');
  arena.className = 'vg-btn primary'; arena.href = '/arena'; arena.textContent = 'Enter the Arena';
  const again = document.createElement('button');
  again.type = 'button'; again.className = 'vg-btn'; again.textContent = 'Mint another';
  again.addEventListener('click', () => $('#btn-mint-again').click());
  acts.append(arena, again);
  chrome.append(acts);

  const prov = document.createElement('p');
  prov.className = 'rv-prov';
  prov.textContent = 'Drawn by the commitment published before the first mint. Nobody steered it.';
  const tx = document.createElement('span');
  tx.className = 'rv-tx';
  tx.textContent = ' reveal ' + short(j.revealTxid);
  prov.append(tx);
  chrome.append(prov);
}

$('#btn-mint-again').addEventListener('click', () => {
  mintJob = null;
  pendingVerginal = null;
  $('#mint-active').classList.add('hidden');
  $('#mint-form').classList.remove('hidden');
  $('#mint-address').focus();
});

// --- stats tab (collection stats, rarity leaderboard, trait distribution) -----------------
let statsLoaded = false;
async function loadStats() {
  if (statsLoaded) return;
  try {
    const [status, board, mintedBoard, rarity, inscriptions] = await Promise.all([
      api('/api/mint/status'),
      api('/api/collection/leaderboard?limit=10'),
      api('/api/collection/leaderboard?limit=10&minted=1'),
      api('/api/collection/rarity'),
      api('/api/inscriptions'),
    ]);
    statsLoaded = true;

    // headline numbers (collection mints only: text and free-form inscriptions are not holders)
    const holders = new Set(inscriptions.inscriptions.filter((i) => i.collectionNumber != null && !i.collectionSlug && i.ownerAddress).map((i) => i.ownerAddress)).size;
    const cells = [
      [fmt(status.minted), 'minted'],
      [fmt(status.remaining), 'left to mint'],
      [fmt(holders), 'holder' + (holders === 1 ? '' : 's')],
    ];
    if (status.promo && status.promo.active) cells.push([fmt(status.promo.remaining), 'free mints left 🎁']);
    $('#stats-summary').innerHTML = cells.map(([v, k]) => `<div class="kv"><b>${v}</b><span>${k}</span></div>`).join('');

    // Two boards. "Rarest minted" celebrates real mints (global ranks, minted only), so it has
    // content from mint one even while the overall top is all sealed. "Still sealed" teases the
    // vault: the rarest of all stays a mystery anyone could pull with the next mint.
    const lbRow = (e) => {
      const img = e.minted
        ? `<img src="/api/collection/image/${e.number}" alt="${esc(e.name)}" loading="lazy" />`
        : '<span class="lb-mystery">?</span>';
      const label = e.minted ? esc(e.name) : 'Still sealed in the vault';
      const link = e.minted ? ` data-open="${e.number}"` : '';
      return `<div class="lb-row${e.minted ? ' lb-minted clickable' : ''}"${link}>
        <span class="lb-rank">#${e.rank}</span>
        <span class="lb-thumb">${img}</span>
        <span class="lb-name">${label}</span>
        <span class="lb-score">${fmt(e.score)}</span>
      </div>`;
    };
    const lbHead = `<div class="lb-row lb-head" aria-hidden="true">
      <span class="lb-rank">Rank</span><span></span><span class="lb-name"></span><span class="lb-score">Rarity score</span>
    </div>`;
    const sealedTop = board.top.filter((e) => !e.minted).slice(0, 5);
    const mintedHtml = mintedBoard.top.length
      ? lbHead + mintedBoard.top.map(lbRow).join('')
      : '<div class="empty">No ranked mints yet. The first mint takes this board.</div>';
    const rarestSealed = sealedTop.length && sealedTop[0].rank === 1;
    $('#stats-leaderboard').innerHTML =
      `<h3 class="lb-h">Rarest minted so far</h3>${mintedHtml}` +
      (sealedTop.length
        ? `<h3 class="lb-h">Still sealed 👀</h3>
           <p class="hint">${rarestSealed ? 'The single rarest Verginal of all 3,333 has not been minted yet. The committed-random draw means the next mint could be the one.' : 'Some of the very rarest are still waiting in the vault.'}</p>
           ${lbHead}${sealedTop.map(lbRow).join('')}`
        : '');
    $$('#stats-leaderboard [data-open]').forEach((row) => row.addEventListener('click', async () => {
      const list = lastList.length ? lastList : await loadInscriptions();
      // Leaderboard entries are COLLECTION numbers; match on that, never the inscription counter.
      const ins = list.find((i) => i.collectionNumber != null && String(i.collectionNumber) === row.dataset.open);
      if (ins) openDetail(ins);
    }));

    // combo badges: clickable chips that jump to the collection filtered by that badge
    const bd = rarity.badges || {};
    const chips = BADGE_ORDER.filter((f) => bd[f]).map((f) =>
      `<button class="badge-chip ${badgeClass(f)}" data-badge="${esc(f)}">${esc(f)}<span class="bc-count">${bd[f]}</span></button>`).join('');
    $('#stats-badges').innerHTML = chips || '<div class="empty">No combo badges yet.</div>';
    $$('#stats-badges .badge-chip').forEach((c) => c.addEventListener('click', () => setBadgeFilter(c.dataset.badge)));

    // trait distribution, one collapsible block per trait type
    $('#stats-traits').innerHTML = rarity.traits.map((t) => `
      <details class="tdist">
        <summary>${esc(t.trait_type)} <span class="hint">(${t.values.length} values)</span></summary>
        ${t.values.map((v) => `
          <div class="tdist-row" data-type="${esc(t.trait_type)}" data-value="${esc(v.value)}">
            <span class="tdist-name">${esc(v.value)}</span>
            <span class="tdist-bar"><i style="width:${Math.max(1, v.pct)}%"></i></span>
            <span class="tdist-pct">${v.pct}% · ${fmt(v.count)}</span>
          </div>`).join('')}
      </details>`).join('');
    $$('#stats-traits .tdist-row').forEach((row) => row.addEventListener('click', () =>
      setTraitFilter(row.dataset.type, row.dataset.value)));
  } catch (e) {
    $('#stats-summary').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

// --- rarity lookup (stats tab): rank + score for any collection number ---------------------
async function checkRarity() {
  const box = $('#rarity-result');
  const n = Number($('#rarity-num').value);
  if (!Number.isInteger(n) || n < 1) { box.innerHTML = '<div class="error">Enter a collection number.</div>'; return; }
  box.innerHTML = '<div class="empty">Checking…</div>';
  try {
    const r = await api('/api/collection/rarity/' + n);
    if (r.minted) {
      const traits = r.traits.map((t) =>
        `<span class="trait"><b>${esc(t.trait_type)}</b>${esc(t.value)}<i class="pct">${t.pct}%</i></span>`).join('');
      box.innerHTML = `
        <div class="lookup-hit">
          <img src="/api/collection/image/${n}" alt="${esc(r.name)}" />
          <div>
            <div class="num">${esc(r.name)} <span class="badge ok">minted</span></div>
            <div class="detail-rank">Rarity rank <b>#${fmt(r.rank)}</b> of ${fmt(r.supply)} · score <b>${fmt(r.score)}</b></div>
            <div class="traits">${traits}</div>
            <button class="link" id="rarity-open" type="button">open its full page →</button>
          </div>
        </div>`;
      $('#rarity-open').addEventListener('click', () => openDetailByKey(String(n)));
    } else {
      box.innerHTML = `
        <div class="lookup-hit">
          <span class="lb-mystery lookup-mystery">?</span>
          <div>
            <div class="num">Verginal #${fmt(n)} <span class="badge pending">still sealed</span></div>
            <div class="detail-rank">Rarity rank <b>#${fmt(r.rank)}</b> of ${fmt(r.supply)} · score <b>${fmt(r.score)}</b></div>
            <div class="hint">Not minted yet: its image and traits stay sealed in the vault. The committed-random draw decides who gets it.</div>
          </div>
        </div>`;
    }
  } catch (e) {
    box.innerHTML = `<div class="error">✗ ${esc(e.message)}</div>`;
  }
}
$('#rarity-check').addEventListener('click', checkRarity);
$('#rarity-num').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkRarity(); });

// --- latest inscriptions strip (inscribe panel) --------------------------------------------
async function loadLatestStrip() {
  try {
    const data = await api('/api/inscriptions');
    const latest = data.inscriptions.filter((i) => i.status !== 'pending').slice(-4).reverse();
    if (!latest.length) return;
    const holder = $('#latest-items');
    holder.innerHTML = '';
    latest.forEach((ins) => {
      const b = document.createElement('button');
      b.className = 'latest-item';
      b.type = 'button';
      const label = ins.collectionNumber != null ? `#${ins.collectionNumber}`
        : (ins.number != null ? `#${ins.number}` : (ins.contentType || '').split(';')[0] || 'inscription');
      b.innerHTML = (ins.contentType || '').startsWith('image/')
        ? `<img src="/api/content/${esc(ins.txid)}" alt="" loading="lazy" /><span>${esc(label)}</span>`
        : `<span class="latest-ico">✍️</span><span>${esc(label)}</span>`;
      b.addEventListener('click', () => { lastList.length ? openDetail(ins) : openDetailByKey(detailKey(ins)); });
      holder.appendChild(b);
    });
    $('#latest-strip').classList.remove('hidden');
  } catch (_) { /* cosmetic: no strip if the API is unavailable */ }
}

// --- launchpad: browse + mint community collections ----------------------------------------
let lpSlug = null;
let lpJob = null;
let lpPollTimer = null;
let lpPending = null; // the assigned item, revealed when payment confirms

async function loadLaunchpad() {
  const g = $('#lp-list');
  try {
    const data = await api('/api/launchpad');
    if (!data.collections.length) {
      g.innerHTML = '<div class="empty">No community collections live yet. Yours could be the first: submit it below. 🚀</div>';
      return;
    }
    g.innerHTML = '';
    data.collections.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'lp-card clickable';
      const pct = c.supply ? Math.min(100, (c.minted / c.supply) * 100) : 0;
      el.innerHTML = `
        <img src="/api/launchpad/${esc(c.slug)}/image/1" alt="${esc(c.name)}" loading="lazy" />
        <div class="lp-card-body">
          <div class="num">${esc(c.name)} ${c.soldOut ? '<span class="badge ok">sold out</span>' : ''}</div>
          <div class="hint">${esc(c.creator ? 'by ' + c.creator : '')}</div>
          <div class="mint-progress"><div class="mint-bar" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="hint">${fmt(c.minted)} / ${fmt(c.supply)} minted</div>
        </div>`;
      el.addEventListener('click', () => openLaunchpadCollection(c.slug));
      g.appendChild(el);
    });
  } catch (e) {
    g.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

async function openLaunchpadCollection(slug, push = true) {
  try {
    const s = await api('/api/launchpad/' + slug + '/status');
    lpSlug = slug;
    $('#lp-mint-card').classList.remove('hidden');
    $('#lp-cover').src = `/api/launchpad/${slug}/image/1`;
    $('#lp-name').textContent = s.name;
    $('#lp-desc').textContent = s.description || '';
    $('#lp-byline').textContent = s.creator ? 'by ' + s.creator : '';
    const pct = s.supply ? Math.min(100, (s.minted / s.supply) * 100) : 0;
    $('#lp-bar').style.width = pct.toFixed(1) + '%';
    $('#lp-count').textContent = `${fmt(s.minted)} / ${fmt(s.supply)} minted · ${fmt(s.remaining)} left`;
    $('#lp-fair').innerHTML = `Provably fair · commitment <code>${esc(short(s.commitment))}</code> · images stay sealed until minted`;
    $('#lp-form').classList.toggle('hidden', !!s.soldOut);
    $('#lp-soldout').classList.toggle('hidden', !s.soldOut);
    $('#lp-active').classList.add('hidden');
    $('#lp-error').textContent = '';
    if (push) history.pushState({ lp: slug }, '', '/launchpad/' + slug);
    $('#lp-mint-card').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    $('#lp-list').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

$('#lp-back').addEventListener('click', () => {
  $('#lp-mint-card').classList.add('hidden');
  lpSlug = null;
  if (/^\/launchpad\//.test(location.pathname)) history.pushState({}, '', '/launchpad');
});

$('#lp-mint-btn').addEventListener('click', async () => {
  $('#lp-error').textContent = '';
  const to = $('#lp-address').value.trim();
  if (!to) { $('#lp-error').textContent = '✗ Enter the Verge address where your mint should live.'; return; }
  if (!(await requireConsent())) return;
  const btn = $('#lp-mint-btn');
  btn.disabled = true; btn.textContent = 'Reserving…';
  try {
    const r = await api('/api/launchpad/' + lpSlug + '/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
    if (r.soldOut) { $('#lp-form').classList.add('hidden'); $('#lp-soldout').classList.remove('hidden'); return; }
    renderLpPayment(r);
  } catch (e) {
    $('#lp-error').textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Mint a random one →';
  }
});

function renderLpPayment(r) {
  lpJob = r.jobId;
  lpPending = r.verginal;
  $('#lp-active').classList.remove('hidden');
  $('#lp-payblock').classList.remove('hidden');
  $('#lp-reveal').classList.add('hidden');
  $('#lp-reveal').innerHTML = '';
  $('#lp-again').classList.add('hidden');
  $('#lp-pay-error').textContent = '';
  $('#lp-paystatus').classList.remove('hidden');

  $('#lp-amount').textContent = fmt(r.totalXVG) + ' XVG';
  $('#lp-pay-address').textContent = r.depositAddress;
  $('#lp-uri').href = r.paymentURI;
  const b = r.breakdown;
  const rows = [
    ['Total to send', fmt(r.totalXVG) + ' XVG'],
    ['Returned to you', fmt(b.carrierReturnedXVG) + ' XVG'],
    ['Net cost', fmt(b.netCostXVG) + ' XVG'],
  ];
  $('#lp-summary').innerHTML = rows.map(([k, v]) => `<div class="kv"><b>${v}</b><span>${k}</span></div>`).join('');
  const holder = $('#lp-qrcode');
  holder.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(r.paymentURI);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch (_) {
    holder.innerHTML = '<div class="hint">(QR unavailable, copy the address)</div>';
  }
  $('#lp-paystatus-text').textContent = `Waiting for your payment of ${fmt(r.totalXVG)} XVG…`;
  $('#lp-active').scrollIntoView({ behavior: 'smooth' });
  startLpPolling();
}

function startLpPolling() {
  if (lpPollTimer) clearInterval(lpPollTimer);
  const id = lpJob;
  lpPollTimer = setInterval(async () => {
    if (lpJob !== id) return clearInterval(lpPollTimer);
    try {
      const j = await api('/api/job/' + id);
      if (j.status === 'awaiting_payment') {
        const got = j.receivedXVG != null ? fmt(j.receivedXVG) : '0';
        $('#lp-paystatus-text').textContent = `Waiting for your payment… (received ${got} / ${fmt(j.totalXVG)} XVG)`;
      } else if (j.status === 'funding') {
        $('#lp-paystatus-text').textContent = 'Payment detected: inscribing & broadcasting your mint…';
      } else if (j.status === 'done') {
        clearInterval(lpPollTimer);
        lpDone(j);
      } else if (j.status === 'error') {
        clearInterval(lpPollTimer);
        $('#lp-paystatus').classList.add('hidden');
        $('#lp-pay-error').textContent = '✗ ' + (j.error || 'something went wrong');
      }
    } catch (e) {
      $('#lp-pay-error').textContent = '✗ ' + e.message;
    }
  }, 2500);
}

function lpDone(j) {
  $('#lp-paystatus').classList.add('hidden');
  $('#lp-payblock').classList.add('hidden');
  const v = lpPending;
  if (v) {
    const traits = (v.attributes || [])
      .map((a) => `<span class="trait"><b>${esc(a.trait_type)}</b>${esc(a.value)}</span>`).join('');
    $('#lp-reveal').innerHTML = `
      <img src="${esc(v.imageUrl)}" alt="${esc(v.name)}" />
      <div class="reveal-info">
        <div class="reveal-name">${esc(v.name)} <span class="badge ok">#${esc(v.number)}</span></div>
        <div class="traits">${traits}</div>
        <div class="hint">reveal txid: <code>${esc(short(j.revealTxid))}</code></div>
      </div>`;
    $('#lp-reveal').classList.remove('hidden');
  }
  $('#lp-again').classList.remove('hidden');
  if (lpSlug) openLaunchpadCollection(lpSlug, false); // refresh the counter
  loadLaunchpad();
}

$('#lp-again').addEventListener('click', () => {
  lpJob = null;
  lpPending = null;
  $('#lp-active').classList.add('hidden');
});

// --- launchpad: creator submission wizard ---------------------------------------------------
let lpsFileList = [];
const lpsDz = $('#lps-dropzone');
const lpsFi = $('#lps-files');
lpsDz.addEventListener('click', () => lpsFi.click());
lpsDz.addEventListener('dragover', (e) => { e.preventDefault(); lpsDz.classList.add('drag'); });
lpsDz.addEventListener('dragleave', () => lpsDz.classList.remove('drag'));
lpsDz.addEventListener('drop', (e) => { e.preventDefault(); lpsDz.classList.remove('drag'); lpsSetFiles([...e.dataTransfer.files]); });
lpsFi.addEventListener('change', () => lpsSetFiles([...lpsFi.files]));

function lpsSetFiles(files) {
  lpsFileList = files.filter((f) => /\.(png|webp|jpe?g|gif)$/i.test(f.name));
  const filled = $('#lps-drop-filled');
  if (!lpsFileList.length) {
    filled.classList.add('hidden');
    $('#lps-drop-empty').classList.remove('hidden');
    return;
  }
  $('#lps-drop-empty').classList.add('hidden');
  filled.classList.remove('hidden');
  const totalKB = Math.round(lpsFileList.reduce((s, f) => s + f.size, 0) / 1024);
  filled.innerHTML = `<strong>${lpsFileList.length} image${lpsFileList.length > 1 ? 's' : ''}</strong> · ${fmt(totalKB)} KB total<br>
    <span class="hint">${lpsFileList.slice(0, 3).map((f) => esc(f.name)).join(', ')}${lpsFileList.length > 3 ? '…' : ''} · <u>click to change</u></span>`;
}

function parseCsvManifest(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('the CSV needs a header row and at least one item row');
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((s) => s.trim());
    const rec = { filename: cols[0], name: cols[1] || '', attributes: [] };
    for (let i = 2; i < head.length; i++) {
      if (head[i] && cols[i]) rec.attributes.push({ trait_type: head[i], value: cols[i] });
    }
    return rec;
  });
}

async function readManifestFile(file) {
  const text = await file.text();
  const recs = /\.csv$/i.test(file.name) ? parseCsvManifest(text) : JSON.parse(text);
  if (!Array.isArray(recs)) throw new Error('the JSON manifest must be an array');
  const byName = new Map();
  for (const r of recs) {
    if (r && r.filename) byName.set(String(r.filename), { name: r.name, attributes: r.attributes });
  }
  return byName;
}

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const rd = new FileReader();
  rd.onload = () => resolve(String(rd.result).split(',')[1]);
  rd.onerror = () => reject(new Error('could not read ' + file.name));
  rd.readAsDataURL(file);
});

$('#lps-submit').addEventListener('click', async () => {
  const err = $('#lps-error');
  const ok = $('#lps-success');
  err.textContent = '';
  ok.classList.add('hidden');
  const name = $('#lps-name').value.trim();
  if (!name) { err.textContent = '✗ Give your collection a name.'; return; }
  if (!lpsFileList.length) { err.textContent = '✗ Choose your images.'; return; }
  if (lpsFileList.length > 10000) { err.textContent = '✗ Max 10,000 items.'; return; }
  const tooBig = lpsFileList.find((f) => f.size > 60 * 1024);
  if (tooBig) { err.textContent = `✗ ${tooBig.name} is over 60 KB.`; return; }
  if (!(await requireConsent())) return;

  const btn = $('#lps-submit');
  btn.disabled = true;
  const prog = $('#lps-progress');
  const bar = $('#lps-bar');
  const ptext = $('#lps-progress-text');
  prog.classList.remove('hidden');
  try {
    let manifest = new Map();
    const mf = $('#lps-manifest').files[0];
    if (mf) manifest = await readManifestFile(mf);

    const draft = await api('/api/launchpad/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, creator: $('#lps-creator').value.trim(), description: $('#lps-desc').value.trim() }),
    });

    let sent = 0;
    for (let i = 0; i < lpsFileList.length; i += 50) {
      const batch = lpsFileList.slice(i, i + 50);
      const items = [];
      for (const f of batch) {
        const extra = manifest.get(f.name) || {};
        items.push({ filename: f.name, dataBase64: await fileToBase64(f), name: extra.name, attributes: extra.attributes });
      }
      await api('/api/launchpad/submit/' + draft.id + '/items', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
      });
      sent += batch.length;
      bar.style.width = ((sent / lpsFileList.length) * 100).toFixed(1) + '%';
      ptext.textContent = `uploading ${sent} / ${lpsFileList.length}`;
    }
    await api('/api/launchpad/submit/' + draft.id + '/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ok.innerHTML = `✅ <strong>Submitted for review.</strong> Your collection "${esc(name)}" (${lpsFileList.length} items) is in the queue.
      Reference id: <code>${esc(draft.id)}</code>. It goes live on this page once approved.`;
    ok.classList.remove('hidden');
    lpsSetFiles([]);
    $('#lps-name').value = ''; $('#lps-desc').value = ''; $('#lps-creator').value = ''; $('#lps-manifest').value = '';
  } catch (e) {
    err.textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false;
    prog.classList.add('hidden');
    bar.style.width = '0%';
  }
});

// --- copy buttons ------------------------------------------------------------------------
wireCopy('#copy-amount', () => String($('#pay-amount').textContent).replace(/[^\d.]/g, ''));
wireCopy('#copy-address', () => $('#pay-address').textContent);
wireCopy('#mint-copy-amount', () => String($('#mint-amount').textContent).replace(/[^\d.]/g, ''));
wireCopy('#mint-copy-address', () => $('#mint-pay-address').textContent);
wireCopy('#lp-copy-amount', () => String($('#lp-amount').textContent).replace(/[^\d.]/g, ''));
wireCopy('#lp-copy-address', () => $('#lp-pay-address').textContent);
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
wireWalletLink('lp-uri');

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

// --- the front door -------------------------------------------------------------------------
//
// Everything on the home panel that is a number comes from the chain, and everything that is a
// picture is an Alpha somebody already owns. Nothing here is illustration and nothing is a claim
// about what the site can do: it is the site, counted.
//
// Every request is allowed to fail on its own. A front door that renders nothing because one
// endpoint was slow is worse than one missing a figure, so each block fills in when it can and the
// dashes stay where it cannot.
let homeLoaded = false;

async function loadHome() {
  if (homeLoaded) return;
  homeLoaded = true;

  const figures = $('#hm-figures');
  const rail = $('#hm-rail');
  const coinList = $('#hm-coins');
  if (!figures) return;

  const stat = (label, value, sub) => {
    const d = document.createElement('div');
    d.className = 'vg-stat';
    const l = document.createElement('span'); l.className = 'vg-label'; l.textContent = label;
    const b = document.createElement('b'); b.className = 'vg-num'; b.textContent = value;
    d.append(l, b);
    if (sub) { const x = document.createElement('span'); x.className = 'vg-stat-sub'; x.textContent = sub; d.append(x); }
    figures.append(d);
    return d;
  };
  const say = (key, node) => {
    const slot = document.querySelector(`[data-hm-stat="${key}"]`);
    if (slot) { slot.textContent = ''; slot.append(node); }
  };
  const bold = (n, tail) => {
    const f = document.createDocumentFragment();
    const b = document.createElement('b'); b.textContent = n;
    f.append(b, document.createTextNode(' ' + tail));
    return f;
  };

  const [ins, mint, coins, listings] = await Promise.all([
    api('/api/inscriptions').catch(() => null),
    api('/api/mint/status').catch(() => null),
    api('/api/runes/coins').catch(() => null),
    api('/api/market/listings').catch(() => null),
  ]);

  // --- the band of figures ---------------------------------------------------------------------
  const items = (ins && ins.inscriptions) || [];
  const holders = new Set(items.filter((i) => i.ownerAddress).map((i) => i.ownerAddress)).size;
  const forSale = (listings && listings.listings) || [];
  const allCoins = (coins && coins.coins) || [];
  const openMints = allCoins.filter((c) => c.mint && c.mint.open).length;
  const coinAsks = allCoins.reduce((n, c) => n + ((c.market && c.market.asks) || 0), 0);

  figures.textContent = '';
  if (ins) stat('Inscribed', fmt(ins.count), 'on Verge, for ever');
  if (mint) stat('Alphas minted', fmt(mint.minted), `of ${fmt(mint.supply)}`);
  if (coins) stat('Coins etched', fmt(allCoins.length), openMints ? `${openMints} open to claim` : 'by the community');
  if (holders) stat('Wallets holding', fmt(holders), 'one or more');
  if (ins) stat('Indexed to block', fmt(ins.indexedThrough), ins.indexReady ? 'up to date' : 'still reading');

  // --- what each capability is worth saying right now --------------------------------------------
  if (mint) say('mint', bold(fmt(mint.remaining), 'still unminted'));
  if (ins) say('ins', bold(fmt(ins.count), 'written so far'));
  if (coins) say('coins', bold(fmt(allCoins.length), allCoins.length === 1 ? 'coin exists' : 'coins exist'));
  if (coins) say('open', bold(fmt(openMints), openMints === 1 ? 'coin is open' : 'coins are open'));
  if (listings || coins) say('listed', bold(fmt(forSale.length + coinAsks), 'offers on the book'));
  say('arena', bold(fmt(items.filter((i) => i.collectionNumber != null).length), 'possible fighters'));

  // --- the rail ------------------------------------------------------------------------------------
  // Written twice, because the marquee translates by exactly half its width to loop seamlessly.
  if (rail) {
    const nums = items.filter((i) => i.collectionNumber != null).map((i) => i.collectionNumber);
    const pick = (nums.length >= 12 ? nums.sort(() => Math.random() - 0.5).slice(0, 14)
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    rail.textContent = '';
    for (const run of [0, 1]) {
      for (const n of pick) {
        const img = document.createElement('img');
        img.src = '/api/collection/image/' + n;
        img.alt = run === 0 ? 'Verginals #' + n : '';
        if (run === 1) img.setAttribute('aria-hidden', 'true');
        img.loading = 'lazy';
        img.decoding = 'async';
        rail.append(img);
      }
    }
  }

  // --- the coins ------------------------------------------------------------------------------------
  if (coinList && allCoins.length) {
    // Same ordering the market itself uses: what somebody can act on, before what happens to be new.
    const live = (c) => (c.market.asks > 0 ? 3 : (c.mint && c.mint.open ? 2 : (c.carriers > 1 ? 1 : 0)));
    const top = [...allCoins]
      .sort((a, b) => live(b) - live(a) || b.carriers - a.carriers || b.etchedAtHeight - a.etchedAtHeight)
      .slice(0, 6);
    coinList.textContent = '';
    for (const c of top) {
      const a = document.createElement('a');
      a.className = 'hm-coinrow';
      a.href = '/runes/coin?rune=' + encodeURIComponent(c.runeRef);

      const mark = document.createElement('span');
      mark.className = 'hm-coinmark';
      mark.textContent = c.symbol || c.ticker.slice(0, 1);
      const face = homeMark(c.ticker + c.runeRef);
      mark.style.background = face.bg;
      mark.style.color = face.fg;

      const name = document.createElement('span');
      name.className = 'hm-coinname';
      name.textContent = c.display;
      const sub = document.createElement('span');
      sub.className = 'hm-coinsub';
      sub.textContent = c.mint && c.mint.open ? 'open to claim' : `${compactNum(c.whole.supply)} supply`;
      name.append(sub);

      const ask = document.createElement('span');
      const best = c.market.bestAskWhole;
      ask.className = 'hm-coinask' + (best == null ? ' none' : '');
      ask.textContent = best == null ? 'no asks' : fmt(best / 1e6) + ' XVG';

      const held = document.createElement('span');
      held.className = 'hm-coinheld';
      held.textContent = c.carriers + (c.carriers === 1 ? ' holder' : ' holders');

      a.append(mark, name, ask, held);
      coinList.append(a);
    }
  }
}

/** The same identity colour the coin market uses, so a coin looks the same wherever it appears. */
const HOME_MARKS = ['#FD0142', '#7909F9', '#FEC925', '#F18BF6', '#0DF1FF', '#59C54F',
  '#FF4F02', '#DB3FFD', '#03BF99', '#FDED58', '#0098DB',
  // Widened from eleven: fifteen coins over eleven colours put two of the same shade in one
  // short list. These three are also real collection backgrounds, so the set stays one palette.
  '#1F6F52', '#6CE3FF', '#424C6D'];
function homeMark(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const bg = HOME_MARKS[(h >>> 0) % HOME_MARKS.length];
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return { bg, fg: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? '#0b1017' : '#ffffff' };
}

/** Big numbers, short, for a row that has no room for nine digits. */
function compactNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'K';
  return fmt(v);
}

// --- the collection gallery --------------------------------------------------------------
//
// Eight real Alphas, not three on a timer. The old version rotated one image between three
// hard-coded numbers to demonstrate the Houses, which is a fact about the collection that nobody
// mints on, and it did it inside a container that letterboxed a square image into a vertical strip.
//
// These are ones that have actually been inscribed, drawn fresh on every load, so the section is
// evidence rather than an advert: somebody owns each of these.
(function collectionGallery() {
  const grid = $('#gal-grid');
  if (!grid) return;

  const tile = (item) => {
    const li = document.createElement('li');
    li.className = 'gal-tile is-wait';

    const a = document.createElement('a');
    a.href = '#explore';
    a.setAttribute('aria-label', item.name || ('Verginals #' + item.number));

    const img = document.createElement('img');
    img.src = '/api/collection/image/' + item.number;
    // No width/height attributes on purpose. They are presentational hints with a definite height,
    // and a definite height makes the browser ignore aspect-ratio, which is what produced the black
    // bars. The ratio is set in CSS and the box is reserved by it, so nothing jumps either.
    img.alt = item.name || ('Verginals #' + item.number);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => li.classList.remove('is-wait'), { once: true });
    img.addEventListener('error', () => li.classList.remove('is-wait'), { once: true });
    a.append(img);

    const meta = document.createElement('div');
    meta.className = 'gal-meta';
    const num = document.createElement('span');
    num.className = 'gal-num';
    // The name already carries the number. Composing it again is how the reveal came to read
    // "Verginals #1 #1".
    num.textContent = item.name || ('Verginals #' + item.number);
    meta.append(num);
    if (item.rank != null) {
      const rank = document.createElement('span');
      rank.className = 'gal-rank';
      rank.textContent = 'rank ' + fmt(item.rank);
      meta.append(rank);
    }
    a.append(meta);
    li.append(a);
    return li;
  };

  (async () => {
    let items = [];
    try {
      const r = await api('/api/collection/items');
      items = (r && r.items) || [];
    } catch (_) { /* the section is worth showing either way */ }

    // Before anybody has minted there is nothing owned to show, so fall back to the first few of
    // the collection rather than rendering an empty band.
    const pick = items.length
      ? items.sort(() => Math.random() - 0.5).slice(0, 8)
      : [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: n, name: 'Verginals #' + n }));
    grid.textContent = '';
    for (const it of pick) grid.append(tile(it));
  })();
})();

// --- Arena (the game): pick a Verginal, compose a loadout, duel, climb the ladder ------------
const Arena = {
  token: null,
  address: null,
  fighters: [],
  selected: null,
  loadout: { attacks: ['fire', 'fire', 'fire'], poisonRound: 0, potionRound: 1, shieldRound: null },
};
const ARENA_ELEMENTS = ['fire', 'water', 'earth'];
const ELEMENT_ICON = { fire: '🔥', water: '💧', earth: '🌍' };

/** Fetch helper that carries the Arena session token. */
async function arenaApi(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (Arena.token) headers.authorization = 'Bearer ' + Arena.token;
  return api(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
}

/** Obtain a session token: challenge -> sign in the wallet -> session. Cached for the page life. */
async function arenaAuth() {
  if (Arena.token) return Arena.token;
  const A = window.VerginalsArena;
  const address = await A.connect();
  Arena.address = address;
  const ch = await api('/api/game/challenge?address=' + encodeURIComponent(address));
  const signature = await A.signMessage(ch.challenge);
  const r = await api('/api/game/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, nonce: ch.nonce, signature }),
  });
  Arena.token = r.token;
  return Arena.token;
}

async function loadArena() {
  closeBracket(); // re-entering the Arena always shows the play view, not a stale bracket
  loadArenaLadder();
  loadArenaTournaments();
  const A = window.VerginalsArena;
  const gate = $('#arena-gate');
  const fight = $('#arena-fight');
  if (!A || !A.installed()) {
    fight.classList.add('hidden');
    gate.innerHTML = 'Install the <a class="link" href="/verginalswallet" target="_blank" rel="noopener noreferrer">Verginals Wallet</a> and hold at least one Verginal to enter the Arena.';
    return;
  }
  const addr = A.address();
  if (!addr) {
    fight.classList.add('hidden');
    gate.innerHTML = '';
    gate.appendChild(btn('Connect wallet to play', 'primary', async () => {
      try { await arenaAuth(); loadArena(); } catch (e) { gate.append(' ' + e.message); }
    }));
    return;
  }
  Arena.address = addr;
  gate.innerHTML = `Signed in as <code>${esc(short(addr))}</code>`;
  fight.classList.remove('hidden');
  renderLoadout();
  loadArenaFighters();
  loadArenaProfile();
  loadArenaHistory();
}

async function loadArenaFighters() {
  const box = $('#arena-fighters');
  box.innerHTML = '<div class="empty">Loading your Verginals…</div>';
  try {
    const data = await api('/api/inscriptions?owner=' + encodeURIComponent(Arena.address));
    const mine = data.inscriptions.filter((i) => i.collectionNumber != null && i.location && /^[0-9a-f]{64}:\d+$/.test(i.location));
    Arena.fighters = mine;
    if (!mine.length) {
      box.innerHTML = '<div class="empty">You hold no Verginals yet. Mint or buy one to enter the Arena.</div>';
      return;
    }
    if (!Arena.selected || !mine.some((m) => m.location === Arena.selected)) Arena.selected = mine[0].location;
    box.innerHTML = '';
    mine.forEach((i) => {
      const c = document.createElement('button');
      c.className = 'arena-fighter' + (i.location === Arena.selected ? ' sel' : '');
      c.innerHTML = `<img src="/api/content/${esc(i.txid)}" loading="lazy" alt=""><span>#${i.collectionNumber}</span>`;
      c.addEventListener('click', () => { Arena.selected = i.location; loadArenaFighters(); });
      box.appendChild(c);
    });
  } catch (e) {
    box.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
}

function renderLoadout() {
  const box = $('#arena-loadout');
  const L = Arena.loadout;
  box.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    const row = document.createElement('div');
    row.className = 'arena-round';
    const label = document.createElement('span');
    label.className = 'arena-round-n';
    label.textContent = 'Round ' + (r + 1);
    row.appendChild(label);
    ARENA_ELEMENTS.forEach((el) => {
      const b = document.createElement('button');
      b.className = 'arena-el' + (L.attacks[r] === el ? ' on' : '');
      b.innerHTML = `${ELEMENT_ICON[el]}<span>${el}</span>`;
      b.addEventListener('click', () => { L.attacks[r] = el; renderLoadout(); });
      row.appendChild(b);
    });
    box.appendChild(row);
  }
  // Each power-up must be placed on a round (every fighter plays all three, so there is no "none").
  const specials = [['poisonRound', 'Poison 💀'], ['potionRound', 'Potion 🧪']]; // shield disabled for now
  specials.forEach(([key, name]) => {
    const row = document.createElement('div');
    row.className = 'arena-round';
    const label = document.createElement('span');
    label.className = 'arena-round-n';
    label.textContent = name;
    row.appendChild(label);
    [0, 1, 2].forEach((v) => {
      const b = document.createElement('button');
      b.className = 'arena-el sm' + (L[key] === v ? ' on' : '');
      b.textContent = 'R' + (v + 1);
      b.addEventListener('click', () => { L[key] = v; renderLoadout(); });
      row.appendChild(b);
    });
    box.appendChild(row);
  });
}

function randomClientSeed() {
  const a = new Uint8Array(16);
  (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256)));
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function arenaDuel(mode) {
  const out = $('#arena-result');
  if (!Arena.selected) { out.textContent = '✗ Pick a Verginal first.'; return; }
  $('#arena-bot').disabled = true;
  $('#arena-queue').disabled = true;
  out.textContent = 'Signing in…';
  try {
    await arenaAuth();
    out.textContent = mode === 'bot' ? 'Fighting…' : 'Looking for an opponent…';
    const r = await arenaApi('/api/game/duel/' + mode, {
      verginal: Arena.selected, loadout: Arena.loadout, clientSeed: randomClientSeed(),
    });
    if (r.status === 'waiting') {
      out.innerHTML = '⏳ You are in the queue. The duel resolves as soon as another player joins. Come back and check the ladder.';
    } else {
      await playArenaBattle(r.match || r);
    }
    loadArenaLadder();
    loadArenaFighters();
    loadArenaProfile();
    loadArenaHistory();
  } catch (e) {
    out.textContent = '✗ ' + e.message;
  } finally {
    $('#arena-bot').disabled = false;
    $('#arena-queue').disabled = false;
  }
}

// --- battle cinematic: a self-contained canvas replay of the deterministic result ------------
const ELEMENT_COLOR = { fire: '#e87040', water: '#40a0e8', earth: '#60c040' };
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

// Tiny synthesized sound effects (no assets). Created on the play click, so autoplay policy is met.
let arenaAudio = null;
function sfx(kind) {
  try {
    arenaAudio = arenaAudio || new (window.AudioContext || window.webkitAudioContext)();
    const ac = arenaAudio;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    const now = ac.currentTime;
    const conf = {
      cast: [520, 0.12, 'triangle'], impact: [110, 0.18, 'square'],
      victory: [660, 0.4, 'sawtooth'], defeat: [180, 0.4, 'sawtooth'],
    }[kind] || [440, 0.1, 'sine'];
    o.type = conf[2];
    o.frequency.setValueAtTime(conf[0], now);
    if (kind === 'victory') o.frequency.exponentialRampToValueAtTime(conf[0] * 2, now + conf[1]);
    if (kind === 'defeat') o.frequency.exponentialRampToValueAtTime(conf[0] / 2, now + conf[1]);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + conf[1]);
    o.start(now); o.stop(now + conf[1] + 0.02);
  } catch (_) { /* audio optional */ }
}

/**
 * Play the deterministic match as a canvas cinematic, then resolve. For a participant the finale
 * reads VICTORY/DEFEAT; for a spectator (a shared replay) it reads "#N WINS" neutrally.
 */
function playArenaBattle(match, opts = {}) {
  const viewer = opts.viewer !== undefined ? opts.viewer : Arena.address;
  const isParticipant = !!viewer && (match.p1 === viewer || match.p2 === viewer);
  const meSide = match.p2 === viewer ? 'p2' : 'p1';
  const oppSide = meSide === 'p1' ? 'p2' : 'p1';
  const meNum = match[meSide + 'Verginal'];
  const oppNum = match[oppSide + 'Verginal'];
  const rounds = match.rounds || [];
  const moves = match.moves || [];
  const winnerSide = match.winner === match.p1 ? 'p1' : 'p2';
  const won = isParticipant && match.winner === viewer;
  // Name tags shown under each fighter: the Alpha number, or "Bot" for the practice opponent.
  const meLabel = meNum != null ? '#' + meNum : (isParticipant ? 'You' : 'P1');
  const oppLabel = oppNum != null ? '#' + oppNum : (match[oppSide] === 'bot' ? 'Bot' : 'P2');

  $('#arena-result').textContent = '';
  const stage = $('#arena-stage'); stage.classList.remove('hidden');
  const canvas = $('#arena-canvas'); const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // A real fighter shows its Verginal; the practice bot (no Verginal number) wears the collection avatar.
  const faceSrc = (num) => (num != null ? '/api/collection/image/' + num : '/alpha-avatar.webp');
  return loadImg(faceSrc(meNum))
    .then((meImg) => Promise.all([meImg, loadImg(faceSrc(oppNum))]))
    .then(([meImg, oppImg]) => new Promise((resolve) => {
      // Everything below is a PURE FUNCTION of the elapsed time t. No accumulators, no per-frame
      // state, no particle arrays: the frame at time t is fully determined by t. That makes the
      // animation impossible to stall and guaranteed to reach `total` and end.
      const INTRO = 700, WIND = 480, CLASH = 580, SETTLE = 560, FINALE = 2600;
      const ROUND = WIND + CLASH + SETTLE;
      const roundStart = (i) => INTRO + i * ROUND;
      const impactAt = (i) => roundStart(i) + WIND + CLASH * 0.55;
      const finaleStart = INTRO + rounds.length * ROUND;
      const total = finaleStart + FINALE;
      const meX = W * 0.25, oppX = W * 0.75, baseY = H * 0.52, S = Math.min(172, H * 0.36), mid = W / 2;
      const EL = ELEMENT_COLOR;
      const fired = {};
      const prand = (n) => { const x = Math.sin((n + 1) * 12.9898) * 43758.5453; return x - Math.floor(x); };
      const elOf = (i, side) => (moves[i] && moves[i][side] ? moves[i][side].element : 'fire');
      const winEl = (i) => elOf(i, rounds[i].winner);

      const glowDot = (x, y, r, color) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4); g.addColorStop(0, color); g.addColorStop(0.5, color); g.addColorStop(1, 'transparent'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 7); ctx.fill(); };
      const scoreUpTo = (n) => { let me = 0, op = 0; for (let j = 0; j < n; j++) (rounds[j].winner === meSide ? me++ : op++); return [me, op]; };

      function drawFighter(img, x, y, s, glow, glowR, dim, lean) {
        ctx.save();
        ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x, y + s / 2 + 12, s * 0.42, 9, 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
        if (lean) { ctx.translate(x, y); ctx.rotate(lean); ctx.translate(-x, -y); }
        if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = glowR || 22; }
        ctx.globalAlpha = dim ? 0.4 : 1;
        roundRectPath(ctx, x - s / 2, y - s / 2, s, s, 16); ctx.fillStyle = '#0a0f16'; ctx.fill();
        ctx.save(); roundRectPath(ctx, x - s / 2, y - s / 2, s, s, 16); ctx.clip();
        if (img) { ctx.imageSmoothingEnabled = false; ctx.drawImage(img, x - s / 2, y - s / 2, s, s); }
        else { ctx.fillStyle = '#16202c'; ctx.fillRect(x - s / 2, y - s / 2, s, s); ctx.globalAlpha = 1; ctx.fillStyle = '#5a6b7c'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('BOT', x, y + 12); }
        ctx.restore();
        ctx.globalAlpha = dim ? 0.5 : 1; ctx.lineWidth = 3; ctx.strokeStyle = glow || '#2b3a49';
        roundRectPath(ctx, x - s / 2, y - s / 2, s, s, 16); ctx.stroke();
        ctx.restore();
      }
      const pips = (x, n, color) => { for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x + k * 22, 30, 7, 0, 7); if (k < n) { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0; } else { ctx.fillStyle = '#26323f'; ctx.fill(); } } };
      function projectile(x0, x1, y, f, color) {
        const x = x0 + (x1 - x0) * easeIn(f);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for (let k = 5; k >= 1; k--) { const tf = Math.max(0, f - k * 0.06); const tx = x0 + (x1 - x0) * easeIn(tf); ctx.globalAlpha = (1 - k / 6) * 0.4; glowDot(tx, y, 7 + (5 - k), color); }
        ctx.globalAlpha = 1; glowDot(x, y, 15, color);
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
        ctx.restore();
      }
      function impactFx(t, i, cx, cy, color) {
        const age = t - impactAt(i); if (age < 0 || age > 560) return;
        const pr = age / 560;
        ctx.save();
        ctx.globalAlpha = (1 - pr) * 0.85; ctx.strokeStyle = color; ctx.lineWidth = (1 - pr) * 6 + 1; ctx.beginPath(); ctx.arc(cx, cy, easeOut(pr) * 165, 0, 7); ctx.stroke();
        ctx.globalAlpha = (1 - pr) * 0.5; ctx.strokeStyle = '#fff'; ctx.lineWidth = (1 - pr) * 3 + 1; ctx.beginPath(); ctx.arc(cx, cy, easeOut(pr) * 105, 0, 7); ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        for (let j = 0; j < 22; j++) { const a = (j / 22) * 6.283 + i * 0.7; const d = (0.25 + prand(j + i * 10) * 0.55) * age; const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d + 0.00025 * age * age; ctx.globalAlpha = 1 - pr; glowDot(x, y, (1 - pr) * 3 + 1, j % 4 === 0 ? '#fff' : color); }
        ctx.restore();
      }
      function drawFinale(ft) {
        const winNum = winnerSide === 'p1' ? match.p1Verginal : match.p2Verginal;
        const winImg = winnerSide === meSide ? meImg : oppImg;
        const wc = isParticipant && !won ? '#ff6b6b' : '#38d39f';
        const cx = mid, cy = H * 0.44, bob = Math.sin(ft / 260) * 4;
        if (!fired.v) { fired.v = 1; sfx(isParticipant && !won ? 'defeat' : 'victory'); }
        ctx.fillStyle = 'rgba(5,9,14,' + (0.62 * easeOut(Math.min(1, ft / 500))) + ')'; ctx.fillRect(-40, -40, W + 80, H + 80);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ft / 1400); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.14 * easeOut(Math.min(1, ft / 600));
        for (let k = 0; k < 12; k++) { ctx.rotate(0.5236); ctx.fillStyle = wc; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W * 0.55, -24); ctx.lineTo(W * 0.55, 24); ctx.closePath(); ctx.fill(); }
        ctx.restore();
        if (ft < 700) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; for (let j = 0; j < 28; j++) { const a = (j / 28) * 6.283; const d = (0.3 + prand(j) * 0.55) * ft; ctx.globalAlpha = Math.max(0, 1 - ft / 700); glowDot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2.6, j % 3 === 0 ? '#fff' : wc); } ctx.restore(); }
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; for (let j = 0; j < 16; j++) { const cyc = (ft / 1500 + prand(j)) % 1; const x = cx + (prand(j + 99) - 0.5) * W * 0.62; const y = cy + S * 0.6 - cyc * H * 0.55; ctx.globalAlpha = (1 - cyc) * 0.6; glowDot(x, y, 2, wc); } ctx.restore();
        const ws = S * (1.12 + easeOut(Math.min(1, ft / 500)) * 0.22);
        ctx.save(); ctx.shadowColor = wc; ctx.shadowBlur = 40; ctx.strokeStyle = wc; ctx.globalAlpha = 0.5 + Math.sin(ft / 130) * 0.2; ctx.lineWidth = 3; roundRectPath(ctx, cx - ws / 2, cy - ws / 2 + bob, ws, ws, 18); ctx.stroke(); ctx.restore();
        drawFighter(winImg, cx, cy + bob, ws, wc, 36, false, 0);
        const ts = easeOut(Math.min(1, ft / 450));
        ctx.save(); ctx.translate(cx, H * 0.85); ctx.scale(ts, ts); ctx.textAlign = 'center'; ctx.font = '900 60px -apple-system, sans-serif'; ctx.shadowColor = wc; ctx.shadowBlur = 24; ctx.fillStyle = wc;
        ctx.fillText(isParticipant ? (won ? 'VICTORY' : 'DEFEAT') : (winNum != null ? '#' + winNum + ' WINS' : 'WINNER'), 0, 0); ctx.restore();
        ctx.fillStyle = '#aebccb'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`${match.score[meSide === 'p1' ? 0 : 1]} - ${match.score[meSide === 'p1' ? 1 : 0]}`, cx, H * 0.85 + 32);
      }

      const start = performance.now();
      function frame() {
        const t = Math.min(total, performance.now() - start);
        try {
          let phase = 'finale', i = -1, lp = 1;
          if (t < INTRO) { phase = 'intro'; lp = t / INTRO; }
          else if (t < finaleStart) {
            i = Math.floor((t - INTRO) / ROUND);
            const rt = (t - INTRO) - i * ROUND;
            if (rt < WIND) { phase = 'windup'; lp = rt / WIND; }
            else if (rt < WIND + CLASH) { phase = 'clash'; lp = (rt - WIND) / CLASH; }
            else { phase = 'settle'; lp = (rt - WIND - CLASH) / SETTLE; }
          } else { phase = 'finale'; lp = (t - finaleStart) / FINALE; }

          let shake = 0, flash = 0, flashColor = '#fff';
          if (i >= 0) { const age = t - impactAt(i); if (age >= 0) { shake = Math.max(0, 1 - age / 320) * 16; flash = Math.max(0, 1 - age / 220); flashColor = EL[winEl(i)] || '#fff'; } }
          ctx.setTransform(1, 0, 0, 1, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

          const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0f1c28'); bg.addColorStop(1, '#070c12');
          ctx.fillStyle = bg; ctx.fillRect(-40, -40, W + 80, H + 80);
          let cg = 0.12, cgC = '#1aa3e0';
          if (phase === 'windup') { cg = 0.12 + lp * 0.18; cgC = EL[winEl(i)]; }
          if (phase === 'clash') { cg = 0.14 + easeIn(lp) * 0.45; cgC = EL[winEl(i)]; }
          ctx.save(); ctx.globalAlpha = cg; glowDot(mid, baseY, W * 0.26, cgC); ctx.restore();

          if (phase !== 'finale') {
            const shown = phase === 'settle' && lp > 0.4 ? i + 1 : Math.max(0, i);
            const [meW, opW] = scoreUpTo(shown);
            pips(28, meW, '#38d39f'); ctx.save(); ctx.translate(W - 28 - 44, 0); pips(0, opW, '#ff6b6b'); ctx.restore();
            if (i >= 0) { ctx.fillStyle = '#6a7c8c'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('ROUND ' + (i + 1), mid, 40); }

            const bob = Math.sin(t / 300) * 4;
            let meGlow = null, opGlow = null, meGlowR = 22, opGlowR = 22, meDim = false, opDim = false, meScale = 1, opScale = 1, meDX = 0, opDX = 0, meLean = 0, opLean = 0;
            const yOff = phase === 'intro' ? (1 - easeOut(lp)) * 70 : 0;

            if (phase === 'windup') {
              meGlow = EL[elOf(i, meSide)]; opGlow = EL[elOf(i, oppSide)]; meGlowR = 14 + lp * 24; opGlowR = 14 + lp * 24;
              meDX = -easeInOut(lp) * 16; opDX = easeInOut(lp) * 16; meLean = -lp * 0.05; opLean = lp * 0.05;
              if (!fired['c' + i] && lp > 0.7) { fired['c' + i] = 1; sfx('cast'); }
            } else if (phase === 'clash') {
              meGlow = EL[elOf(i, meSide)]; opGlow = EL[elOf(i, oppSide)];
              const flyDur = 0.55;
              if (lp < flyDur) { const f = lp / flyDur; projectile(meX + S / 2, mid, baseY, f, EL[elOf(i, meSide)]); projectile(oppX - S / 2, mid, baseY, f, EL[elOf(i, oppSide)]); }
              if (!fired['i' + i] && lp >= flyDur) { fired['i' + i] = 1; sfx('impact'); }
            } else if (phase === 'settle') {
              const meWon = rounds[i].winner === meSide, pop = easeOut(Math.min(1, lp * 3));
              if (meWon) { meGlow = '#38d39f'; meGlowR = 30; meScale = 1 + pop * 0.08; opDim = true; opLean = 0.12; }
              else { opGlow = '#38d39f'; opGlowR = 30; opScale = 1 + pop * 0.08; meDim = true; meLean = -0.12; }
              const wx = meWon ? meX : oppX;
              ctx.save(); ctx.globalAlpha = pop; ctx.fillStyle = '#38d39f'; ctx.shadowColor = '#38d39f'; ctx.shadowBlur = 14; ctx.font = '900 ' + (20 + pop * 8) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('WON', wx, baseY - S / 2 - 22); ctx.restore();
              ctx.globalAlpha = Math.min(1, lp * 2); ctx.fillStyle = '#9fb0c0'; ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('by ' + rounds[i].reason, mid, baseY + S / 2 + 42); ctx.globalAlpha = 1;
            }

            if (i >= 0) impactFx(t, i, mid, baseY, EL[winEl(i)]);
            drawFighter(meImg, meX + meDX, baseY + bob + yOff, S * meScale, meGlow, meGlowR, meDim, meLean);
            drawFighter(oppImg, oppX + opDX, baseY - bob + yOff, S * opScale, opGlow, opGlowR, opDim, opLean);
            ctx.save(); ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#cdd8e3';
            ctx.fillText(meLabel, meX, baseY + S / 2 + 30); ctx.fillText(oppLabel, oppX, baseY + S / 2 + 30); ctx.restore();

            if (flash > 0.01) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = flash * 0.8; ctx.fillStyle = flashColor; ctx.fillRect(-40, -40, W + 80, H + 80); ctx.restore(); }
          } else {
            drawFinale(t - finaleStart);
          }
        } catch (e) { console.error('Arena cinematic error:', e); ctx.setTransform(1, 0, 0, 1, 0, 0); resolve(); showArenaResult(match, opts); return; }

        if (t < total) requestAnimationFrame(frame);
        else { ctx.setTransform(1, 0, 0, 1, 0, 0); resolve(); showArenaResult(match, opts); }
      }
      requestAnimationFrame(frame);
    }));
}
const easeIn = (p) => p * p;
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function showArenaResult(match, opts = {}) {
  const viewer = opts.viewer !== undefined ? opts.viewer : Arena.address;
  const isParticipant = !!viewer && (match.p1 === viewer || match.p2 === viewer);
  const meSide = match.p2 === viewer ? 'p2' : 'p1';
  const won = isParticipant && match.winner === viewer;
  const winnerSide = match.winner === match.p1 ? 'p1' : 'p2';
  const winNum = winnerSide === 'p1' ? match.p1Verginal : match.p2Verginal;
  const rounds = (match.rounds || []).map((r) => {
    const mine = r.winner === meSide;
    return `<span class="arena-rr ${mine ? 'win' : 'loss'}">R${r.round} ${mine ? 'W' : 'L'} <em>${esc(r.reason)}</em></span>`;
  }).join('');
  const verdict = isParticipant ? (won ? 'VICTORY' : 'DEFEAT') : (winNum != null ? '#' + winNum + ' WINS' : 'WINNER');
  const oppSide = meSide === 'p1' ? 'p2' : 'p1';
  const meNum = match[meSide + 'Verginal'];
  const oppNum = match[oppSide + 'Verginal'];
  const meLbl = meNum != null ? '#' + meNum : 'You';
  const oppLbl = oppNum != null ? '#' + oppNum : (match[oppSide] === 'bot' ? 'Bot' : 'Opponent');
  const matchup = isParticipant ? `${meLbl} vs ${oppLbl}` : `#${match.p1Verginal} vs #${match.p2Verginal}`;
  const out = $('#arena-result');
  out.innerHTML = `<div class="arena-verdict ${isParticipant && !won ? 'loss' : 'win'}">${verdict}</div>
    <div class="arena-matchup">${esc(matchup)}</div>
    <div class="arena-rounds">${rounds}</div>
    <div class="hint">Provably fair: seed <code>${esc(short(match.seed || ''))}</code></div>`;
  const share = btn('Copy replay link 🔗', 'ghost sm', () => {
    navigator.clipboard.writeText(location.origin + replayPath(match));
    share.textContent = 'Copied ✓';
    setTimeout(() => { share.textContent = 'Copy replay link 🔗'; }, 1400);
  });
  share.style.marginTop = '10px';
  out.appendChild(share);
}

// --- shareable replays: pack a match into a URL blob and rerun the cinematic for anyone ----------
function b64urlEncode(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(b) { return decodeURIComponent(escape(atob(b.replace(/-/g, '+').replace(/_/g, '/')))); }
const packMove = (mv = {}) => ({ e: mv.element, p: mv.poison ? 1 : undefined, o: mv.potion ? 1 : undefined, h: mv.shield ? 1 : undefined });
const unpackMove = (o = {}) => ({ element: o.e, poison: !!o.p, potion: !!o.o, shield: !!o.h });

/** Compact URL path that reruns this exact duel for anyone: /arena/replay/<blob>. */
function replayPath(match) {
  const winnerSide = match.winner === match.p1 ? 'p1' : 'p2';
  const o = {
    v: 1, a: match.p1Verginal, b: match.p2Verginal, s: match.seed, w: winnerSide, sc: match.score,
    r: (match.rounds || []).map((x) => [x.round, x.winner === 'p1' ? 0 : 1, x.reason]),
    m: (match.moves || []).map((x) => [packMove(x.p1), packMove(x.p2)]),
  };
  return '/arena/replay/' + b64urlEncode(JSON.stringify(o));
}

function decodeReplay(blob) {
  const o = JSON.parse(b64urlDecode(blob));
  if (o.v !== 1) throw new Error('unsupported replay');
  return {
    p1: 'p1', p2: 'p2', winner: o.w, p1Verginal: o.a, p2Verginal: o.b, seed: o.s, score: o.sc,
    rounds: (o.r || []).map(([round, w, reason]) => ({ round, winner: w ? 'p2' : 'p1', reason })),
    moves: (o.m || []).map(([a, b]) => ({ p1: unpackMove(a), p2: unpackMove(b) })),
  };
}

/** Open a shared replay: switch to the Arena, hide the interactive controls, and play it. */
async function showArenaReplay(blob) {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  document.querySelector('.tab[data-tab="arena"]').classList.add('active');
  $('#panel-arena').classList.add('active');
  window.scrollTo({ top: 0 });
  loadArenaLadder();
  loadArenaTournaments();
  $('#arena-gate').innerHTML = '<b>Replay</b> of a Verginals Arena duel. <a class="link" href="/arena" onclick="event.preventDefault();document.querySelector(\'.tab[data-tab=arena]\').click()">Play your own →</a>';
  const fight = $('#arena-fight');
  fight.classList.remove('hidden');
  fight.querySelectorAll('h3, p.hint, #arena-fighters, #arena-loadout, .arena-actions').forEach((el) => (el.style.display = 'none'));
  try {
    await playArenaBattle(decodeReplay(blob), { viewer: null });
  } catch (_) {
    $('#arena-result').textContent = '✗ This replay link is invalid.';
  }
}

async function loadArenaLadder() {
  try {
    const d = await api('/api/game/leaderboard');
    const lb = $('#arena-leaderboard');
    lb.innerHTML = d.top.length
      ? d.top.map((p, i) => `<div class="arena-rank"><span>${i + 1}. <code>${esc(short(p.address))}</code></span><b>${p.elo}</b></div>`).join('')
      : '<div class="empty">No duels yet.</div>';
    const hs = $('#arena-houses');
    hs.innerHTML = d.houses.length
      ? d.houses.map((h) => `<div class="arena-rank"><span>${ELEMENT_ICON[h.house] || ''} ${esc(h.house)}</span><b>${h.points}</b></div>`).join('')
      : '<div class="empty">No scores yet.</div>';
  } catch (_) { /* leave placeholders */ }
}

async function loadArenaTournaments() {
  try {
    const d = await api('/api/game/tournaments');
    const box = $('#arena-tournaments');
    box.innerHTML = '';
    if (!d.tournaments.length) { box.innerHTML = '<div class="empty">None yet.</div>'; return; }
    d.tournaments.forEach((t) => {
      const row = document.createElement('button');
      row.className = 'arena-tourn';
      const state = t.status === 'registering' ? `${t.players}/${t.size} joined` : t.status;
      const cta = t.status === 'registering' ? 'Join &amp; view bracket' : 'View bracket';
      row.innerHTML = `<span class="at-top"><span class="at-name">🏆 ${esc(t.name)}</span><span class="at-state">${esc(state)}</span></span><span class="at-cta">${cta} <span class="at-arrow">→</span></span>`;
      row.addEventListener('click', () => openTournament(t.id));
      box.appendChild(row);
    });
  } catch (_) { /* leave placeholder */ }
}

// --- tournament knockout bracket -------------------------------------------------------------
let currentTournamentId = null;

/** Human label for a round from the size of its field (survivors entering it). */
function roundName(field) {
  if (field === 2) return 'Final';
  if (field === 4) return 'Semi-finals';
  if (field === 8) return 'Quarter-finals';
  return 'Round of ' + field;
}

async function openTournament(id) {
  currentTournamentId = id;
  try {
    const { tournament } = await api('/api/game/tournament/' + id);
    renderBracket(tournament);
    $('#arena-bracket').classList.remove('hidden');
    const grid = document.querySelector('#panel-arena .arena-grid');
    if (grid) grid.classList.add('hidden');
  } catch (e) { /* keep the arena as-is on failure */ }
}

function closeBracket() {
  $('#arena-bracket').classList.add('hidden');
  const grid = document.querySelector('#panel-arena .arena-grid');
  if (grid) grid.classList.remove('hidden');
  currentTournamentId = null;
}

/** One fighter slot in a bracket match: avatar + Alpha number, winner highlighted, you marked. */
function bracketFighter(addr, partMap, isWinner) {
  if (!addr) return '<div class="bk-f tbd"><span>TBD</span></div>';
  const p = partMap[addr];
  const num = p && p.verginal != null ? p.verginal : null;
  const media = num != null ? `<img src="/api/collection/image/${num}" loading="lazy" alt="" />` : '<span class="bk-av">?</span>';
  const label = num != null ? '#' + num : short(addr);
  const mine = addr === Arena.address ? ' me' : '';
  return `<div class="bk-f${isWinner ? ' win' : ''}${mine}">${media}<span class="bk-name">${esc(label)}</span></div>`;
}

/** One match box (two fighters) wrapped in its bracket slot. */
function bracketMatch(m, partMap) {
  if (!m) return '<div class="bk-slot"><div class="bk-match tbd"><div class="bk-f tbd"><span>TBD</span></div><div class="bk-f tbd"><span>TBD</span></div></div></div>';
  return `<div class="bk-slot"><div class="bk-match ${m.status === 'resolved' ? 'done' : ''}">
    ${bracketFighter(m.p1, partMap, m.winner === m.p1)}
    ${bracketFighter(m.p2, partMap, m.winner === m.p2)}
  </div></div>`;
}

/** One column of a half-bracket: the matches of one round on one side. */
function bracketColumn(matches, partMap) {
  return `<div class="brk-round">${matches.map((m) => bracketMatch(m, partMap)).join('')}</div>`;
}

function renderBracket(t) {
  const partMap = {};
  (t.participants || []).forEach((p) => { partMap[p.address] = p; });

  const head = $('#arena-bracket-head');
  head.innerHTML = `<h2>${esc(t.name)}</h2>
    <div class="bk-meta"><span class="bk-status ${esc(t.status)}">${esc(t.status)}</span> · ${t.size} players${t.status === 'registering' ? ` · ${(t.participants || []).length}/${t.size} joined` : ''}</div>`;
  renderBracketActions(t);

  const body = $('#arena-bracket-body');
  if (!t.rounds || !t.rounds.length) {
    // Registering: show the field filling up.
    const cells = (t.participants || []).map((p) => bracketFighter(p.address, partMap, false)).join('');
    const open = t.size - (t.participants || []).length;
    body.className = 'bracket registering';
    body.innerHTML = `<div class="bk-registering">${cells || '<div class="empty">No one has joined yet. Be the first!</div>'}</div>
      ${open > 0 ? `<div class="hint">Waiting for ${open} more player${open > 1 ? 's' : ''} to fill the bracket.</div>` : '<div class="hint">Bracket full, ready to start.</div>'}`;
    return;
  }

  // Split each preliminary round in two: the left half feeds rightward, the right half leftward,
  // both converging on the Grand Final in the centre (the classic knockout tree).
  const prelim = t.rounds.slice(0, -1);
  const finalRound = t.rounds[t.rounds.length - 1];
  const finalMatch = finalRound.matches[0];
  const leftCols = prelim.map((r) => bracketColumn(r.matches.slice(0, Math.ceil(r.matches.length / 2)), partMap));
  const rightCols = prelim.map((r) => bracketColumn(r.matches.slice(Math.ceil(r.matches.length / 2)), partMap));

  const champ = (t.status === 'ended' && t.championAddress) ? partMap[t.championAddress] : null;
  const tr = t.trophies || {};
  const champBlock = champ
    ? `<div class="brk-champ">🏆 <b>${esc(champ.verginal != null ? '#' + champ.verginal : short(t.championAddress))}</b> wins${tr.champion ? ` · <a class="link" href="/v/${esc(tr.champion.replace(/i0$/, ''))}" target="_blank" rel="noopener">trophy</a>` : ''}</div>`
    : '';
  const finalBlock = `<div class="brk-final"><div class="brk-final-inner">
      <div class="brk-final-badge"><span class="brk-swords">⚔️</span><span>GRAND FINAL</span></div>
      ${bracketMatch(finalMatch, partMap)}
      ${champBlock}
    </div></div>`;

  body.className = 'bracket';
  body.innerHTML = `<div class="brk side-l">${leftCols.join('')}</div>${finalBlock}<div class="brk side-r">${rightCols.reverse().join('')}</div>`;
}

/** Context actions on the bracket: join while registering, submit a loadout for your pending match. */
function renderBracketActions(t) {
  const box = $('#arena-bracket-actions');
  box.innerHTML = '';
  const joined = Arena.address && (t.participants || []).some((p) => p.address === Arena.address);
  if (t.status === 'registering') {
    if (joined) { box.innerHTML = '<span class="bk-joined">✓ You are in. Waiting for the bracket to fill.</span>'; return; }
    box.appendChild(btn('⚔️ Join ' + t.name, 'primary', () => tournamentJoin(t.id)));
    return;
  }
  if (t.status === 'running' && joined) {
    const round = t.rounds[t.currentRound - 1];
    const mine = round && round.matches.find((m) => (m.p1 === Arena.address || m.p2 === Arena.address) && m.status !== 'resolved');
    if (mine) {
      const submitted = (mine.p1 === Arena.address && mine.p1Submitted) || (mine.p2 === Arena.address && mine.p2Submitted);
      if (submitted) box.innerHTML = '<span class="hint">Loadout submitted for this round. Waiting for the round to resolve.</span>';
      else box.appendChild(btn('Submit your Arena loadout for this round', 'primary sm', () => tournamentSubmit(t.id)));
    } else {
      box.innerHTML = '<span class="hint">You are still in the bracket. No pending match this round.</span>';
    }
  }
}

async function tournamentJoin(id) {
  const box = $('#arena-bracket-actions');
  box.innerHTML = 'Connecting…';
  try {
    await arenaAuth();                      // connect + sign in (prompts the wallet)
    if (!Arena.selected) await loadArenaFighters(); // auto-selects the first Alpha the wallet holds
    if (!Arena.selected) { box.innerHTML = '<span class="bk-joined">You need an Alpha Verginal to enter. Grab one on the Market, then try again.</span>'; return; }
    box.innerHTML = 'Joining…';
    await arenaApi('/api/game/tournament/join', { tournamentId: id, verginal: Arena.selected });
    openTournament(id); // refresh into the joined state
  } catch (e) { box.innerHTML = '✗ ' + esc(e.message); }
}

async function tournamentSubmit(id) {
  const box = $('#arena-bracket-actions');
  box.innerHTML = 'Submitting…';
  try {
    await arenaAuth();
    await arenaApi('/api/game/tournament/submit', { tournamentId: id, loadout: Arena.loadout });
    openTournament(id); // refresh
  } catch (e) { box.innerHTML = '✗ ' + esc(e.message); }
}

$('#arena-bracket-back').addEventListener('click', closeBracket);

// The badge catalogue is static; fetch it once and reuse for the achievements grid.
let arenaBadgeDefs = null;
async function loadBadgeDefs() {
  if (arenaBadgeDefs) return arenaBadgeDefs;
  try { arenaBadgeDefs = (await api('/api/game/badges')).badges || []; } catch (_) { arenaBadgeDefs = []; }
  return arenaBadgeDefs;
}

/** Your record + achievements: Elo, W/L, streak, and every badge (earned highlighted, rest locked). */
async function loadArenaProfile() {
  if (!Arena.token) return;
  try {
    const [me, defs] = await Promise.all([arenaApi('/api/game/me'), loadBadgeDefs()]);
    const p = me.profile || {};
    $('#arena-profile-card').hidden = false;
    const rate = p.matches ? Math.round((p.wins / p.matches) * 100) : 0;
    $('#arena-profile').innerHTML = `
      <div class="arena-stats">
        <div class="as"><b>${p.elo != null ? p.elo : '-'}</b><span>Elo</span></div>
        <div class="as"><b>${p.wins || 0}-${p.losses || 0}</b><span>Win / Loss</span></div>
        <div class="as"><b>${rate}%</b><span>Win rate</span></div>
        <div class="as"><b>${p.streak || 0} 🔥</b><span>Streak (best ${p.bestStreak || 0})</span></div>
      </div>`;
    const earned = new Set(p.badges || []);
    $('#arena-badges').innerHTML = defs.length
      ? defs.map((b) => `<div class="arena-badge ${earned.has(b.badge_key) ? 'on' : 'off'}" title="${esc(b.name)}: ${esc(b.description)}"><span class="ab-icon">${b.icon || '🏅'}</span><span class="ab-name">${esc(b.name)}</span></div>`).join('')
      : '<div class="empty">No badges yet.</div>';
  } catch (_) { /* leave hidden */ }
}

/** Recent battles: win/loss, the two Verginals (or Bot), the round score, and a replay link. */
async function loadArenaHistory() {
  if (!Arena.token) return;
  try {
    const list = (await arenaApi("/api/game/history")).history;
    $('#arena-history-card').hidden = false;
    const box = $('#arena-history');
    if (!list || !list.length) { box.innerHTML = '<div class="empty">No battles yet. Fight one!</div>'; return; }
    box.innerHTML = '';
    list.forEach((h) => {
      const opp = h.oppVerginal != null ? '#' + h.oppVerginal : (h.oppAddress === 'bot' ? 'Bot' : 'opponent');
      const mine = h.myVerginal != null ? '#' + h.myVerginal : 'you';
      const sc = (h.myScore != null && h.oppScore != null) ? ` ${h.myScore}-${h.oppScore}` : '';
      const row = document.createElement('div');
      row.className = 'arena-hist ' + h.result;
      row.innerHTML = `<span class="ah-res">${h.result === 'win' ? 'WIN' : 'LOSS'}</span>
        <span class="ah-vs">${esc(mine)} vs ${esc(opp)}${h.mode === 'bot' ? ' <em>bot</em>' : ''}<b>${sc}</b></span>`;
      const rep = document.createElement('a');
      rep.className = 'ah-replay'; rep.textContent = 'replay';
      rep.href = replayPath(h);
      rep.addEventListener('click', (e) => { e.preventDefault(); openHistoryReplay(h); });
      row.appendChild(rep);
      box.appendChild(row);
    });
  } catch (_) { /* leave placeholder */ }
}

/** Open a stored battle in the replay viewer (reuses the shared replay renderer). */
function openHistoryReplay(h) {
  activateTab('arena');
  playArenaBattle(h, { viewer: Arena.address }).catch(() => {});
}

$('#arena-bot').addEventListener('click', () => arenaDuel('bot'));
$('#arena-queue').addEventListener('click', () => arenaDuel('queue'));

// --- boot --------------------------------------------------------------------------------
(async () => {
  try {
    const info = await api('/api/info');
    MARKET_FEE_BPS = Number(info.marketFeeBps || 0);
    // The network and the block height are drawn by the site bar now. What remains here is the one
    // thing the bar does not do: pin the selector so nobody can choose a network mismatch.
    //
    // The old lines wrote into #netinfo, which lived in the header the bar replaced. They were left
    // guarded rather than deleted, and a guarded reference to something that no longer exists is
    // dead code that reads as live: the check that found this could not tell them apart.
    const netsel = $('#network');
    if (info.network && netsel) netsel.value = info.network;
    // The Arena stays hidden until the server enables it (VERGINALS_ARENA_ENABLED); the tab and its
    // deep link only appear once the game is live.
    if (!info.arena) { const a = document.querySelector('.tab[data-tab="arena"]'); if (a) a.remove(); }
  } catch (e) {
    // The bar reports the height, and reports nothing when it cannot reach the node. There is no
    // second place that needs to say so.
  }
  loadMintStatus(); // reveals the Mint tab only when the server has a collection loaded
  loadLatestStrip();
  loadPrice(); // spot XVG/USD for the indicative dollar figures across the marketplace

  // Shareable deep links: /v/<number|txid> opens one Verginal, /gallery/<address> a holder
  // page, /launchpad[/<slug>] the community launchpad.
  const v = location.pathname.match(/^\/v\/([A-Za-z0-9]+)$/);
  const gal = location.pathname.match(/^\/gallery\/([a-km-zA-HJ-NP-Z1-9]{25,40})$/);
  const lp = location.pathname.match(/^\/launchpad(?:\/([a-z0-9-]{3,32}))?$/);
  const rep = location.pathname.match(/^\/arena\/replay\/([A-Za-z0-9_-]+)$/);
  if (v) {
    activateTab('explore');
    openDetailByKey(v[1]);
  } else if (gal) {
    showOwnerGallery(gal[1], false);
  } else if (lp) {
    activateTab('launchpad');
    if (lp[1]) openLaunchpadCollection(lp[1], false);
  } else if (rep) {
    showArenaReplay(rep[1]);
  } else if (location.pathname === '/arena') {
    activateTab('arena');
  }
})();
