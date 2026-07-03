// Page-world provider: defines window.verge on verginals.com. Runs in the PAGE's JS world (injected
// by the content script) so the site can call it directly. It holds NO keys and does NO crypto: it
// just forwards requests to the content script (window.postMessage), which relays to the background
// service worker where the wallet lives. Every state-changing method requires explicit user
// approval in the extension UI.
(function () {
  if (window.verge) return; // already injected

  const REQ = 'verge:request';
  const RES = 'verge:response';
  const EVT = 'verge:event';
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || typeof ev.data !== 'object') return;
    const d = ev.data;
    if (d.channel === RES && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) reject(new Error(d.error));
      else resolve(d.result);
    } else if (d.channel === EVT && d.event) {
      emit(d.event, d.data);
    }
  });

  function call(method, params) {
    const id = `${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ channel: REQ, id, method, params: params || {} }, window.location.origin);
    });
  }

  // --- tiny event emitter ---
  const listeners = {};
  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return api; }
  function off(event, fn) { if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== fn); return api; }
  function emit(event, data) { (listeners[event] || []).forEach((f) => { try { f(data); } catch {} }); }

  const api = {
    isVerginals: true,
    version: '0.1.0',

    /** Request connection; prompts the user. Resolves { address } or rejects if denied. */
    connect: () => call('connect'),
    /** Currently connected address, or null. Does not prompt. */
    getAddress: () => call('getAddress'),
    /** { spendable, inscriptions:[{txid,vout,value,inscription}] }. Requires prior connect. */
    getBalance: () => call('getBalance'),
    /** List the Verginals held by the connected wallet. */
    getInscriptions: () => call('getInscriptions'),
    /**
     * Transfer one Verginal to `to`. Identify it by `outpoint` ("txid:vout") or `id` (inscription id).
     * Prompts the user to review + approve. Resolves { txid }.
     */
    transferInscription: (opts) => call('transferInscription', opts),
    /** Send spendable XVG. { to, amount } amount in atomic units. Prompts to approve. */
    send: (opts) => call('send', opts),
    /** Sign a text message (Verge magic hash). Prompts to approve. Resolves base64 signature. */
    signMessage: (message) => call('signMessage', { message }),
    /** Disconnect this site. */
    disconnect: () => call('disconnect'),

    on, off,
  };

  Object.defineProperty(window, 'verge', { value: Object.freeze(api), writable: false, configurable: false });
  window.dispatchEvent(new Event('verge#initialized'));
})();
