// Background service worker: the ONLY place the wallet (and, while unlocked, the private key) lives.
// It routes three kinds of messages:
//   - 'verge-rpc'         from content scripts (the page's window.verge)   -> dApp provider methods
//   - 'wallet-ui'         from the extension popup                          -> create/import/unlock/...
//   - 'approval-*'        from the approval popup window                    -> approve/deny a request
//
// Security model:
//   - The key is decrypted into memory only while unlocked; if Chrome suspends this worker the key
//     is gone and the user must re-unlock. Nothing secret is ever persisted except the AES-GCM vault.
//   - Every state-changing dApp method (connect/transfer/send/signMessage) opens an approval popup
//     and blocks on the user's explicit decision. Read methods require the origin to be connected.
//   - `connectedOrigins` lives in chrome.storage.session (cleared when the browser restarts).

import { Wallet } from './lib/wallet.js';

let wallet = null;            // Wallet instance (holds key while unlocked)
const pending = new Map();    // rid -> { resolve, reject, request }
let ridSeq = 0;

function getWallet() {
  if (!wallet) wallet = new Wallet();
  return wallet;
}

// --- connected-origin allowlist (session-scoped) ---------------------------
async function getConnectedOrigins() {
  const r = await chrome.storage.session.get('connectedOrigins');
  return new Set(r.connectedOrigins || []);
}
async function setConnected(origin, on) {
  const set = await getConnectedOrigins();
  if (on) set.add(origin); else set.delete(origin);
  await chrome.storage.session.set({ connectedOrigins: [...set] });
}
async function isConnected(origin) { return (await getConnectedOrigins()).has(origin); }

// --- approval popups -------------------------------------------------------
function requestApproval(request) {
  return new Promise((resolve, reject) => {
    const rid = `r${Date.now()}-${++ridSeq}`;
    pending.set(rid, { resolve, reject, request: { ...request, rid } });
    const url = chrome.runtime.getURL(`ui/approve.html?rid=${encodeURIComponent(rid)}`);
    chrome.windows.create({ url, type: 'popup', width: 380, height: 560, focused: true }, (win) => {
      const entry = pending.get(rid);
      if (entry) entry.windowId = win && win.id;
    });
  });
}
// If the approval window is closed without a decision, treat it as a denial.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [rid, entry] of pending) {
    if (entry.windowId === windowId) {
      pending.delete(rid);
      entry.reject(new Error('request rejected: window closed'));
    }
  }
});

// --- dApp RPC handlers -----------------------------------------------------
async function handleRpc(method, params, origin) {
  const w = getWallet();
  switch (method) {
    case 'connect': {
      const approval = await requestApproval({ type: 'connect', origin });
      // approval carries the (now unlocked) address chosen by the user.
      await setConnected(origin, true);
      broadcastEvent(origin, 'connect', { address: approval.address });
      return { address: approval.address };
    }
    case 'getAddress': {
      if (!(await isConnected(origin))) return null;
      return w.isUnlocked ? w.address : null;
    }
    case 'disconnect': {
      await setConnected(origin, false);
      broadcastEvent(origin, 'disconnect', {});
      return true;
    }
    case 'getBalance': {
      await requireConnected(origin, w);
      return w.getBalance();
    }
    case 'getInscriptions': {
      await requireConnected(origin, w);
      const { inscriptions } = await w.getBalance();
      return inscriptions;
    }
    case 'transferInscription': {
      await requireConnected(origin, w);
      const approval = await requestApproval({ type: 'transferInscription', origin, params });
      return w.transferInscription({
        carrierOutpoint: approval.carrierOutpoint,
        toAddress: params.to,
      });
    }
    case 'send': {
      await requireConnected(origin, w);
      await requestApproval({ type: 'send', origin, params });
      return w.send({ toAddress: params.to, amount: params.amount });
    }
    case 'signMessage': {
      await requireConnected(origin, w);
      await requestApproval({ type: 'signMessage', origin, params });
      const sig = await w.signMessage(params.message);
      return { signature: sig, address: w.address };
    }
    default:
      throw new Error('unknown method: ' + method);
  }
}

async function requireConnected(origin, w) {
  if (!(await isConnected(origin))) throw new Error('not connected: call verge.connect() first');
  if (!w.isUnlocked) throw new Error('wallet is locked: open the extension and unlock');
}

function broadcastEvent(origin, event, data) {
  chrome.tabs.query({ url: origin + '/*' }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { kind: 'verge-event', event, data }).catch(() => {});
  });
}

