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
// dApp approvals cannot use the toolbar dropdown (chrome.action.openPopup is gesture-restricted and
// would only open the wallet, not this screen). We deliberately use a separate popup WINDOW rather
// than an in-page overlay: a top-level chrome-extension:// window is fully isolated from the site, so
// even a compromised verginals.com cannot read it, cover it, or drive it. We keep it compact and
// pinned to the top-right so it reads like the wallet popup.
const APPROVE_W = 520;
const APPROVE_H = 760;
function requestApproval(request, sender) {
  return new Promise((resolve, reject) => {
    const rid = `r${Date.now()}-${++ridSeq}`;
    // Remember the tab/window that asked, so we can hand focus back to the site once the user decides.
    const siteTabId = sender && sender.tab && sender.tab.id;
    const siteWindowId = sender && sender.tab && sender.tab.windowId;
    pending.set(rid, { resolve, reject, request: { ...request, rid }, siteTabId, siteWindowId });
    const url = chrome.runtime.getURL(`ui/approve.html?rid=${encodeURIComponent(rid)}`);
    chrome.windows.getLastFocused({}, (parent) => {
      // If the parent window is maximized/fullscreen its geometry is the whole screen, so fall back
      // to a fixed top-right corner instead of borrowing it.
      let top = 78, left = 120;
      const parentNormal = parent && parent.state !== 'maximized' && parent.state !== 'fullscreen';
      if (parentNormal && typeof parent.left === 'number' && typeof parent.width === 'number') {
        left = parent.left + parent.width - APPROVE_W - 16;
        top = parent.top + 72;
      }
      top = Math.max(0, Math.round(top));
      left = Math.max(0, Math.round(left));
      chrome.windows.create({
        url, type: 'popup', width: APPROVE_W, height: APPROVE_H,
        top, left, focused: true, state: 'normal',
      }, (win) => {
        const entry = pending.get(rid);
        if (entry) entry.windowId = win && win.id;
        // Chrome sometimes reuses a previous popup's maximized state and ignores the requested
        // bounds; force size + position once the window exists so it never opens full screen.
        if (win && win.id != null) {
          chrome.windows.update(win.id, { state: 'normal', top, left, width: APPROVE_W, height: APPROVE_H });
        }
      });
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
async function handleRpc(method, params, origin, sender) {
  const w = getWallet();
  switch (method) {
    case 'connect': {
      const approval = await requestApproval({ type: 'connect', origin }, sender);
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
      const approval = await requestApproval({ type: 'transferInscription', origin, params }, sender);
      return w.transferInscription({
        carrierOutpoint: approval.carrierOutpoint,
        toAddress: params.to,
      });
    }
    case 'send': {
      await requireConnected(origin, w);
      await requestApproval({ type: 'send', origin, params }, sender);
      return w.send({ toAddress: params.to, amount: params.amount });
    }
    case 'signMessage': {
      await requireConnected(origin, w);
      await requestApproval({ type: 'signMessage', origin, params }, sender);
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

// When the user switches wallet/account in the popup, tell every connected site the active address
// changed (EIP-1193-style accountsChanged) so it can re-read the balance/inscriptions for the new one.
async function broadcastActiveChanged() {
  const address = getWallet().address;
  const origins = await getConnectedOrigins();
  for (const origin of origins) broadcastEvent(origin, 'accountsChanged', { address });
}

// --- popup (wallet UI) handlers --------------------------------------------
async function handleUi(action, payload) {
  const w = getWallet();
  switch (action) {
    case 'status': {
      return {
        exists: await w.exists(), unlocked: w.isUnlocked, address: w.address,
        hasMnemonic: await w.hasMnemonic(), active: w.isUnlocked ? w.activeInfo() : null,
      };
    }
    case 'create': {
      // Returns the mnemonic ONCE so the popup can show the backup screen; never returned again.
      const r = await w.create(payload.passphrase, payload.strength || 128);
      return { address: r.address, mnemonic: r.mnemonic, active: w.activeInfo() };
    }
    case 'importMnemonic': {
      const r = await w.importMnemonic(payload.mnemonic, payload.passphrase);
      return { address: r.address, active: w.activeInfo() };
    }
    case 'import': {
      const r = await w.importWIF(payload.wif, payload.passphrase);
      return { address: r.address, active: w.activeInfo() };
    }
    case 'unlock': {
      const r = await w.unlock(payload.passphrase);
      return { address: r.address, active: w.activeInfo() };
    }
    case 'lock': { w.lock(); return { locked: true }; }
    // --- multi-account (flat: each account is one address) ---
    case 'list': { return w.list(); }
    case 'addSeedAccount': {
      // Mint a brand new address with its OWN fresh recovery phrase; returns the phrase ONCE.
      const r = await w.addSeedAccount(payload.label, payload.strength || 128);
      await broadcastActiveChanged();
      return { address: r.address, mnemonic: r.mnemonic, active: w.activeInfo() };
    }
    case 'importAccount': {
      // Import an existing address from a WIF private key and switch to it.
      const r = await w.importAccount(payload.wif, payload.label);
      await broadcastActiveChanged();
      return { ...r, active: w.activeInfo() };
    }
    case 'importMnemonicAccount': {
      // Import an existing address from a recovery phrase (phrase kept, revealable) and switch to it.
      const r = await w.importMnemonicAccount(payload.mnemonic, payload.label);
      await broadcastActiveChanged();
      return { ...r, active: w.activeInfo() };
    }
    case 'selectAccount': {
      const r = await w.selectAccount(payload.id);
      await broadcastActiveChanged();
      return { ...r, active: w.activeInfo() };
    }
    case 'renameAccount': { return w.renameAccount(payload.id, payload.label); }
    case 'removeAccount': {
      const r = await w.removeAccount(payload.id);
      await broadcastActiveChanged();
      return { ...r, active: w.activeInfo() };
    }
    case 'getTotalBalance': { return w.getTotalBalance(); }
    case 'getBalance': { return w.getBalance(); }
    case 'revealMnemonic': { return { mnemonic: await w.revealMnemonic(payload.passphrase, payload.id) }; }
    case 'exportWIF': { return { wif: await w.exportWIF(payload.passphrase, payload.id) }; }
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
    // Close the approval window and hand focus back to the site tab the request came from, so the
    // user lands straight back on the page instead of on an empty popup or another window.
    if (entry.windowId != null) chrome.windows.remove(entry.windowId).catch(() => {});
    if (entry.siteTabId != null) chrome.tabs.update(entry.siteTabId, { active: true }).catch(() => {});
    if (entry.siteWindowId != null) chrome.windows.update(entry.siteWindowId, { focused: true }).catch(() => {});
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
        const result = await handleRpc(msg.method, msg.params || {}, origin, sender);
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
