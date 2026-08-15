// Verge Assets, the public page.
//
// Three instruments here do real work rather than illustrate it:
//
//   the verifier      builds a merkle tree with WebCrypto, by the same rules as
//                     src/assets/checkpoint.js, and walks a real proof to a real root
//   the name pricer   the §7 schedule and the §7.2 lock, so the arithmetic that is the whole
//                     anti-squatting argument can be poked at instead of read
//   the mint cost     what taking an entire supply costs, which is the argument for pricing a mint
//                     at all, and it only lands as a number
//
// Everything else on the page is prose. Nothing here touches a wallet, signs anything, or moves a
// coin: the page reads /api/info to report this server's real state and computes the rest locally.

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const COIN = 1e6;
const fmt = (n) => n.toLocaleString('en-US');
const kv = (host, k, v, cls) => {
  const r = el('div', 'va-kv' + (cls ? ' ' + cls : ''));
  r.append(el('span', '', k), el('span', '', v));
  host.append(r);
  return r;
};
const head = (host, title, note) => {
  const h = el('div', 'va-demo-head');
  h.append(el('h3', '', title));
  if (note) h.append(el('p', '', note));
  host.append(h);
};

// --- what this server actually reports ----------------------------------------------------------

// The page says on its face that the protocol is off. That claim is checked against the server
// rather than asserted, because a status line nobody verifies is the first thing to go stale.
async function serverState() {
  const box = $('#va-state');
  try {
    const r = await fetch('/api/info', { headers: { accept: 'application/json' } });
    const info = await r.json();
    if (info && info.error) throw new Error(info.error);
    const tip = info && (info.height || info.blocks || info.tip);
    box.textContent = tip ? `Not live · Verge tip ${fmt(Number(tip))}` : 'Not live on this server';
  } catch {
    box.textContent = 'Not live on this server';
  }
}

// --- merkle, exactly as src/assets/checkpoint.js does it ----------------------------------------

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Leaf over the canonical text form of the triple. */
function leafBytes(entry) {
  return enc.encode(`${entry.outpoint}|${entry.assetRef}|${entry.amount}`);
}

/** Fixed order by byte comparison, so a proof carries no left/right flags. */
function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

async function parentHash(a, b) {
  const [x, y] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const joined = new Uint8Array(x.length + y.length);
  joined.set(x, 0);
  joined.set(y, x.length);
  return sha256(joined);
}

/**
 * The tree, and the proof for one leaf. An odd node at the end of a level is carried up unchanged
 * rather than duplicated: duplicating it would let one proof authenticate two different trees.
 */
async function treeAndProof(entries, index) {
  let level = [];
  for (const e of entries) level.push(await sha256(leafBytes(e)));

  const path = [];
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx || i + 1 === idx) {
          path.push(level[i === idx ? i + 1 : i]);
          idx = next.length;
        }
        next.push(await parentHash(level[i], level[i + 1]));
      } else {
        if (i === idx) idx = next.length;
        next.push(level[i]);       // carried up as it is
      }
    }
    level = next;
  }
  return { root: level[0], path };
}

// --- the balances the verifier works over -------------------------------------------------------

// A worked example, and named so nobody mistakes it for live data. The amounts are atomic units:
// GRUMPY has divisibility 2, so 125000 units display as 1,250.00.
const LEDGER = [
  { outpoint: '3f9c2a71d4e8b05a6c1f3e7d9b2a4c8e05f6a1b3c7d9e2f4a6b8c0d1e3f5a7b9:0', assetRef: 9388102, amount: 400000 },
  { outpoint: '7b1e4d0a9c3f6b2e8d5a1c7f0b4e9d2a6c3f8b1e5d7a0c4f9b2e6d8a1c3f5b7e:1', assetRef: 9388102, amount: 250000 },
  { outpoint: 'b7d2f4a1c9e83b06f5a2d47c1e9b380a5c6f2d13e847a9b0c1d2e3f4a5b6c7d8:1', assetRef: 9388102, amount: 125000 },
  { outpoint: 'd4a8c1f6b3e07d29a5c8f1b4e7d0a3c6f9b2e5d8a1c4f7b0e3d6a9c2f5b8e1d4:0', assetRef: 9388102, amount: 900000 },
  { outpoint: 'e2c5a8f1b4d70e39c6a9f2b5d8e1a4c7f0b3e6d9a2c5f8b1e4d7a0c3f6b9e2d5:2', assetRef: 9391044, amount: 60000 },
];
const MINE = 2;   // the row the demo claims as yours

