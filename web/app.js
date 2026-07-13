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
  if (t.dataset.tab === 'stats') loadStats();
  if (t.dataset.tab === 'launchpad') loadLaunchpad();
  if (t.dataset.tab === 'market') loadMarket();
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
    g.innerHTML = traitFilter
      ? '<div class="empty">No inscribed Verginal carries this trait yet.</div>'
      : (ownerFilter
        ? '<div class="empty">No verginals found at this address yet.</div>'
        : '<div class="empty">No inscriptions in the indexed range yet.</div>');
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
      rankEl.innerHTML = `Rarity rank <b>#${fmt(r.rank)}</b> of ${fmt(r.supply)} · score ${fmt(r.score)}`;
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
const nameOf = (ins) => (ins.collectionNumber != null ? `Verginals #${ins.collectionNumber}` : 'this Verginal');

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
  const isCollectible = ins.collectionNumber != null; // only Verginals trade, not free-form text
  if (!carrier || !isCollectible) return;

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
      <div class="mk-usd" id="mk-price-usd"></div>`;
    liveUsd(form.querySelector('#mk-price'), form.querySelector('#mk-price-usd'));
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

// --- market tab: all Verginals currently for sale -------------------------------------------
async function loadMarket() {
  const g = $('#market-gallery');
  try {
    const [data, list] = await Promise.all([
      api('/api/market/listings'),
      lastList.length ? Promise.resolve(lastList) : loadInscriptions(),
    ]);
    $('#market-meta').textContent = `${data.listings.length} for sale`;
    if (!data.listings.length) {
      g.innerHTML = '<div class="empty">Nothing listed yet. Open one of your Verginals in My Wallet and hit “List for sale”. 🏷️</div>';
      return;
    }
    const byLoc = new Map(list.map((i) => [i.location, i]));
    g.innerHTML = '';
    data.listings.forEach((l) => {
      const ins = byLoc.get(l.carrier);
      const c = document.createElement('div');
      c.className = 'ins-card clickable';
      const img = ins && ins.collectionNumber != null
        ? `<img src="/api/content/${esc(ins.txid)}" loading="lazy" alt="" />`
        : '<div class="blob">🏷️</div>';
      const label = ins && ins.collectionNumber != null ? `#${ins.collectionNumber}` : 'Verginal';
      const xvg = l.priceUnits / MKT_COIN, usd = usdStr(xvg);
      c.innerHTML = `<div class="ins-media">${img}</div>
        <div class="ins-body"><div class="num">${label}</div>
        <div class="mk-price">${fmt(xvg)} XVG</div>${usd ? `<div class="mk-usd">${usd}</div>` : ''}</div>`;
      if (ins) c.addEventListener('click', () => openDetail(ins));
      g.appendChild(c);
    });
  } catch (e) {
    g.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
  }
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
  loadLatestStrip();
  loadPrice(); // spot XVG/USD for the indicative dollar figures across the marketplace

  // Shareable deep links: /v/<number|txid> opens one Verginal, /gallery/<address> a holder
  // page, /launchpad[/<slug>] the community launchpad.
  const v = location.pathname.match(/^\/v\/([A-Za-z0-9]+)$/);
  const gal = location.pathname.match(/^\/gallery\/([a-km-zA-HJ-NP-Z1-9]{25,40})$/);
  const lp = location.pathname.match(/^\/launchpad(?:\/([a-z0-9-]{3,32}))?$/);
  if (v) {
    activateTab('explore');
    openDetailByKey(v[1]);
  } else if (gal) {
    showOwnerGallery(gal[1], false);
  } else if (lp) {
    activateTab('launchpad');
    if (lp[1]) openLaunchpadCollection(lp[1], false);
  }
})();
