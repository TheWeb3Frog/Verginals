'use strict';
// Verginals Wallet integration. Talks to window.verge, the provider injected by the browser
// extension. Three things live here: connect (header button + address autofill), pay a deposit
// straight from the wallet, and the "My Wallet" tab (list your Verginals and transfer them).
// All signing happens on-device in the extension; this page never sees a key.
//
// It reuses the helpers defined in app.js ($ , $$, fmt, short, esc) since both run as classic
// scripts in the same global scope. app.js loads first.

(function () {
  const COIN = 1_000_000; // atomic units per XVG
  // Chrome Web Store listing for the Verginals Wallet extension.
  const STORE_URL = 'https://chromewebstore.google.com/detail/ficjfnjaiopghnpohemapfbilflfflip';
  let provider = null;    // window.verge once it is present
  let address = null;     // connected address, or null
  // The provider injects at document_start, so if it is installed it is almost always present by the
  // time this runs. We only conclude the wallet is ABSENT after a short grace window with no provider,
  // which avoids flashing an "install" prompt at users who already have it.
  let absent = false;
  let bannerDismissed = false;
  let graceTimer = null;

  function openStore() { window.open(STORE_URL, '_blank', 'noopener'); }

  // The provider is injected by the content script and may not be ready when this runs. Resolve it
  // now if present, otherwise wait for the one-shot init event the provider fires.
  function withProvider(cb) {
    if (window.verge && window.verge.isVerginals) { provider = window.verge; cb(); return; }
    window.addEventListener('verge#initialized', () => {
      if (window.verge && window.verge.isVerginals) { provider = window.verge; cb(); }
    }, { once: true });
  }
  function hasProvider() { return !!(provider || (window.verge && window.verge.isVerginals)); }

  // --- connection state ------------------------------------------------------------------
  function setAddress(addr) { address = addr || null; reflect(); }

  async function connect() {
    if (!provider) throw new Error('Verginals Wallet not detected. Install the extension and reload this page.');
    const r = await provider.connect();
    setAddress(r && r.address);
    return r;
  }

  async function disconnect() {
    try { if (provider) await provider.disconnect(); } catch (_) { /* ignore */ }
    setAddress(null);
  }

  // Push the current state into the UI: header button label, pay-with-wallet buttons, address
  // autofill, and the My Wallet tab.
  function reflect() {
    const installed = hasProvider();
    const btn = $('#wallet-connect');
    if (btn) {
      // Three states: connected (address), needs-install (concluded absent), or connectable.
      if (address) {
        btn.textContent = short(address);
      } else if (absent && !installed) {
        btn.textContent = 'Install Wallet';
      } else {
        btn.textContent = 'Connect Wallet';
      }
      btn.classList.toggle('connected', !!address);
      btn.classList.toggle('install', !address && absent && !installed);
    }
    // The pay-with-wallet buttons only make sense once a wallet is connected.
    $$('.wallet-pay').forEach((b) => b.classList.toggle('hidden', !address));
    // Prefill the destination fields, but never overwrite something the user already typed.
    if (address) {
      const t = $('#to-address'); if (t && !t.value.trim()) t.value = address;
      const m = $('#mint-address'); if (m && !m.value.trim()) m.value = address;
    }
    // Prominent install banner: only once we are sure the wallet is missing, and not dismissed.
    const banner = $('#install-banner');
    if (banner) banner.classList.toggle('hidden', !(absent && !installed && !address && !bannerDismissed));
    renderWalletTab();
  }

  // --- pay a deposit straight from the wallet --------------------------------------------
  // Reads the deposit address and amount already rendered on the payment card, then asks the
  // wallet to send. The existing job poll in app.js then detects the payment and finishes the flow.
  async function payFrom(addrSel, amountSel) {
    const to = ($(addrSel).textContent || '').trim();
    const xvg = parseFloat(String($(amountSel).textContent).replace(/[^\d.]/g, ''));
    if (!to || !(xvg > 0)) throw new Error('no active payment request');
    const amount = Math.round(xvg * COIN);
    return provider.send({ to, amount }); // { txid }
  }

  function wirePay(btnId, addrSel, amountSel, statusTextSel, errSel) {
    const btn = $('#' + btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!provider) return;
      const err = $(errSel); if (err) err.textContent = '';
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Approve in wallet…';
      try {
        await payFrom(addrSel, amountSel);
        const s = $(statusTextSel);
        if (s) s.textContent = 'Payment sent from your wallet. Waiting for the network to confirm…';
      } catch (e) {
        if (err) err.textContent = '✗ ' + (e.message || String(e));
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  // --- My Wallet tab ---------------------------------------------------------------------
  function renderWalletTab() {
    const disc = $('#wallet-disconnected');
    const conn = $('#wallet-connected');
    if (!disc || !conn) return;
    if (!address) {
      disc.classList.remove('hidden');
      conn.classList.add('hidden');
      const noext = $('#wallet-noext');
      const cbtn = $('#wallet-connect-2');
      const present = hasProvider();
      if (noext) noext.classList.toggle('hidden', present);
      if (cbtn) cbtn.classList.toggle('hidden', !present);
      return;
    }
    disc.classList.add('hidden');
    conn.classList.remove('hidden');
    $('#wallet-address').textContent = address;
    loadInscriptions();
  }

  async function loadInscriptions() {
    const g = $('#wallet-gallery');
    const balEl = $('#wallet-balance');
    if (!g) return;
    g.innerHTML = '<div class="empty">Loading your Verginals…</div>';
    try {
      const bal = await provider.getBalance(); // { total, spendable, unknown, inscriptions }
      if (balEl) balEl.innerHTML = `<b>${fmt(bal.spendable / COIN)} XVG</b><span>spendable</span>`;
      const list = bal.inscriptions || [];
      if (!list.length) { g.innerHTML = '<div class="empty">No Verginals in this wallet yet.</div>'; return; }
      g.innerHTML = '';
      list.forEach((u) => g.appendChild(walletCard(u)));
    } catch (e) {
      g.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
    }
  }

  // The reveal txid (front of the inscription id "<txid>iN") is what the site's /api/content
  // endpoint serves, so we can show the same image the extension shows, straight from the node.
  function revealTxidOf(insc) {
    const id = (insc && insc.id) || '';
    const front = id.split('i')[0];
    return /^[a-f0-9]{64}$/.test(front) ? front : null;
  }

  function walletCard(u) {
    const insc = u.inscription || {};
    const outpoint = `${u.txid}:${u.vout}`;
    const rtx = revealTxidOf(insc);
    const ct = insc.contentType || '';

    const c = document.createElement('div');
    c.className = 'ins-card';
    const media = document.createElement('div');
    media.className = 'ins-media';
    if (rtx && (ct.startsWith('image/') || ct === '')) {
      const img = document.createElement('img');
      img.src = '/api/content/' + rtx; img.loading = 'lazy';
      img.onerror = () => { media.innerHTML = '<div class="blob">📦</div>'; };
      media.appendChild(img);
    } else if (rtx && ct.startsWith('text/')) {
      const pre = document.createElement('div'); pre.className = 'txtprev'; pre.textContent = '…';
      fetch('/api/content/' + rtx).then((r) => r.text()).then((t) => (pre.textContent = t.slice(0, 400))).catch(() => (pre.textContent = '(text)'));
      media.appendChild(pre);
    } else {
      media.innerHTML = '<div class="blob">📦</div>';
    }

    const body = document.createElement('div');
    body.className = 'ins-body';
    const num = insc.collectionNumber != null ? `#${insc.collectionNumber}`
      : (insc.number != null ? `#${insc.number}` : 'Verginal');
    body.innerHTML = `<div class="num">${esc(num)}</div>
      <div class="meta">${fmt(u.value / COIN)} XVG locked<br>${esc(short(u.txid))}:${u.vout}</div>`;
    const btn = document.createElement('button');
    btn.className = 'btn ghost xfer-btn';
    btn.textContent = 'Transfer';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openTransfer(outpoint, num, rtx, ct); });
    body.appendChild(btn);

    c.appendChild(media); c.appendChild(body);
    // Open the site's detail view (traits + rarity percentages) for this Verginal. app.js is
    // loaded before this file and exposes openDetailByKey; the key is the collection number
    // when known, else the reveal txid.
    const key = insc.collectionNumber != null ? String(insc.collectionNumber) : rtx;
    if (key && typeof openDetailByKey === 'function') {
      c.classList.add('clickable');
      c.addEventListener('click', () => openDetailByKey(key));
    }
    return c;
  }

  // --- transfer modal --------------------------------------------------------------------
  let xferOutpoint = null;

  function openTransfer(outpoint, label, rtx, ct) {
    xferOutpoint = outpoint;
    const modal = $('#xfer-modal');
    const preview = $('#xfer-preview');
    $('#xfer-error').textContent = '';
    $('#xfer-to').value = '';
    if (preview) {
      preview.innerHTML = '';
      if (rtx && (ct.startsWith('image/') || ct === '')) {
        const img = document.createElement('img'); img.src = '/api/content/' + rtx; img.alt = label;
        preview.appendChild(img);
      }
      const cap = document.createElement('div'); cap.className = 'xfer-cap'; cap.textContent = label;
      preview.appendChild(cap);
    }
    modal.classList.remove('hidden');
    $('#xfer-to').focus();
  }

  function closeTransfer() { $('#xfer-modal').classList.add('hidden'); xferOutpoint = null; }

  async function confirmTransfer() {
    const to = $('#xfer-to').value.trim();
    const err = $('#xfer-error');
    err.textContent = '';
    if (!to) { err.textContent = 'Enter the destination address.'; return; }
    if (!xferOutpoint) { err.textContent = 'No Verginal selected.'; return; }
    const btn = $('#xfer-confirm');
    btn.disabled = true; btn.textContent = 'Approve in wallet…';
    try {
      const r = await provider.transferInscription({ outpoint: xferOutpoint, to });
      closeTransfer();
      toast('Transfer broadcast. txid ' + short((r && r.txid) || ''));
      loadInscriptions();
    } catch (e) {
      err.textContent = '✗ ' + (e.message || String(e));
    } finally {
      btn.disabled = false; btn.textContent = 'Transfer';
    }
  }

  // --- tiny toast ------------------------------------------------------------------------
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4500);
  }

  // --- wiring ----------------------------------------------------------------------------
  async function tryConnect(btn) {
    const err = $('#wallet-error'); if (err) err.textContent = '';
    // No provider means the extension is not installed. Send the user to the store instead of
    // failing with a "not detected" error.
    if (!hasProvider()) { absent = true; reflect(); openStore(); return; }
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      await connect();
    } catch (e) {
      if (err) err.textContent = '✗ ' + (e.message || String(e));
    } finally {
      if (btn) { btn.disabled = false; if (!address) btn.textContent = prev || 'Connect Wallet'; }
    }
  }

  function activateWalletTab() {
    const tab = document.querySelector('.tab[data-tab="wallet"]');
    if (tab) { tab.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }

  function wire() {
    const header = $('#wallet-connect');
    if (header) header.addEventListener('click', () => { if (address) activateWalletTab(); else tryConnect(header); });
    const c2 = $('#wallet-connect-2');
    if (c2) c2.addEventListener('click', () => tryConnect(c2));
    const dc = $('#wallet-disconnect');
    if (dc) dc.addEventListener('click', disconnect);
    const rf = $('#wallet-refresh');
    if (rf) rf.addEventListener('click', loadInscriptions);
    const dz = $('#install-dismiss');
    if (dz) dz.addEventListener('click', () => { bannerDismissed = true; reflect(); });

    const cancel = $('#xfer-cancel');
    if (cancel) cancel.addEventListener('click', closeTransfer);
    const confirm = $('#xfer-confirm');
    if (confirm) confirm.addEventListener('click', confirmTransfer);
    const modal = $('#xfer-modal');
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeTransfer(); });

    // Refresh the list whenever the My Wallet tab is opened.
    const wtab = document.querySelector('.tab[data-tab="wallet"]');
    if (wtab) wtab.addEventListener('click', renderWalletTab);

    wirePay('pay-with-wallet', '#pay-address', '#pay-amount', '#paystatus-text', '#pay-error');
    wirePay('mint-pay-with-wallet', '#mint-pay-address', '#mint-amount', '#mint-paystatus-text', '#mint-pay-error');
  }

  // --- boot ------------------------------------------------------------------------------
  wire();
  reflect();
  // If the provider has not shown up after a short grace window, conclude the wallet is absent and
  // surface the install prompt. The provider injects at document_start, so a real install is present
  // well within this window.
  graceTimer = setTimeout(() => { if (!hasProvider()) { absent = true; reflect(); } }, 800);
  withProvider(async () => {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    absent = false;
    provider.on('connect', (d) => setAddress(d && d.address));
    provider.on('disconnect', () => setAddress(null));
    // Restore an existing session without prompting: getAddress returns null when not connected.
    try { const a = await provider.getAddress(); if (a) setAddress(a); } catch (_) { /* ignore */ }
    reflect();
  });

  // --- marketplace bridge (used by app.js's detail view + Market tab) ---------------------
  // Thin wrappers over the provider's trustless-swap methods. All signing + broadcasting happens
  // on-device in the extension; this only forwards the user's intent and returns the result.
  async function ensureConnected() {
    if (address) return address;
    if (!hasProvider()) { openStore(); throw new Error('Install the Verginals Wallet to trade.'); }
    if (!provider) throw new Error('Wallet not ready yet, reload the page.');
    const r = await provider.connect();
    setAddress(r && r.address);
    if (!address) throw new Error('connection was declined');
    return address;
  }

  // The marketplace methods only exist in wallet 0.10.0+. An older extension injects a provider
  // without them, so a method-presence check is an exact capability probe (no version parsing).
  function activeProvider() {
    return provider || (window.verge && window.verge.isVerginals ? window.verge : null);
  }

  window.VerginalsMarket = {
    installed: hasProvider,
    supported: () => { const p = activeProvider(); return !!(p && typeof p.listInscription === 'function'); },
    address: () => address,
    async list(outpoint, priceUnits, name) {
      await ensureConnected();
      return provider.listInscription({ outpoint, priceUnits, name });
    },
    async buy(outpoint, priceUnits, name) {
      await ensureConnected();
      return provider.buyListing({ outpoint, priceUnits, name });
    },
    async offer(outpoint, sellerAddress, carrierValue, priceUnits, name) {
      await ensureConnected();
      return provider.placeBid({ outpoint, sellerAddress, carrierValue, priceUnits, name });
    },
    async accept(outpoint, buyerAddress, priceUnits, name) {
      await ensureConnected();
      return provider.acceptBid({ outpoint, buyerAddress, priceUnits, name });
    },
    // Cancelling a listing = move the carrier (any self-transfer invalidates every signed variant;
    // the order book drops it once it sees the outpoint spent).
    async cancel(outpoint) {
      const me = await ensureConnected();
      return provider.transferInscription({ outpoint, to: me });
    },
  };

  // Arena bridge: connect, read the address, and sign a login challenge. signMessage exists in every
  // shipped wallet, so the Arena works even on the pre-marketplace 0.9.x build.
  window.VerginalsArena = {
    installed: hasProvider,
    supported: () => { const p = activeProvider(); return !!(p && typeof p.signMessage === 'function'); },
    address: () => address,
    connect: ensureConnected,
    async signMessage(message) {
      await ensureConnected();
      // The provider resolves { signature, address } (background.js); older builds may return the
      // base64 signature string directly. Hand the caller the base64 signature either way.
      const r = await provider.signMessage(message);
      return r && typeof r === 'object' ? r.signature : r;
    },
  };
})();
