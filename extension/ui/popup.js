// Popup UI logic. Talks to the background worker via chrome.runtime.sendMessage({kind:'wallet-ui'}).
// Holds no secrets: passphrases are passed to the background only to unlock/create/reveal and are not
// retained here. The recovery phrase is shown exactly once (right after creation) or on explicit,
// passphrase-gated reveal.

const COIN = 1_000_000;
const $ = (id) => document.getElementById(id);
const EXPLORER_TX = 'https://verge-blockchain.info/tx/';

function ui(action, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ kind: 'wallet-ui', action, payload }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('no response'));
      if (resp.error) return reject(new Error(resp.error));
      resolve(resp.result);
    });
  });
}

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3400);
}

function show(section) {
  for (const id of ['setup', 'backup', 'locked', 'home']) $(id).hidden = id !== section;
  $('lockBtn').hidden = section !== 'home';
  $('settingsBtn').hidden = section !== 'home';
}

function fmtXvg(units) {
  return (units / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// Parse an XVG decimal string into atomic units without float drift.
function xvgToUnits(str) {
  const s = String(str).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('enter a valid amount');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 6) throw new Error('max 6 decimals');
  const units = BigInt(whole || '0') * BigInt(COIN) + BigInt((frac + '000000').slice(0, 6));
  const n = Number(units);
  if (n <= 0) throw new Error('amount must be positive');
  return n;
}

// ============================ setup ============================
let createStrength = 128;

document.querySelectorAll('#setup .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#setup .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('tab-create').hidden = tab.dataset.tab !== 'create';
    $('tab-import').hidden = tab.dataset.tab !== 'import';
  });
});

document.querySelectorAll('[data-strength]').forEach((b) => {
  b.addEventListener('click', () => {
    createStrength = Number(b.dataset.strength);
    document.querySelectorAll('[data-strength]').forEach((x) => x.classList.toggle('active', x === b));
  });
});

document.querySelectorAll('[data-imp]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-imp]').forEach((x) => x.classList.toggle('active', x === b));
    $('imp-phrase').hidden = b.dataset.imp !== 'phrase';
    $('imp-wif').hidden = b.dataset.imp !== 'wif';
  });
});

$('createBtn').addEventListener('click', async () => {
  const p1 = $('createPass').value, p2 = $('createPass2').value;
  if (p1.length < 8) return toast('Use at least 8 characters', 'err');
  if (p1 !== p2) return toast('Passphrases do not match', 'err');
  try {
    const r = await ui('create', { passphrase: p1, strength: createStrength });
    $('addr').textContent = r.address;
    presentBackup(r.mnemonic);
  } catch (e) { toast(e.message, 'err'); }
});

$('importBtn').addEventListener('click', async () => {
  const pass = $('importPass').value;
  if (pass.length < 8) return toast('Use at least 8 characters', 'err');
  const usingPhrase = !$('imp-phrase').hidden;
  try {
    let r;
    if (usingPhrase) {
      const mnemonic = $('importPhrase').value.trim().replace(/\s+/g, ' ');
      if (!mnemonic) return toast('Enter your recovery phrase', 'err');
      r = await ui('importMnemonic', { mnemonic, passphrase: pass });
    } else {
      const wif = $('importWif').value.trim();
      if (!wif) return toast('Enter a WIF private key', 'err');
      r = await ui('import', { wif, passphrase: pass });
    }
    toast('Wallet imported', 'ok');
    $('addr').textContent = r.address;
    enterHome();
  } catch (e) { toast(e.message, 'err'); }
});

// ============================ backup phrase ============================
function presentBackup(mnemonic) {
  const grid = $('phraseGrid');
  grid.innerHTML = '';
  for (const w of mnemonic.split(' ')) {
    const li = document.createElement('li');
    li.textContent = w;
    grid.appendChild(li);
  }
  $('phraseAck').checked = false;
  $('phraseDoneBtn').disabled = true;
  $('copyPhraseBtn').onclick = () => navigator.clipboard.writeText(mnemonic).then(() => toast('Phrase copied', 'ok'));
  show('backup');
}
$('phraseAck').addEventListener('change', (e) => { $('phraseDoneBtn').disabled = !e.target.checked; });
$('phraseDoneBtn').addEventListener('click', () => { toast('Wallet ready', 'ok'); enterHome(); });

