// Content script (ISOLATED world): the bridge between the page's window.verge provider and the
// background service worker where the wallet lives. It:
//   1. injects inject.js into the PAGE world so window.verge exists,
//   2. relays page requests (window.postMessage) to the background (chrome.runtime.sendMessage),
//   3. relays background responses + events back to the page.
//
// It never touches keys. The page and the background never share a JS context; everything crosses
// these two hops, so the site can only ever ask, never reach into the wallet.

const REQ = 'verge:request';
const RES = 'verge:response';
const EVT = 'verge:event';

// 1. Inject the page-world provider.
(function injectProvider() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.async = false;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
})();

// 2. Page -> background.
window.addEventListener('message', async (ev) => {
  if (ev.source !== window || !ev.data || ev.data.channel !== REQ) return;
  const { id, method, params } = ev.data;
  try {
    const result = await chrome.runtime.sendMessage({ kind: 'verge-rpc', method, params, origin: location.origin });
    if (result && result.error) {
      window.postMessage({ channel: RES, id, error: result.error }, location.origin);
    } else {
      window.postMessage({ channel: RES, id, result: result ? result.result : undefined }, location.origin);
    }
  } catch (e) {
    window.postMessage({ channel: RES, id, error: e.message || 'extension error' }, location.origin);
  }
});

// 3. Background -> page (events: accountsChanged, disconnect, ...).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === 'verge-event') {
    window.postMessage({ channel: EVT, event: msg.event, data: msg.data }, location.origin);
  }
});