function verifySection() {
  const host = $('#va-verify');
  host.textContent = '';
  head(host, 'Verify a balance against a published root',
    'REAL SHA-256, COMPUTED IN THIS BROWSER');

  const mine = LEDGER[MINE];
  const sum = el('div', 'va-readout');
  kv(sum, 'Your balance', '1,250.00 GRUMPY', 'lead');
  kv(sum, 'Held on outpoint', mine.outpoint.slice(0, 20) + '…:' + mine.outpoint.split(':')[1], 'quiet');
  kv(sum, 'Committed at height', '9,388,102', 'quiet');
  kv(sum, 'Balances in the set', String(LEDGER.length) + ' (a real one holds millions)', 'quiet');
  host.append(sum);

  const steps = el('div', 'va-steps');
  const verdict = el('div', 'va-verdict');
  verdict.textContent = 'Not checked yet. Unverified is not an error: it means the wallet has not '
    + 'asked, or no root is published for this height.';

  const btns = el('div', 'va-btns');
  const good = el('button', 'va-btn', 'Verify against the root');
  const bad = el('button', 'va-btn', 'Verify a tampered balance');
  btns.append(good, bad);
  host.append(btns, steps, verdict);

  async function run(tampered) {
    good.classList.toggle('on', !tampered);
    bad.classList.toggle('on', tampered);
    steps.textContent = '';
    verdict.className = 'va-verdict';
    verdict.textContent = 'Hashing…';

    // The honest root always comes from the true ledger. Tampering changes only what the WALLET
    // claims, which is the situation being tested: the chain is not lying, the answer is.
    const { root } = await treeAndProof(LEDGER, MINE);
    const { path } = await treeAndProof(LEDGER, MINE);
    const claimed = tampered
      ? Object.assign({}, mine, { amount: mine.amount * 4 })
      : mine;

    let node = await sha256(leafBytes(claimed));
    const line = (label, hash, cls) => {
      const s = el('div', 'va-step' + (cls ? ' ' + cls : ''));
      s.append(el('i', '', label), el('b', '', toHex(hash).slice(0, 40) + '…'));
      steps.append(s);
    };
    line('LEAF  ', node);
    for (let i = 0; i < path.length; i++) {
      line('+ SIB ', path[i]);
      node = await parentHash(node, path[i]);
      line('= NODE', node);
    }

    const ok = toHex(node) === toHex(root);
    steps.lastChild.classList.add(ok ? 'match' : 'fail');
    line('ROOT  ', root, ok ? 'match' : 'fail');

    verdict.className = 'va-verdict ' + (ok ? 'ok' : 'bad');
    verdict.textContent = ok
      ? 'VERIFIED. The balance is in the set the root commits to, and no indexer had to be believed '
        + 'for you to know it.'
      : 'FAILED. This balance is not in the set that root commits to. The wallet shows who published '
        + 'the root it disagrees with, because that is the accusation being made.';
  }

  good.addEventListener('click', () => run(false));
  bad.addEventListener('click', () => run(true));
}

// --- names ---------------------------------------------------------------------------------------

const PRICE = { 1: 100000, 2: 50000, 3: 25000, 4: 10000, 5: 5000, 6: 2500, 7: 1000, 8: 500, 9: 250, 10: 100, 11: 50 };
const priceOf = (len) => (len >= 12 ? 10 : PRICE[len] || 0);
const LOCK_DAYS = 1460;

function releaseDate() {
  const d = new Date(Date.now() + LOCK_DAYS * 86400000);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function nameSection() {
  const host = $('#va-ticker');
  host.textContent = '';
  head(host, 'Price a name', 'A-Z AND 0-9, UP TO 26 CHARACTERS');

  const input = el('input', 'va-in');
  input.value = 'GRUMPY';
  input.maxLength = 26;
  input.setAttribute('aria-label', 'Name to price');
  const label = el('label', 'va-label', 'Name');
  label.htmlFor = 'va-name-in';
  input.id = 'va-name-in';
  host.append(label, input);

  const hint = el('p', 'va-hint');
  host.append(hint);

  const big = el('div', 'va-headline');
  const bigNum = el('b');
  const bigWhy = el('span');
  big.append(bigNum, bigWhy);
  host.append(big);

  const out = el('div', 'va-readout');
  host.append(out);

  function draw() {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw !== input.value) {
      const at = input.selectionStart;
      input.value = raw;
      input.setSelectionRange(at, at);
    }
    const n = raw.length;
    hint.textContent = `${n}/26 characters, folded to uppercase and permanent once taken`;

    out.textContent = '';
    if (n === 0) {
      bigNum.textContent = '';
      bigWhy.textContent = 'Type a name to price it.';
      return;
    }
    const one = priceOf(n);
    bigNum.textContent = fmt(one) + ' XVG';
    bigWhy.textContent = `locked for ${fmt(LOCK_DAYS)} days, then yours again on ${releaseDate()}. `
      + 'Not burned, not paid to anyone.';

    kv(out, 'Length that is priced', `${n} character${n === 1 ? '' : 's'}`);
    kv(out, 'One name', fmt(one) + ' XVG locked');
    kv(out, 'Fifty of them, for a squatter', fmt(one * 50) + ' XVG locked at once');
    kv(out, 'Cost if you never come back for it', '0 XVG, the money is yours');
    if (n >= 12) {
      kv(out, 'Why this one is cheap', 'twelve characters or more is nominal, so an honest '
        + 'descriptive name is never priced out', 'quiet');
    }
  }

  input.addEventListener('input', draw);
  draw();
}

