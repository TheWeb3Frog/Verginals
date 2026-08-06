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
  const provider = window.VerginalsArena;
  if (!provider) {
    throw new Error('The Verginals wallet extension is not installed, or this page was opened before it loaded.');
  }
  const address = await provider.connect();
  const challenge = await json(`/api/game/challenge?address=${encodeURIComponent(address)}`);
  const signature = await provider.signMessage(challenge.challenge);
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

// The extension injects its provider on document load, so give it a beat before deciding it is
// missing. If it is already there we go straight in.
if (window.VerginalsArena) start();
else setTimeout(() => { if (window.VerginalsArena) start(); else { say('Waiting for the Verginals wallet extension.'); $('#connect').hidden = false; } }, 800);
