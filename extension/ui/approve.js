// Approval popup logic. Reads the pending request from the background by rid, renders it, lets the
// user unlock (if needed) and approve/reject. The decision is sent back to the background, which
// resolves or rejects the original dApp promise.

const COIN = 1_000_000;
const $ = (id) => document.getElementById(id);
const rid = new URLSearchParams(location.search).get('rid');

function bg(kind, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ kind, payload: { ...payload, rid } }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('no response'));
      if (resp.error) return reject(new Error(resp.error));
      resolve(resp.result);
    });
  });
}

function fmtXvg(units) { return (units / COIN).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = false; }

const TITLES = {
  connect: 'Connect this wallet',
  transferInscription: 'Transfer a Verginal',
  send: 'Send XVG',
  signMessage: 'Sign a message',
};

function renderDetails(req, extra) {
  const d = $('details');
  d.innerHTML = '';
  const row = (k, v) => { const el = document.createElement('div'); el.className = 'kv'; el.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`; d.appendChild(el); };
  if (req.type === 'connect') {
    row('Address', extra.address ? shorten(extra.address) : '(unlock to reveal)');
    row('Grants', 'view balance + request approvals');
  } else if (req.type === 'transferInscription') {
    if (extra.carrier) {
      const n = extra.carrier.inscription && extra.carrier.inscription.number != null ? `#${extra.carrier.inscription.number}` : '(inscription)';
      row('Verginal', n);
      row('Carrier', extra.carrier.outpoint);
    } else if (extra.resolveError) {
      row('Verginal', 'NOT FOUND: ' + extra.resolveError);
    } else {
      row('Verginal', req.params.outpoint || req.params.id || '(unlock to resolve)');
    }
    row('To', shorten(req.params.to));
  } else if (req.type === 'send') {
    row('Amount', fmtXvg(req.params.amount) + ' XVG');
    row('To', shorten(req.params.to));
  } else if (req.type === 'signMessage') {
    const el = document.createElement('pre'); el.className = 'msg'; el.textContent = req.params.message; d.appendChild(el);
  }
}

function shorten(s) { return s && s.length > 20 ? s.slice(0, 10) + '...' + s.slice(-6) : s; }

async function load() {
  try {
    const info = await bg('approval-get', {});
    const req = info.request;
    $('origin').textContent = new URL(req.origin).host;
    $('title').textContent = TITLES[req.type] || req.type;
    renderDetails(req, info);

    if (!info.unlocked) {
      $('unlockWrap').hidden = false;
      $('actions').hidden = true;
    } else {
      $('unlockWrap').hidden = true;
      $('actions').hidden = false;
    }
  } catch (e) { showErr(e.message); }
}

$('unlockBtn').addEventListener('click', async () => {
  try {
    await bg('approval-unlock', { passphrase: $('unlockPass').value });
    await load(); // re-render with resolved details now that we're unlocked
  } catch (e) { showErr(e.message); }
});

$('approveBtn').addEventListener('click', async () => {
  $('approveBtn').disabled = true;
  try { await bg('approval-decision', { approved: true }); window.close(); }
  catch (e) { showErr(e.message); $('approveBtn').disabled = false; }
});

$('rejectBtn').addEventListener('click', async () => {
  try { await bg('approval-decision', { approved: false }); } catch {}
  window.close();
});

load();