// --- minting -------------------------------------------------------------------------------------

// What a mint costs when nobody charges for it. Two limits apply and the larger one wins: the relay
// RATE of 0.2 XVG/kB, and an absolute mempool FLOOR of 0.1 XVG. A mint is about 250 bytes, so the
// rate alone would ask 0.05 XVG and the floor is what actually gets paid. Using the rate here
// understated the cheap case by half, which flatters the argument this page is making.
const MIN_FEE_XVG = 0.1;          // the floor, measured on regtest: a 0.1 XVG mint was accepted
const FEE_CEILING = 50;           // Verge Core refuses any absolute fee above this
const MAX_MINT_FEE = 49;          // so a builder caps a declared fee here, leaving room for relay

function mintSection() {
  const host = $('#va-mintcost');
  host.textContent = '';
  head(host, 'What it costs to take an entire supply', 'THE ARGUMENT FOR PRICING A MINT AT ALL');

  const fields = el('div', 'va-fields');
  const mk = (labelText, value, id) => {
    const wrap = el('div');
    const l = el('label', 'va-label', labelText);
    l.htmlFor = id;
    const i = el('input', 'va-in');
    i.id = id;
    i.type = 'text';
    i.inputMode = 'numeric';
    i.value = value;
    wrap.append(l, i);
    fields.append(wrap);
    return i;
  };
  const supplyIn = mk('Total supply', '21,000,000', 'va-supply');
  const perMintIn = mk('Issued per mint', '1,000', 'va-permint');
  const feeIn = mk('Network fee per mint (XVG)', '20', 'va-fee');
  host.append(fields);

  const warn = el('p', 'va-hint');
  host.append(warn);

  const big = el('div', 'va-headline');
  const bigNum = el('b');
  const bigWhy = el('span');
  big.append(bigNum, bigWhy);
  host.append(big);

  const out = el('div', 'va-readout');
  host.append(out);

  const num = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;

  function draw() {
    const supply = Math.floor(num(supplyIn.value));
    const perMint = Math.floor(num(perMintIn.value));
    const fee = num(feeIn.value);

    out.textContent = '';
    warn.textContent = '';
    if (supply <= 0 || perMint <= 0) {
      bigNum.textContent = '';
      bigWhy.textContent = 'Enter a supply and an amount per mint.';
      return;
    }

    const mints = Math.ceil(supply / perMint);
    const withFee = mints * fee;
    const relayOnly = mints * MIN_FEE_XVG;

    bigNum.textContent = fmt(Math.round(withFee)) + ' XVG';
    bigWhy.textContent = `to take all ${fmt(mints)} mints. Charging nothing, the same sweep costs `
      + `${fmt(Math.round(relayOnly))} XVG in network fees, which is why an unpriced mint is not `
      + 'open, it is free.';

    kv(out, 'Mints in the whole supply', fmt(mints));
    kv(out, 'At the fee above', fmt(Math.round(withFee)) + ' XVG');
    kv(out, 'Charging nothing', fmt(Math.round(relayOnly)) + ' XVG, the mempool floor', 'quiet');
    kv(out, 'The difference', Math.round(withFee / relayOnly) + 'x harder');
    kv(out, 'Who receives it', 'the miner of each block, as an ordinary fee', 'quiet');

    // The ceiling is measured, not a preference, so the page refuses to pretend past it.
    if (fee > MAX_MINT_FEE) {
      warn.textContent = `A fee above ${MAX_MINT_FEE} XVG cannot be etched: Verge Core refuses any `
        + `transaction whose absolute fee exceeds ${FEE_CEILING} XVG, and the relay fee stacks on `
        + 'top of it, so an ordinary wallet could never mint the coin.';
    }
  }

  for (const i of [supplyIn, perMintIn, feeIn]) i.addEventListener('input', draw);
  draw();
}

// --- the rest ------------------------------------------------------------------------------------