// ============================ unlock ============================
$('unlockBtn').addEventListener('click', async () => {
  try {
    const r = await ui('unlock', { passphrase: $('unlockPass').value });
    $('addr').textContent = r.address;
    enterHome();
  } catch (e) { toast(e.message, 'err'); }
});
$('lockBtn').addEventListener('click', async () => { await ui('lock'); show('locked'); });

// ============================ home ============================
function enterHome() {
  show('home');
  const addr = $('addr').textContent;
  $('recvAddr').textContent = addr;
  renderQr(addr);
  refreshWallets();
  refreshHome();
}

// Point the home screen (address label, receive box, QR) at `address`.
function setAddress(address) {
  $('addr').textContent = address;
  $('recvAddr').textContent = address;
  renderQr(address);
}

// tab nav (XVG / Verginals / Activity)
document.querySelectorAll('.tabbtn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabbtn').forEach((x) => x.classList.toggle('active', x === b));
    $('view-xvg').hidden = b.dataset.view !== 'xvg';
    $('view-verginals').hidden = b.dataset.view !== 'verginals';
    $('view-history').hidden = b.dataset.view !== 'history';
    if (b.dataset.view === 'history') renderHistory(); // lazy: only hit ElectrumX when opened
  });
});
// send/receive segmented control
document.querySelectorAll('[data-pane]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-pane]').forEach((x) => x.classList.toggle('active', x === b));
    $('pane-send').hidden = b.dataset.pane !== 'send';
    $('pane-receive').hidden = b.dataset.pane !== 'receive';
  });
});

