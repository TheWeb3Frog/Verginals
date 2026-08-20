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
      // Never hang forever: if the background never answers (e.g. the MV3 service worker was
      // suspended mid-op), reject with a clear message instead of leaving the dApp stuck.
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('the wallet did not respond in time. If you approved the action, it may still have gone through. Check My Wallet before retrying.'));
      }, 120000);
      pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
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
    version: '0.3.0',

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

    // --- marketplace (trustless; the site is only an order book, keys never leave the wallet) ---
    /** List an owned Verginal for sale. { outpoint, priceUnits, name? }. Prompts to approve. */
    listInscription: (opts) => call('listInscription', opts),
    /** Buy a listed Verginal. { outpoint, priceUnits?, name? }. Prompts, then broadcasts. */
    buyListing: (opts) => call('buyListing', opts),
    /** Offer to buy a Verginal. { outpoint, sellerAddress, carrierValue, priceUnits, name? }. */
    placeBid: (opts) => call('placeBid', opts),
    /** Accept an offer on your Verginal. { outpoint, buyerAddress, priceUnits?, name? }. */
    acceptBid: (opts) => call('acceptBid', opts),

    /**
     * The extension build that is running, e.g. { version: '0.16.0' }.
     *
     * It exists because a fix shipped, a page still failed the same way, and there was no way to tell
     * a stale service worker from a real bug without guessing. A page can now say which build it is
     * talking to instead of asking somebody to check a settings screen.
     */
    walletVersion: () => call('walletVersion'),

    // --- Verge Runes ---
    /**
     * The public half of a lock key for a NEW etching, derived from this wallet's own recovery
     * phrase at a hardened account of its own. The etcher writes nothing down: the backup happened
     * when they wrote their words. Only the public half ever leaves the extension.
     *
     * This was reachable from the background and from the wallet for weeks and was NOT ON THE
     * PROVIDER, so the etch page asked for a lock key, got nothing, and told people to reconnect.
     * Reconnecting could never have helped. Nothing on this object is optional plumbing: a method
     * the background answers and inject.js does not name simply does not exist to a page.
     */
    runesLockPubkey: (opts) => call('runesLockPubkey', opts),
    /** Which published locks this wallet can open, matched locally. Discloses nothing, moves nothing. */
    runesMyLocks: (opts) => call('runesMyLocks', opts),
    /** Pay for an etching from this wallet. { jobId, outputs }. Prompts to approve. */
    fundEtch: (opts) => call('fundEtch', opts),
    /** Mint from a coin whose creator left the door open. { runeRef, priceUnits }. Prompts. */
    mintRune: (opts) => call('mintRune', opts),
    /** The runes this wallet holds, each proven against the published root. */
    getRunes: () => call('getRunes'),
    /** Send runes. { runeRef, amount, to }. Prompts to approve. */
    sendRune: (opts) => call('sendRune', opts),
    /**
     * Offer to buy runes at a named amount from a seller's standing order.
     * { order, amount }. Prompts to approve, then leaves a signed offer on the book.
     *
     * There is deliberately no method for SELLING here. A buyer's signature commits coins they can
     * withdraw in one block; a seller's signature gives runes away. A page may ask for the first and
     * must never be able to ask for the second, so filling lives in the wallet's own screen.
     */
    placeRuneBid: (opts) => call('placeRuneBid', opts),

    /** Disconnect this site. */
    disconnect: () => call('disconnect'),

    on, off,
  };

  Object.defineProperty(window, 'verge', { value: Object.freeze(api), writable: false, configurable: false });
  window.dispatchEvent(new Event('verge#initialized'));
})();