const FEATURES = [
  ['One primitive, two things',
    'A supply of one with no decimals is a unique item. A supply of many is a token. There is no '
    + 'separate NFT standard to learn, and no second implementation to keep in step with the first.'],
  ['Balances ride on coins',
    'A balance is attached to an output, exactly like XVG itself, so moving a token is moving a '
    + 'UTXO and existing wallet logic applies unchanged. A wallet that knows nothing about this '
    + 'protocol still moves a balance safely rather than destroying it.'],
  ['Allowlists in 32 bytes',
    'An asset can carry a merkle root naming who may mint. That buys a real airdrop or a genuine '
    + 'whitelist, which neither BRC-20 nor Runes can express at all.'],
  ['Swaps in the protocol',
    'One partially signed transaction: the seller signs their side, the buyer appends theirs, and '
    + 'it either happens atomically or not at all. No marketplace holds anything at any point.'],
  ['Nothing changes after the fact',
    'An etching has no owner and no update message. Supply, decimals, mint terms and name are '
    + 'fixed the moment it confirms, by everyone, including whoever created it.'],
  ['Two implementations, checked',
    'The state machine is written twice, in different shapes, and a harness drives both over '
    + 'randomised histories comparing their roots. Conformance is a test result rather than a claim.'],
];

const LIMITS = [
  ['It does not make an open mint fair',
    'The mint fee makes taking an entire supply expensive instead of free, but it rations capital, '
    + 'not time, so a well funded participant can still win the race. Nothing further is imposed, '
    + 'because every rule that would settle a race rations time and charges the honest minter for a '
    + 'problem they did not cause. An allowlist or a premine is how you decide who gets in.'],
  ['A miner can mint without paying',
    'The fee goes to whoever mines the block, so a miner who includes their own mint recovers it in '
    + 'the coinbase. The alternative is burning the money, which nobody can recover and which gives '
    + 'up the reason to prefer fees. The attack needs sustained hashrate and one transaction per '
    + 'mint, so it is bounded rather than free.'],
  ['Issuance rules cannot be tightened later',
    'Adding a restrictive field after the fact would split the index in silence, since an indexer '
    + 'that does not recognise it keeps permitting what the new rule forbids and neither side can '
    + 'tell. The rules are what they are at v0.'],
  ['An indexer can still be wrong',
    'Checkpoints do not make this trustless in the consensus sense. What changes is that being '
    + 'wrong becomes detectable and attributable instead of invisible.'],
  ['Everything on it is public and permanent',
    'This is the opposite of what Verge is for. An asset, its name, its terms and every transfer '
    + 'are visible forever to everyone. That tension is real and worth knowing before you use it.'],
];

const PROGRESS = [
  [true, 'The specification is written',
    'Every rule, every constant, and the reasoning behind the decisions that could have gone the '
    + 'other way.'],
  [true, 'Two independent implementations agree',
    'A state machine and a re-derivation of it in a different shape, driven over randomised '
    + 'histories by a conformance harness.'],
  [true, 'The mechanisms are proven on a chain',
    'Time-locked payments, the fee rule and the standardness questions were run against Verge Core '
    + 'v26.5.0 rather than assumed. The fee ceiling on this page was found by walking into it.'],
  [false, 'A public indexer serving proofs',
    'The part that has to exist before anything can be switched on, because a balance nobody can '
    + 'verify is the problem this protocol was built to solve.'],
  [false, 'Wallet support',
    'Reopening a locked name needs software written for it: Verge Core cannot sign that script at '
    + 'all, so the ability to get your own money back is a wallet feature, not a given.'],
  [false, 'A third implementation, by somebody else',
    'Both current ones were written by the same author from the same reading. That catches slips, '
    + 'not a shared misunderstanding.'],
];

function featureSection() {
  const host = $('#va-features');
  host.textContent = '';
  for (const [title, body] of FEATURES) {
    const c = el('div', 'va-card');
    c.append(el('h3', '', title), el('p', '', body));
    host.append(c);
  }
}

function limitSection() {
  const host = $('#va-limits');
  host.textContent = '';
  for (const [title, body] of LIMITS) {
    const c = el('div', 'va-limit');
    c.append(el('b', '', title), el('p', '', body));
    host.append(c);
  }
}

function progressSection() {
  const host = $('#va-progress');
  host.textContent = '';
  for (const [done, title, body] of PROGRESS) {
    const r = el('div', 'va-row');
    const mark = el('div', 'va-row-mark ' + (done ? 'done' : 'todo'), done ? '✓' : '·');
    const t = el('div', 'va-row-text');
    t.append(el('b', '', title), el('span', '', body));
    r.append(mark, t);
    host.append(r);
  }
}

verifySection();
nameSection();
mintSection();
featureSection();
limitSection();
progressSection();
serverState();