function renderQr(text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    $('qrcode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  } catch { $('qrcode').textContent = 'QR unavailable'; }
}

// Two-phase refresh: show the total instantly as a provisional sub-line while detection runs, then
// promote the headline to the SPENDABLE figure with the full split. The headline never shows the
// higher total, so the number only ever settles downward-free (no "did I lose coins?" flicker).
async function refreshHome() {
  const list = $('inscList');
  try {
    const quick = await ui('getTotalBalance');
    $('balSub').textContent = `${fmtXvg(quick.total)} total · checking coins…`;
    list.innerHTML = '<li class="muted">Checking your coins&hellip;</li>';
  } catch { /* full pass reports errors */ }
  try {
    const bal = await ui('getBalance');
    // Big number stays the FULL balance; the sub-line splits it into what can actually be spent vs
    // what is locked (Verginal carriers + coins we could not prove clean, both excluded from sends).
    const blocked = bal.total - bal.spendable;
    // Headline number is the SPENDABLE balance (what you can actually send); the sub-line breaks
    // out locked coins and Verginals so the full total is still reconstructable at a glance.
    $('balance').textContent = fmtXvg(bal.spendable);
    $('spendable').textContent = fmtXvg(bal.spendable) + ' XVG';
    const parts = [`${fmtXvg(bal.spendable)} spendable`];
    if (blocked > 0) parts.push(`${fmtXvg(blocked)} locked`);
    if (bal.inscriptions.length) parts.push(`${bal.inscriptions.length} Verginal${bal.inscriptions.length > 1 ? 's' : ''}`);
    $('balSub').textContent = parts.join(' · ');
    $('inscCount').textContent = bal.inscriptions.length ? `(${bal.inscriptions.length})` : '';
    renderInscriptions(bal.inscriptions);
  } catch (e) { toast(e.message, 'err'); }
}

// Activity: recent transactions for this address, each linking out to the Verge block explorer.
async function renderHistory() {
  const list = $('histList');
  list.innerHTML = '<li class="muted">Loading&hellip;</li>';
  try {
    const { history } = await ui('getHistory');
    if (!history.length) { list.innerHTML = '<li class="muted">No transactions yet.</li>'; return; }
    list.innerHTML = '';
    for (const h of history) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'hist-link mono';
      a.href = EXPLORER_TX + h.txid;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${h.txid.slice(0, 10)}…${h.txid.slice(-8)}`;
      const status = document.createElement('span');
      status.className = 'hist-status';
      status.textContent = h.height && h.height > 0 ? `#${h.height}` : 'pending';
      if (!(h.height && h.height > 0)) status.classList.add('pending');
      li.append(a, status);
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li class="muted">${e.message}</li>`;
  }
}

function renderInscriptions(inscriptions) {
  const list = $('inscList');
  if (!inscriptions.length) {
    list.className = 'insc-list';
    list.innerHTML = '<li class="muted">No Verginals in this wallet yet.</li>';
    return;
  }
  // Unisat-style 2-column card grid: image/text thumbnail on top, number + Transfer below. Each
  // card lazy-loads its own content so the grid paints instantly and previews fill in as they arrive.
  list.className = 'insc-grid';
  list.innerHTML = '';
  for (const u of inscriptions) {
    const insc = u.inscription || {};
    const num = insc.number != null ? `#${insc.number}` : 'Verginal';
    const outpoint = `${u.txid}:${u.vout}`;

    const li = document.createElement('li');
    li.className = 'insc-card';

    const thumb = document.createElement('div');
    thumb.className = 'insc-thumb';
    thumb.textContent = '...';

    const num_el = document.createElement('span');
    num_el.className = 'insc-num';
    num_el.textContent = num;

    const loc = document.createElement('span');
    loc.className = 'insc-loc';
    loc.textContent = `${u.txid.slice(0, 8)}...:${u.vout}`;

    const btn = document.createElement('button');
    btn.className = 'ghost insc-xfer';
    btn.textContent = 'Transfer';
    btn.onclick = () => openTransfer(outpoint, num);

    li.append(thumb, num_el, loc, btn);
    list.appendChild(li);

    loadPreview(thumb, insc.id);
  }
}

// Fetch one Verginal's content and render it into its card thumbnail. Images render as <img>,
// text/plain renders inline. Failures leave a neutral placeholder; they never block the grid.
async function loadPreview(thumb, id) {
  if (!id) { thumb.textContent = '?'; return; }
  try {
    const { contentType, base64 } = await ui('getInscriptionContent', { id });
    const ct = (contentType || '').toLowerCase();
    if (ct.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = `data:${contentType};base64,${base64}`;
      img.alt = 'Verginal';
      thumb.textContent = '';
      thumb.appendChild(img);
    } else if (ct.startsWith('text/')) {
      const txt = decodeURIComponent(escape(atob(base64)));
      thumb.textContent = '';
      const pre = document.createElement('span');
      pre.className = 'insc-text';
      pre.textContent = txt.slice(0, 140);
      thumb.appendChild(pre);
    } else {
      thumb.textContent = ct || 'data';
    }
  } catch {
    thumb.textContent = '?';
  }
}

$('refreshBtn').addEventListener('click', refreshHome);
$('addr').addEventListener('click', () => navigator.clipboard.writeText($('addr').textContent).then(() => toast('Address copied', 'ok')));
$('copyAddrBtn').addEventListener('click', () => navigator.clipboard.writeText($('recvAddr').textContent).then(() => toast('Address copied', 'ok')));

// send XVG
$('sendBtn').addEventListener('click', async () => {
  const to = $('sendTo').value.trim();
  if (!to) return toast('Enter a recipient address', 'err');
  let amount;
  try { amount = xvgToUnits($('sendAmt').value); } catch (e) { return toast(e.message, 'err'); }
  $('sendBtn').disabled = true;
  try {
    const r = await ui('send', { to, amount });
    toast(`Sent. txid ${r.txid.slice(0, 12)}...`, 'ok');
    $('sendTo').value = ''; $('sendAmt').value = '';
    refreshHome();
  } catch (e) { toast(e.message, 'err'); } finally { $('sendBtn').disabled = false; }
});

// ============================ transfer Verginal ============================
let transferOutpoint = null;
function openTransfer(outpoint, label) {
  transferOutpoint = outpoint;
  $('transferWhich').textContent = `${label} · ${outpoint.slice(0, 14)}...`;
  $('transferTo').value = '';
  $('transferSheet').hidden = false;
}
$('transferConfirmBtn').addEventListener('click', async () => {
  const to = $('transferTo').value.trim();
  if (!to) return toast('Enter a recipient address', 'err');
  $('transferConfirmBtn').disabled = true;
  try {
    const r = await ui('transfer', { carrierOutpoint: transferOutpoint, to });
    toast(`Verginal sent. txid ${r.txid.slice(0, 12)}...`, 'ok');
    $('transferSheet').hidden = true;
    refreshHome();
  } catch (e) { toast(e.message, 'err'); } finally { $('transferConfirmBtn').disabled = false; }
});

// ============================ settings / backup ============================
$('settingsBtn').addEventListener('click', () => {
  $('settingsMenu').hidden = false;
  $('settingsReveal').hidden = true;
  $('settingsAbout').hidden = true;
  $('revealOut').hidden = true;
  $('revealPass').value = '';
  const act = activeAccount();
  $('revealPhraseBtn').hidden = !(act && act.kind === 'seed'); // key-only addresses have no phrase
  $('settings').hidden = false;
});
$('aboutBtn').addEventListener('click', () => {
  $('settingsMenu').hidden = true;
  $('aboutVersion').textContent = 'v' + chrome.runtime.getManifest().version;
  $('settingsAbout').hidden = false;
});
document.querySelectorAll('.closeSheet').forEach((b) => b.addEventListener('click', () => {
  const ov = b.closest('.overlay');
  if (ov) ov.hidden = true;
}));

let revealMode = null; // 'phrase' | 'wif'
function startReveal(mode) {
  revealMode = mode;
  $('settingsMenu').hidden = true;
  $('settingsReveal').hidden = false;
  $('revealOut').hidden = true;
  $('revealPass').value = '';
  $('revealWarn').textContent = mode === 'phrase'
    ? 'Anyone with your recovery phrase can take your funds. Make sure no one is watching.'
    : 'Anyone with your private key can take your funds. Make sure no one is watching.';
}
$('revealPhraseBtn').addEventListener('click', () => startReveal('phrase'));
$('revealConfirmBtn').addEventListener('click', async () => {
  const passphrase = $('revealPass').value;
  if (!passphrase) return toast('Enter your passphrase', 'err');
  try {
    const out = $('revealOut');
    if (revealMode === 'phrase') {
      const r = await ui('revealMnemonic', { passphrase });
      out.textContent = r.mnemonic;
    } else {
      const r = await ui('exportWIF', { passphrase });
      out.textContent = r.wif;
    }
    out.hidden = false;
    $('revealPass').value = '';
  } catch (e) { toast(e.message, 'err'); }
});

// ============================ accounts (addresses) ============================
// Non-secret snapshot of the keyring, kept in sync via ui('list'). Each account is one independent
// address: either its own recovery phrase ('seed') or a standalone private key ('key').
let walletsState = { activeId: null, accounts: [] };

async function refreshWallets() {
  try {
    walletsState = await ui('list');
    renderSelector();
    if (!$('accounts').hidden) renderAccountList();
  } catch { /* selector just shows a placeholder */ }
}

function activeAccount() {
  return walletsState.accounts.find((a) => a.id === walletsState.activeId) || walletsState.accounts[0] || null;
}

function renderSelector() {
  const cur = activeAccount();
  $('selAccount').textContent = cur ? cur.label : 'Address';
}

function shortAddr(a) { return a ? `${a.slice(0, 10)}…${a.slice(-6)}` : ''; }

function renderAccountList() {
  const root = $('acctList');
  root.innerHTML = '';
  for (const a of walletsState.accounts) {
    const li = document.createElement('li');
    li.className = 'wl-acct';
    if (a.id === walletsState.activeId) li.classList.add('active');

    const main = document.createElement('button');
    main.className = 'wl-acct-main';
    main.onclick = () => switchTo(a.id);
    const nm = document.createElement('span');
    nm.className = 'wl-acct-name';
    nm.textContent = a.label;
    if (a.kind === 'key') {
      const tag = document.createElement('span');
      tag.className = 'wl-tag';
      tag.textContent = 'key';
      nm.appendChild(tag);
    }
    const ad = document.createElement('span');
    ad.className = 'wl-acct-addr mono';
    ad.textContent = shortAddr(a.address);
    main.append(nm, ad);

    const g = document.createElement('button');
    g.className = 'icon wl-gear';
    g.innerHTML = '&#9881;';
    g.title = 'Address settings';
    g.onclick = () => openAcctSettings(a.id);

    li.append(main, g);
    root.appendChild(li);
  }
}

async function switchTo(id) {
  try {
    const r = await ui('selectAccount', { id });
    setAddress(r.address);
    $('accounts').hidden = true;
    await refreshWallets();
    refreshHome();
  } catch (e) { toast(e.message, 'err'); }
}

$('acctSelector').addEventListener('click', () => { renderAccountList(); $('accounts').hidden = false; });

// ---- add an address (new own-phrase / import phrase / import private key) ----
// "New" mints a fully independent address with its own fresh recovery phrase (shown once, exactly
// like the wallet's very first address). "Recovery phrase" / "Private key" import an existing address.
let addMode = 'new';
let addStrength = 128;
function setAddMode(mode) {
  addMode = mode;
  document.querySelectorAll('[data-addmode]').forEach((b) => b.classList.toggle('active', b.dataset.addmode === mode));
  $('addmode-new').hidden = mode !== 'new';
  $('addmode-phrase').hidden = mode !== 'phrase';
  $('addmode-wif').hidden = mode !== 'wif';
}
$('addAddressBtn').addEventListener('click', () => {
  $('addAddressLabel').value = '';
  $('addAddressPhrase').value = '';
  $('addAddressWif').value = '';
  addStrength = 128;
  document.querySelectorAll('[data-addstrength]').forEach((x) => x.classList.toggle('active', Number(x.dataset.addstrength) === 128));
  setAddMode('new');
  $('addAddressSheet').hidden = false;
});
document.querySelectorAll('[data-addmode]').forEach((b) => b.addEventListener('click', () => setAddMode(b.dataset.addmode)));
document.querySelectorAll('[data-addstrength]').forEach((b) => b.addEventListener('click', () => {
  addStrength = Number(b.dataset.addstrength);
  document.querySelectorAll('[data-addstrength]').forEach((x) => x.classList.toggle('active', x === b));
}));
$('addAddressConfirmBtn').addEventListener('click', async () => {
  const label = $('addAddressLabel').value.trim();
  let action, payload;
  if (addMode === 'new') { action = 'addSeedAccount'; payload = { label, strength: addStrength }; }
  else if (addMode === 'phrase') {
    const mnemonic = $('addAddressPhrase').value.trim().replace(/\s+/g, ' ');
    if (!mnemonic) return toast('Enter a recovery phrase', 'err');
    action = 'importMnemonicAccount'; payload = { mnemonic, label };
  } else {
    const wif = $('addAddressWif').value.trim();
    if (!wif) return toast('Enter a private key', 'err');
    action = 'importAccount'; payload = { wif, label };
  }
  $('addAddressConfirmBtn').disabled = true;
  try {
    const r = await ui(action, payload);
    $('addAddressSheet').hidden = true;
    $('accounts').hidden = true;
    await refreshWallets();
    // A brand new own-phrase address shows its recovery phrase once for backup, then lands home on it.
    if (addMode === 'new' && r.mnemonic) {
      $('addr').textContent = r.address;
      presentBackup(r.mnemonic);
      return;
    }
    setAddress(r.address);
    refreshHome();
    toast('Address added', 'ok');
  } catch (e) { toast(e.message, 'err'); } finally { $('addAddressConfirmBtn').disabled = false; }
});

// ---- account (address) settings ----
let settingsAcct = null; // account id
let acctRevealMode = null; // 'phrase' | 'wif'
function openAcctSettings(id) {
  settingsAcct = id;
  const a = walletsState.accounts.find((x) => x.id === id);
  $('acctSettingsTitle').textContent = a ? a.label : 'Address';
  $('acctAddrLine').textContent = a ? (a.address || '') : '';
  $('acctRenameInput').value = a ? a.label : '';
  // Only own-phrase ('seed') addresses can reveal a recovery phrase; key-only imports cannot.
  $('acctRevealPhraseBtn').hidden = !(a && a.kind === 'seed');
  $('acctReveal').hidden = true;
  $('acctRevealOut').hidden = true;
  $('acctRevealPass').value = '';
  acctRevealMode = null;
  $('acctRemoveBtn').disabled = walletsState.accounts.length <= 1;
  $('acctSettings').hidden = false;
}
function startAcctReveal(mode) {
  acctRevealMode = mode;
  $('acctReveal').hidden = false;
  $('acctRevealOut').hidden = true;
  $('acctRevealPass').value = '';
  $('acctRevealWarn').textContent = mode === 'phrase'
    ? 'Anyone with your recovery phrase can take the funds on this address. Make sure no one is watching.'
    : 'Anyone with your private key can take the funds on this address. Make sure no one is watching.';
}
$('acctRenameBtn').addEventListener('click', async () => {
  const label = $('acctRenameInput').value.trim();
  if (!label) return toast('Enter a name', 'err');
  try {
    await ui('renameAccount', { id: settingsAcct, label });
    $('acctSettingsTitle').textContent = label;
    await refreshWallets();
    toast('Renamed', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});
$('acctRevealPhraseBtn').addEventListener('click', () => startAcctReveal('phrase'));
$('acctExportBtn').addEventListener('click', () => startAcctReveal('wif'));
$('acctRevealConfirmBtn').addEventListener('click', async () => {
  const passphrase = $('acctRevealPass').value;
  if (!passphrase) return toast('Enter your passphrase', 'err');
  try {
    if (acctRevealMode === 'phrase') {
      const r = await ui('revealMnemonic', { passphrase, id: settingsAcct });
      $('acctRevealOut').textContent = r.mnemonic;
    } else {
      const r = await ui('exportWIF', { passphrase, id: settingsAcct });
      $('acctRevealOut').textContent = r.wif;
    }
    $('acctRevealOut').hidden = false;
    $('acctRevealPass').value = '';
  } catch (e) { toast(e.message, 'err'); }
});
$('acctRemoveBtn').addEventListener('click', async () => {
  if (!confirm('Remove this address from the wallet?')) return;
  try {
    const r = await ui('removeAccount', { id: settingsAcct });
    setAddress(r.address);
    $('acctSettings').hidden = true;
    await refreshWallets();
    refreshHome();
    toast('Address removed', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// Live-update the active address if the background switches it (e.g. from a dApp-driven flow).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === 'verge-event' && msg.event === 'accountsChanged' && msg.data && msg.data.address) {
    if ($('home') && !$('home').hidden) { setAddress(msg.data.address); refreshWallets(); refreshHome(); }
  }
});

// ============================ boot ============================
async function boot() {
  const st = await ui('status');
  if (!st.exists) { show('setup'); return; }
  if (!st.unlocked) { show('locked'); return; }
  $('addr').textContent = st.address;
  enterHome();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('locked').hidden) $('unlockBtn').click();
});

boot();