// --- popup (wallet UI) handlers --------------------------------------------
async function handleUi(action, payload) {
  const w = getWallet();
  switch (action) {
    case 'status': {
      return { exists: await w.exists(), unlocked: w.isUnlocked, address: w.address, hasMnemonic: await w.hasMnemonic() };
    }
    case 'create': {
      // Returns the mnemonic ONCE so the popup can show the backup screen; never returned again.
      const r = await w.create(payload.passphrase, payload.strength || 128);
      return { address: r.address, mnemonic: r.mnemonic };
    }
    case 'importMnemonic': {
      const r = await w.importMnemonic(payload.mnemonic, payload.passphrase);
      return { address: r.address };
    }
    case 'import': {
      const r = await w.importWIF(payload.wif, payload.passphrase);
      return { address: r.address };
    }
    case 'unlock': {
      const r = await w.unlock(payload.passphrase);
      return { address: r.address };
    }
    case 'lock': { w.lock(); return { locked: true }; }
    case 'getTotalBalance': { return w.getTotalBalance(); }
    case 'getBalance': { return w.getBalance(); }
    case 'revealMnemonic': { return { mnemonic: await w.revealMnemonic(payload.passphrase) }; }
    case 'exportWIF': { return { wif: await w.exportWIF(payload.passphrase) }; }
    case 'getInscriptionContent': { return w.getInscriptionContent(payload.id); }
    case 'getHistory': { return { history: await w.getHistory() }; }
    case 'transfer': { return w.transferInscription({ carrierOutpoint: payload.carrierOutpoint, toAddress: payload.to }); }
    case 'send': { return w.send({ toAddress: payload.to, amount: payload.amount }); }
    default: throw new Error('unknown ui action: ' + action);
  }
}

// --- approval popup handlers -----------------------------------------------
async function handleApproval(kind, payload) {
  const entry = pending.get(payload.rid);
  if (!entry) throw new Error('no such pending request');
  const w = getWallet();

  if (kind === 'approval-get') {
    // Give the popup what it needs to render, including unlock state + (for transfer) the resolved
    // carrier outpoint so the user sees exactly which Verginal moves.
    const req = entry.request;
    let extra = {};
    if (req.type === 'transferInscription' && w.isUnlocked) {
      try {
        const carrier = await resolveCarrier(w, req.params);
        extra.carrier = carrier;
      } catch (e) { extra.resolveError = e.message; }
    }
    return { request: req, unlocked: w.isUnlocked, address: w.address, ...extra };
  }

  if (kind === 'approval-unlock') {
    await w.unlock(payload.passphrase);
    return { unlocked: true, address: w.address };
  }

  if (kind === 'approval-decision') {
    pending.delete(payload.rid);
    if (!payload.approved) { entry.reject(new Error('request rejected by user')); return { ok: true }; }
    if (!w.isUnlocked) { entry.reject(new Error('wallet locked')); return { ok: true }; }
    const req = entry.request;
    if (req.type === 'transferInscription') {
      const carrier = await resolveCarrier(w, req.params);
      entry.resolve({ address: w.address, carrierOutpoint: carrier.outpoint });
    } else {
      entry.resolve({ address: w.address });
    }
    return { ok: true };
  }
  throw new Error('unknown approval kind: ' + kind);
}

// Resolve which UTXO carries the requested inscription (by explicit outpoint or by inscription id).
async function resolveCarrier(w, params) {
  const { inscriptions } = await w.getBalance();
  let hit;
  if (params.outpoint) hit = inscriptions.find((u) => `${u.txid}:${u.vout}` === params.outpoint);
  else if (params.id) hit = inscriptions.find((u) => u.inscription && u.inscription.id === params.id);
  if (!hit) throw new Error('inscription not found in this wallet');
  return { outpoint: `${hit.txid}:${hit.vout}`, value: hit.value, inscription: hit.inscription };
}

// --- router ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.kind === 'verge-rpc') {
        const origin = (sender && sender.origin) || msg.origin;
        const result = await handleRpc(msg.method, msg.params || {}, origin);
        sendResponse({ result });
      } else if (msg.kind === 'wallet-ui') {
        sendResponse({ result: await handleUi(msg.action, msg.payload || {}) });
      } else if (msg.kind && msg.kind.startsWith('approval-')) {
        sendResponse({ result: await handleApproval(msg.kind, msg.payload || {}) });
      } else {
        sendResponse({ error: 'unknown message kind' });
      }
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // async response
});
