// Entry point for the Adventure test page.
//
// Kept as a separate file on purpose: the site serves every HTML response with a default-src 'self'
// CSP, so an inline <script> is refused. Anything this page needs to run has to live in a real file.
//
// The flow is the same one the Arena uses: connect the wallet, sign a challenge, exchange it for a
// session token. Every adventure route is gated on that token.

import { Adventure, setToken } from './adventure.js';

const $ = (sel) => document.querySelector(sel);
const say = (msg, tone = 'fog') => {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.tone = tone;
};

async function json(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body;
}

async function signIn() {
  const provider = window.verge;
  if (!provider) {
    throw new Error('No Verginals wallet found on this page. Install the extension, then reload.');
  }
  // connect() resolves { address }, not a bare string. Accept either, because getting this wrong
  // sends "[object Object]" to the challenge endpoint and the failure reads as a bad wallet.
  const connected = await provider.connect();
  const address = typeof connected === 'string' ? connected : connected && connected.address;
  if (!address) throw new Error('The wallet did not return an address. Unlock it and try again.');
  const challenge = await json(`/api/game/challenge?address=${encodeURIComponent(address)}`);
  // signMessage resolves { signature, address } for the same reason. Same defensive unwrap.
  const signed = await provider.signMessage(challenge.challenge);
  const signature = typeof signed === 'string' ? signed : signed && signed.signature;
  if (!signature) throw new Error('The wallet did not return a signature.');
  const session = await json('/api/game/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
  });
  return { address, token: session.token };
}

async function start() {
  const info = await json('/api/info').catch(() => ({}));
  if (!info.adventure) {
    say('Adventure Mode is switched off on this server.', 'bad');
    return;
  }
  say('Connecting your wallet. Approve the signature request to continue.');
  let session;
  try {
    session = await signIn();
  } catch (e) {
    say(e.message, 'bad');
    $('#connect').hidden = false;
    return;
  }
  setToken(session.token);
  say(`Signed in as ${session.address.slice(0, 8)}...${session.address.slice(-6)}`, 'ok');
  const app = new Adventure($('#app'));
  try {
    await app.refresh();
  } catch (e) {
    say(e.message, 'bad');
  }
}

$('#connect').addEventListener('click', () => { $('#connect').hidden = true; start(); });

// The extension defines window.verge and then fires verge#initialized. Listening for the event is
// the only reliable way in: a timer races the injection and loses on a slow load, which is exactly
// what "the extension is not installed" meant the first time round.
let started = false;
const once = () => { if (!started) { started = true; start(); } };

if (window.verge) once();
else {
  window.addEventListener('verge#initialized', once, { once: true });
  // If the event never comes the extension really is absent, so offer the button rather than
  // leaving the page sitting on "Loading".
  setTimeout(() => {
    if (started) return;
    if (window.verge) once();
    else { say('No Verginals wallet detected. Install the extension and reload, or connect manually.'); $('#connect').hidden = false; }
  }, 3000);
}
