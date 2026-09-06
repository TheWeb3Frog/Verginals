'use strict';
// Community collection launchpad: curated submissions, open-edition mints.
//
// Anyone can SUBMIT a collection (images + per-item traits) through the site, but nothing
// goes live until the operator reviews it and approves it on the server with the small CLI
// at the bottom of this file. An approved collection becomes its own MintController: its
// own committed-random order, its own persisted state, its own public mint page, mintable
// by anyone through the same payment pipeline as the Alpha drop.
//
// Layout under <dataDir>/launchpad/:
//   submissions/<id>/draft.json + images/<file>    drafts, the review queue, and rejections
//   collections/<slug>/                            approved, live collections:
//     collection_manifest.json designs.json metadata.json images/   (MintController inputs)
//     mint.secret mintState.json                                    (MintController state)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MintController } = require('./mint');
const coinimage = require('./coinimage');

/**
 * THE SIZE CONTRACT, STATED ONCE.
 *
 * These numbers used to live in three places that disagreed. The form promised 10,000 items at
 * 60 KB each, the budget allowed 150 MB, and the arithmetic capped the real answer at 2,560: the
 * advertised collection size was simply not reachable, and nothing anywhere noticed.
 *
 * 16 KB is not a guess. Measured over 60 images sampled from the 1,488 inscriptions on Verge: the
 * median is 2.3 KB, the 90th percentile 3.6 KB, and the largest ever written is 14.3 KB. Nothing on
 * this chain comes near the old cap. 16 KB clears everything that exists, keeps 10,000 items
 * reachable, and still says what belongs here: a photograph does not fit, which is correct for a
 * collection written onto a chain.
 *
 * The side limit matters as much as the byte limit and was missing entirely. Bytes alone let a
 * 10,000 by 10,000 image through as long as it compressed well, and it renders as mush at every
 * size the site draws it. The coin pictures have always been checked this way; this reuses the
 * same reader rather than growing a second opinion about what an image is.
 *
 * The draft budget is DERIVED. Typing it is what let it contradict the other two.
 */
const MIN_ITEMS = 2;                           // a collection, not a piece
const MAX_ITEMS = 10000;                       // the classic 10k collection standard
const MAX_IMAGE_BYTES = 16 * 1024;             // above every image on the chain, with room
const MAX_IMAGE_SIDE = coinimage.MAX_SIDE;     // one definition of "too big to draw"
const MAX_DRAFT_BYTES = MAX_ITEMS * MAX_IMAGE_BYTES; // never typed: 10,000 x 16 KB = 156 MB
// Everything under launchpad/, both the waiting room and the approved collections. At the worst
// case above that is a dozen collections, and at the sizes people really make (25 MB for 10,000)
// it is closer to eighty. VERGINALS_LAUNCHPAD_BUDGET_MB overrides it.
const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PENDING = 20; // review-queue cap so disk can't be flooded before curation
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unfinalized drafts older than this are pruned

/**
 * What one address may do in a day.
 *
 * There is no bond and nothing is charged, so the only thing standing between the review queue and
 * a bored afternoon is a counter. It counts FINALIZED submissions, not drafts: a draft costs disk
 * but no attention, and burning somebody's daily allowance because they started over twice would
 * punish exactly the person the launchpad is for. Open drafts get their own, separate cap, because
 * that is the one that costs disk.
 *
 * The counter is only worth anything if the address is proven, which the server does with a signed
 * challenge before any of this is reached. An address typed into a box is a new identity every
 * time somebody presses backspace.
 */
const PER_ADDRESS_PER_DAY = 3;
const OPEN_DRAFTS_PER_ADDRESS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a creator may charge to mint one item, in atomic units.
 *
 * Zero is allowed and is a real choice: a free mint costs the minter only what the network charges
 * to write the inscription. The ceiling is not a judgement about what art is worth, it is a guard
 * against a typo: somebody who means 500 and writes 500000000 would otherwise publish a mint page
 * asking for half a billion XVG, and the first person to notice would be the one who paid it.
 */
const MAX_MINT_PRICE_UNITS = 1000000 * 1000000; // one million XVG

/**
 * A creator's cut of a resale, in basis points, capped at ten per cent.
 *
 * Worth saying plainly to anybody who sets one: this is enforced by THIS MARKETPLACE, not by the
 * chain. A wallet-to-wallet transfer pays nothing and no UTXO chain can prevent that. It has been
 * true everywhere since OpenSea made royalties optional; what matters is that a creator reads it in
 * the form rather than discovering it later.
 */
const MAX_ROYALTY_BPS = 1000;

/**
 * The launch schedule.
 *
 * IT IS A SERVER RULE, NOT A CHAIN RULE, and it is worth being exact about that. Nothing here is
 * enforced by consensus: the server decides whether to hand out a mint, so the honest unit is
 * wall-clock time rather than a block height converted from an assumed thirty second target that
 * drifts by hours over a week.
 *
 * There is deliberately NO deferred reveal. On this architecture the art is inscribed at mint time,
 * so anybody reading the chain sees it the moment it is minted. Hiding it on our own pages would
 * not be a reveal, it would be a curtain in front of a window that is already open.
 */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000; // a year is already generous
const MAX_PER_WALLET = 10000;

/**
 * A social link, or nothing.
 *
 * Checked against a LIST OF HOSTS rather than accepted as text. The first collection that writes
 * discord.gg/something-else in a free field publishes it from this site, wrapped in this site's
 * name, and every visitor reads that as an endorsement. A host list is the cheapest way to make
 * that impossible rather than merely against the rules.
 */
const LINK_HOSTS = {
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  discord: ['discord.gg', 'discord.com', 'www.discord.com'],
  website: null, // any host, but still http(s) and still a real URL
};

function cleanLink(kind, value) {
  const raw = clean(value, 200);
  if (!raw) return null;
  let u;
  try { u = new URL(raw.includes('://') ? raw : 'https://' + raw); }
  catch (_) { throw new Error(`that ${kind} link is not a web address`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`that ${kind} link is not a web address`);
  const hosts = LINK_HOSTS[kind];
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) {
    throw new Error(`an ${kind} link has to be on ${hosts[0]}`);
  }
  u.protocol = 'https:';
  return u.toString();
}

/** Everything a page or a test needs to state the same rules the server enforces. */
const LIMITS = Object.freeze({
  minItems: MIN_ITEMS,
  maxItems: MAX_ITEMS,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxImageSide: MAX_IMAGE_SIDE,
  maxDraftBytes: MAX_DRAFT_BYTES,
  formats: ['image/webp', 'image/png', 'image/jpeg', 'image/gif'],
  perAddressPerDay: PER_ADDRESS_PER_DAY,
  openDraftsPerAddress: OPEN_DRAFTS_PER_ADDRESS,
  nameMax: 60,
  descriptionMax: 500,
  taglineMax: 80,
  maxMintPriceUnits: MAX_MINT_PRICE_UNITS,
  maxRoyaltyBps: MAX_ROYALTY_BPS,
  maxPerWallet: MAX_PER_WALLET,
  scheduleAheadDays: MAX_SCHEDULE_AHEAD_MS / (24 * 60 * 60 * 1000),
  linkHosts: LINK_HOSTS,
});
const NAME_MAX = 60;
const DESC_MAX = 500;
const CREATOR_MAX = 60;
const TRAITS_MAX = 12;
const TRAIT_STR_MAX = 64;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const RESERVED_SLUGS = new Set(['alpha', 'api', 'submit', 'admin', 'status']);

/** Identify an image by magic bytes; returns its MIME type or null if it is not an image we accept. */
function sniffImage(buf) {
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 8 && buf[0] === 0x89 && buf.slice(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.slice(0, 6).toString('ascii'))) return 'image/gif';
  return null;
}

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);


/** Validate a caller-supplied attributes array into the canonical [{trait_type, value}] shape. */
function cleanAttributes(attrs) {
  if (attrs == null) return [];
  if (!Array.isArray(attrs)) throw new Error('attributes must be an array');
  if (attrs.length > TRAITS_MAX) throw new Error(`too many traits (max ${TRAITS_MAX})`);
  const out = [];
  for (const a of attrs) {
    if (!a || typeof a !== 'object') continue;
    const t = clean(a.trait_type, TRAIT_STR_MAX);
    const v = clean(a.value, TRAIT_STR_MAX);
    if (t && v) out.push({ trait_type: t, value: v });
  }
  return out;
}

class Launchpad {
  constructor({ dataDir, budgetBytes, draftBytes }) {
    this.root = path.join(dataDir, 'launchpad');
    this.subsDir = path.join(this.root, 'submissions');
    this.collsDir = path.join(this.root, 'collections');
    fs.mkdirSync(this.subsDir, { recursive: true });
    fs.mkdirSync(this.collsDir, { recursive: true });
    this.live = new Map(); // slug -> { ctl: MintController, manifest }
    // Disk budgets: per submission, and a hard ceiling for everything under launchpad/ so
    // uploads can never eat the server's disk (VERGINALS_LAUNCHPAD_BUDGET_MB to override).
    this.draftBudget = draftBytes || MAX_DRAFT_BYTES;
    this.budget = budgetBytes
      || (Number(process.env.VERGINALS_LAUNCHPAD_BUDGET_MB) > 0
        ? Number(process.env.VERGINALS_LAUNCHPAD_BUDGET_MB) * 1024 * 1024
        : DEFAULT_BUDGET_BYTES);
    this._usage = null; // lazily computed, then tracked incrementally
  }

  /** Total bytes currently stored under launchpad/ (walked once, then tracked on writes). */
  usageBytes() {
    if (this._usage == null) {
      const walk = (dir) => {
        let sum = 0;
        if (!fs.existsSync(dir)) return 0;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) sum += walk(p);
          else if (e.isFile()) sum += fs.statSync(p).size;
        }
        return sum;
      };
      this._usage = walk(this.root);
    }
    return this._usage;
  }

  // --- submissions (public, via the site) --------------------------------------------------

  _draftPath(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad submission id');
    return path.join(this.subsDir, id);
  }

  _loadDraft(id) {
    const p = path.join(this._draftPath(id), 'draft.json');
    if (!fs.existsSync(p)) throw new Error('unknown submission');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  _saveDraft(d) {
    const dir = this._draftPath(d.id);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    const tmp = path.join(dir, 'draft.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
    fs.renameSync(tmp, path.join(dir, 'draft.json'));
  }

  pendingCount() {
    return this.listSubmissions().filter((d) => d.status === 'pending').length;
  }

  /** Finalized submissions this address made inside the window. Its daily allowance. */
  recentFor(address, windowMs = DAY_MS, now = Date.now()) {
    if (!address) return 0;
    return this.listSubmissions()
      .filter((d) => d.address === address && d.finalizedAt && now - d.finalizedAt < windowMs).length;
  }

  /** Drafts this address has open and unfinished. The cap that protects disk rather than attention. */
  openDraftsFor(address) {
    if (!address) return 0;
    return this.listSubmissions().filter((d) => d.address === address && d.status === 'draft').length;
  }

  createDraft({ name, symbol, description, creator, address, mintPriceUnits, royaltyBps, tagline,
    links, contact, opensAt, closesAt, allowlistUntil, maxPerWallet }) {
    this.pruneDrafts();
    if (this.pendingCount() >= MAX_PENDING) throw new Error('the review queue is full, please try again later');
    // The caller proves the address before this is reached; here it is only counted.
    if (address) {
      if (this.recentFor(address) >= PER_ADDRESS_PER_DAY) {
        throw new Error(`that address has submitted ${PER_ADDRESS_PER_DAY} collections today, which is the limit`);
      }
      if (this.openDraftsFor(address) >= OPEN_DRAFTS_PER_ADDRESS) {
        throw new Error(`that address already has ${OPEN_DRAFTS_PER_ADDRESS} submissions in progress; finish or abandon one first`);
      }
    }
    // The price is fixed at submission and reviewed with everything else. A number that could be
    // edited after approval would be a number the operator did not approve.
    const price = Math.round(Number(mintPriceUnits || 0));
    if (!Number.isFinite(price) || price < 0) throw new Error('a mint price must be zero or more');
    if (price > MAX_MINT_PRICE_UNITS) {
      throw new Error(`that mint price is over the ${MAX_MINT_PRICE_UNITS / 1000000} XVG ceiling`);
    }
    const royalty = Math.round(Number(royaltyBps || 0));
    if (!Number.isFinite(royalty) || royalty < 0) throw new Error('a royalty is zero or more');
    if (royalty > MAX_ROYALTY_BPS) {
      throw new Error(`a royalty cannot be over ${MAX_ROYALTY_BPS / 100}%`);
    }

    const when = (v, label) => {
      if (v == null || v === '') return null;
      const t = Math.round(Number(v));
      if (!Number.isFinite(t) || t <= 0) throw new Error(`that ${label} is not a time`);
      if (t * 1000 > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new Error(`that ${label} is more than a year away`);
      return t;
    };
    const opens = when(opensAt, 'opening time');
    const closes = when(closesAt, 'closing time');
    const allowUntil = when(allowlistUntil, 'allowlist end');
    if (opens && closes && closes <= opens) throw new Error('the mint would close before it opened');
    if (allowUntil && opens && allowUntil <= opens) throw new Error('the allowlist would end before the mint opened');
    const perWallet = Math.round(Number(maxPerWallet || 0));
    if (!Number.isFinite(perWallet) || perWallet < 0) throw new Error('a per wallet limit is zero or more');
    if (perWallet > MAX_PER_WALLET) throw new Error(`a per wallet limit cannot be over ${MAX_PER_WALLET}`);

    const d = {
      id: crypto.randomBytes(8).toString('hex'),
      address: address || null,
      mintPriceUnits: price,
      royaltyBps: royalty,
      opensAt: opens,
      closesAt: closes,
      // Alpha holders only until this moment, then anybody. Null means open from the start.
      allowlistUntil: allowUntil,
      maxPerWallet: perWallet,
      tagline: clean(tagline, LIMITS.taglineMax),
      // Refused rather than stripped: somebody who pasted their Discord into the X field should be
      // told, not silently published without it.
      links: {
        x: cleanLink('x', links && links.x),
        discord: cleanLink('discord', links && links.discord),
        website: cleanLink('website', links && links.website),
      },
      // Never published. This exists so a decision can reach the person who made the submission,
      // which is the whole of why the queue felt like shouting into a well.
      contact: clean(contact, 120),
      // Payouts go to the address that signed the submission and to no other. It is the one
      // address anybody has proved control of, and an unproven address on a mint page is somebody
      // else's money going somewhere nobody checked.
      payoutAddress: address || null,
      name: clean(name, NAME_MAX),
      symbol: clean(symbol, 12).toUpperCase(),
      description: clean(description, DESC_MAX),
      creator: clean(creator, CREATOR_MAX),
      status: 'draft',
      createdAt: Date.now(),
      mediaType: null, // fixed by the first item; every item must match
      items: [], // { number, filename, name, attributes }
    };
    if (!d.name) throw new Error('a collection name is required');
    this._saveDraft(d);
    return { id: d.id, name: d.name };
  }

  addItem(id, { filename, dataBase64, name, attributes }) {
    const d = this._loadDraft(id);
    if (d.status !== 'draft') throw new Error('this submission is closed');
    if (d.items.length >= MAX_ITEMS) throw new Error(`too many items (max ${MAX_ITEMS})`);
    if (typeof dataBase64 !== 'string' || !dataBase64) throw new Error('dataBase64 is required');
    const body = Buffer.from(dataBase64, 'base64');
    if (!body.length) throw new Error('decoded image is empty');
    if (body.length > MAX_IMAGE_BYTES) throw new Error(`image too large (max ${MAX_IMAGE_BYTES / 1024} KB)`);
    const mediaType = sniffImage(body);
    if (!mediaType) throw new Error('not a supported image (webp, png, jpeg or gif)');
    // Bytes alone are not a size. A 10,000 by 10,000 image that compresses well passes every byte
    // check there is and renders as mush at every size this site draws it. Read from the header,
    // by the same code the coin pictures use, so there is one opinion about this and not two.
    const size = coinimage.dimensions(body, mediaType);
    if (!size || !(size.w > 0) || !(size.h > 0)) throw new Error('that image has no readable size');
    if (size.w > MAX_IMAGE_SIDE || size.h > MAX_IMAGE_SIDE) {
      throw new Error(`that image is ${size.w} by ${size.h} and the limit is ${MAX_IMAGE_SIDE} on a side`);
    }
    if (d.mediaType && mediaType !== d.mediaType) throw new Error(`every image must share one format (this collection is ${d.mediaType})`);
    if ((d.totalBytes || 0) + body.length > this.draftBudget) {
      throw new Error(`this submission is over its ${Math.round(this.draftBudget / (1024 * 1024))} MB total budget`);
    }
    if (this.usageBytes() + body.length > this.budget) {
      throw new Error('the launchpad is at capacity right now, please try again later');
    }

    const number = d.items.length + 1;
    const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
    const safe = `${number}.${ext}`; // server-chosen name: no user-controlled paths on disk
    fs.writeFileSync(path.join(this._draftPath(id), 'images', safe), body);
    this._usage = this.usageBytes() + body.length;
    d.mediaType = d.mediaType || mediaType;
    d.totalBytes = (d.totalBytes || 0) + body.length;
    d.items.push({
      number,
      filename: safe,
      originalName: clean(filename, 80) || safe,
      name: clean(name, NAME_MAX) || `${d.name} #${number}`,
      attributes: cleanAttributes(attributes),
    });
    this._saveDraft(d);
    return { count: d.items.length };
  }

  /**
   * Store the collection's avatar or banner.
   *
   * Same reader, same limits as an item: an avatar is an image somebody uploaded, and there is no
   * reason for it to be checked more loosely than the art. Kept beside the draft under a
   * server-chosen name, so nothing a caller sends reaches the filesystem.
   */
  setBrandImage(id, kind, dataBase64) {
    if (kind !== 'avatar' && kind !== 'banner') throw new Error('an image is an avatar or a banner');
    const d = this._loadDraft(id);
    if (d.status !== 'draft') throw new Error('this submission is closed');
    if (typeof dataBase64 !== 'string' || !dataBase64) throw new Error('dataBase64 is required');
    const body = Buffer.from(dataBase64, 'base64');
    if (!body.length) throw new Error('decoded image is empty');
    if (body.length > MAX_IMAGE_BYTES) throw new Error(`image too large (max ${MAX_IMAGE_BYTES / 1024} KB)`);
    const mediaType = sniffImage(body);
    if (!mediaType) throw new Error('not a supported image (webp, png, jpeg or gif)');
    const size = coinimage.dimensions(body, mediaType);
    if (!size || !(size.w > 0) || !(size.h > 0)) throw new Error('that image has no readable size');
    if (size.w > MAX_IMAGE_SIDE || size.h > MAX_IMAGE_SIDE) {
      throw new Error(`that image is ${size.w} by ${size.h} and the limit is ${MAX_IMAGE_SIDE} on a side`);
    }
    const ext = mediaType.split('/')[1].replace('jpeg', 'jpg');
    const file = `${kind}.${ext}`;
    fs.mkdirSync(path.join(this._draftPath(id), 'images'), { recursive: true });
    fs.writeFileSync(path.join(this._draftPath(id), 'images', file), body);
    this._usage = this.usageBytes() + body.length;
    d[kind] = file;
    this._saveDraft(d);
    return { kind, bytes: body.length, w: size.w, h: size.h };
  }

  finalize(id) {
    const d = this._loadDraft(id);
    if (d.status !== 'draft') throw new Error('this submission is closed');
    // A collection is at least two things. One item put through a committed random draw is a draw
    // with a single possible outcome, and every sentence the mint page says about fairness would be
    // a sentence about nothing.
    if (d.items.length < MIN_ITEMS) {
      throw new Error(`a collection needs at least ${MIN_ITEMS} items, and this one has ${d.items.length}`);
    }
    d.status = 'pending';
    d.finalizedAt = Date.now();
    this._saveDraft(d);
    return { id: d.id, status: d.status, items: d.items.length };
  }

  /** Drop unfinalized drafts that were abandoned (keeps the submissions dir bounded). */
  pruneDrafts() {
    let removed = false;
    for (const d of this.listSubmissions()) {
      if (d.status === 'draft' && Date.now() - d.createdAt > DRAFT_TTL_MS) {
        fs.rmSync(this._draftPath(d.id), { recursive: true, force: true });
        removed = true;
      }
    }
    if (removed) this._usage = null; // recount on next write
  }

  listSubmissions() {
    if (!fs.existsSync(this.subsDir)) return [];
    const out = [];
    for (const id of fs.readdirSync(this.subsDir)) {
      try {
        out.push(this._loadDraft(id));
      } catch (_) { /* skip malformed leftovers */ }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- curation (operator only, via the CLI below; never exposed over HTTP) ----------------

  /**
   * @param {string} id
   * @param {string} slug
   * @param {object} [opts]
   * @param {function} [opts.validAddress] (address) => boolean, checked before any money can be
   *   pointed at it. An unusable payout address would not fail here, it would fail on the first
   *   person's mint, after they had paid.
   */
  approve(id, slug, opts = {}) {
    const d = this._loadDraft(id);
    if (d.status !== 'pending') throw new Error(`submission is ${d.status}, not pending`);
    // Checked here as well as at finalize, so a submission that was accepted into the queue under
    // an older rule cannot be waved through by an operator who did not count the items.
    if ((d.items || []).length < MIN_ITEMS) {
      throw new Error(`a collection needs at least ${MIN_ITEMS} items, and this one has ${(d.items || []).length}`);
    }
    if (d.mintPriceUnits > 0 || d.royaltyBps > 0) {
      if (!d.payoutAddress) throw new Error('this collection is paid and has no payout address');
      if (opts.validAddress && !opts.validAddress(d.payoutAddress)) {
        throw new Error(`the payout address ${d.payoutAddress} is not usable on this network`);
      }
    }
    slug = String(slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error('slug must be 3-32 chars of a-z, 0-9, hyphen');
    if (RESERVED_SLUGS.has(slug)) throw new Error('that slug is reserved');
    const dir = path.join(this.collsDir, slug);
    if (fs.existsSync(dir)) throw new Error('slug already in use');

    // Build the exact file set MintController expects, then the collection is self-contained.
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    for (const it of d.items) {
      fs.copyFileSync(
        path.join(this._draftPath(id), 'images', it.filename),
        path.join(dir, 'images', it.filename),
      );
    }
    for (const kind of ['avatar', 'banner']) {
      if (!d[kind]) continue;
      const from = path.join(this._draftPath(id), 'images', d[kind]);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, 'images', d[kind]));
    }
    const manifest = {
      name: d.name,
      symbol: d.symbol || null,
      supply: d.items.length,
      media_type: d.mediaType,
      description: d.description || '',
      creator: d.creator || '',
      slug,
      launched_at: new Date().toISOString().slice(0, 10),
      // What a mint costs and who it pays. Read straight back by the mint route, never recomputed.
      mint_price_units: d.mintPriceUnits || 0,
      royalty_bps: d.royaltyBps || 0,
      // Wall-clock, unix seconds. See the note on MAX_SCHEDULE_AHEAD_MS: this is a server rule.
      opens_at: d.opensAt || null,
      closes_at: d.closesAt || null,
      allowlist_until: d.allowlistUntil || null,
      max_per_wallet: d.maxPerWallet || 0,
      payout_address: (d.mintPriceUnits > 0 || d.royaltyBps > 0) ? d.payoutAddress : null,
      // Identity. The links were validated against a host list at submission; nothing here is free
      // text that reaches a visitor's browser as a destination.
      tagline: d.tagline || '',
      links: d.links || { x: null, discord: null, website: null },
      avatar: d.avatar || null,
      banner: d.banner || null,
    };
    const write = (file, obj) => fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 1));
    write('collection_manifest.json', manifest);
    write('designs.json', d.items.map((it) => ({ number: it.number, filename: it.filename })));
    write('metadata.json', d.items.map((it) => ({ number: it.number, name: it.name, attributes: it.attributes })));

    d.status = 'approved';
    d.slug = slug;
    d.reviewedAt = Date.now();
    this._saveDraft(d);
    return { slug, supply: d.items.length };
  }

  reject(id, reason) {
    const d = this._loadDraft(id);
    if (d.status !== 'pending') throw new Error(`submission is ${d.status}, not pending`);
    d.status = 'rejected';
    d.reason = clean(reason, 200) || null;
    d.reviewedAt = Date.now();
    this._saveDraft(d);
    // The images are dropped immediately: rejected content must not sit on the server.
    fs.rmSync(path.join(this._draftPath(id), 'images'), { recursive: true, force: true });
    this._usage = null; // recount on next write
    return { id: d.id, status: d.status };
  }

  // --- live collections (loaded lazily; refresh picks up newly approved ones) --------------

  refresh() {
    if (!fs.existsSync(this.collsDir)) return;
    for (const slug of fs.readdirSync(this.collsDir)) {
      if (this.live.has(slug)) continue;
      const dir = path.join(this.collsDir, slug);
      try {
        const ctl = new MintController({ collectionDir: dir, dataDir: dir }).load();
        this.live.set(slug, { ctl, manifest: ctl.manifest });
      } catch (e) {
        console.warn(`Launchpad: collection "${slug}" failed to load: ${e.message}`);
      }
    }
  }

  /**
   * The creator's cut of a resale for one collection, in the shape the order book asks for.
   *
   * Returns null when there is none, which is the common case and must not be a zero-fee object:
   * the book falls back to whatever the marketplace itself charges, and a zero here would look
   * like an answer.
   */
  /**
   * Can this address mint from this collection right now, and if not, why.
   *
   * Returns { ok: true } or { ok: false, why, opensAt }. The reasons are separated on purpose: "not
   * open yet" and "you are not on the allowlist" and "you already have three" are three different
   * things to a person, and one generic refusal for all of them is how a mint page makes somebody
   * think it is broken.
   *
   * @param {function} opts.holdsAlpha  () => boolean, only called when an allowlist is running
   * @param {number} opts.held          how many of this collection the address already has
   */
  gate(slug, { holdsAlpha, held = 0, now = Date.now() } = {}) {
    const c = this.get(slug);
    if (!c) return { ok: false, why: 'no such collection' };
    const m = c.manifest;
    const t = Math.floor(now / 1000);

    if (m.opens_at && t < m.opens_at) {
      return { ok: false, why: 'this mint has not opened yet', opensAt: m.opens_at };
    }
    if (m.closes_at && t >= m.closes_at) {
      return { ok: false, why: 'this mint has closed', closedAt: m.closes_at };
    }
    if (m.allowlist_until && t < m.allowlist_until) {
      if (!holdsAlpha || !holdsAlpha()) {
        return {
          ok: false,
          why: 'this is the Alpha holders window: hold an Alpha Verginal to mint before it opens to everyone',
          opensAt: m.allowlist_until,
        };
      }
    }
    if (m.max_per_wallet > 0 && held >= m.max_per_wallet) {
      return { ok: false, why: `one address may mint ${m.max_per_wallet} from this collection` };
    }
    return { ok: true };
  }

  royaltyFor(slug) {
    const c = this.get(slug);
    if (!c) return null;
    const bps = Number(c.manifest.royalty_bps) || 0;
    const address = c.manifest.payout_address || null;
    if (!(bps > 0) || !address) return null;
    return { bps, address };
  }

  get(slug) {
    if (!/^[a-z0-9-]{3,32}$/.test(String(slug || ''))) return null;
    if (!this.live.has(slug)) this.refresh();
    return this.live.get(slug) || null;
  }

  list() {
    this.refresh();
    return [...this.live.entries()].map(([slug, { ctl, manifest }]) => Object.assign(
      {
        slug,
        description: manifest.description || '',
        tagline: manifest.tagline || '',
        creator: manifest.creator || '',
        mediaType: manifest.media_type,
        mintPriceUnits: manifest.mint_price_units || 0,
        royaltyBps: manifest.royalty_bps || 0,
        opensAt: manifest.opens_at || null,
        closesAt: manifest.closes_at || null,
        allowlistUntil: manifest.allowlist_until || null,
        maxPerWallet: manifest.max_per_wallet || 0,
        links: manifest.links || { x: null, discord: null, website: null },
        avatar: manifest.avatar ? `/api/launchpad/${slug}/brand/avatar` : null,
        banner: manifest.banner ? `/api/launchpad/${slug}/brand/banner` : null,
      },
      ctl.status(),
    ));
  }
}

const MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** How long ago, in words. The queue is read by a person, so it says "3 days" not a timestamp. */
function ago(then, now = Date.now()) {
  const d = Math.max(0, now - then);
  const say = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return say(Math.floor(d / MINUTE), 'minute');
  if (d < DAY) return say(Math.floor(d / HOUR), 'hour');
  return say(Math.floor(d / DAY), 'day');
}

/**
 * The review queue as printable lines. The FIRST line answers the only question worth asking
 * from a terminal: has anybody submitted a collection and is it still waiting on me. Everything
 * else is detail underneath it, so the answer is readable without reading the rest.
 */
function queueReport(subs, now = Date.now()) {
  const waiting = subs.filter((d) => d.status === 'pending')
    .sort((x, y) => (x.finalizedAt || x.createdAt) - (y.finalizedAt || y.createdAt));
  const lines = [waiting.length
    ? `${waiting.length} collection${waiting.length === 1 ? '' : 's'} waiting for review`
    : 'nothing waiting for review'];

  if (waiting.length) {
    lines.push('');
    for (const d of waiting) {
      const when = ago(d.finalizedAt || d.createdAt, now);
      const who = d.creator ? ` by ${d.creator}` : '';
      const size = `${d.items.length} item${d.items.length === 1 ? '' : 's'}`;
      lines.push(`  ${d.id}  ${when.padEnd(14)}${size.padStart(10)}  ${d.name}${who}`);
    }
    lines.push('');
    lines.push('  show <id> to look at one, then approve <id> <slug>, or reject <id> [reason]');
  }

  // Half-finished drafts and already-reviewed ones are not the answer, but their absence would
  // be confusing when the counts are visible elsewhere, so they get one line at the bottom.
  const rest = ['draft', 'approved', 'rejected']
    .map((st) => [st, subs.filter((d) => d.status === st).length])
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${st}`);
  if (rest.length) lines.push('', 'also on file: ' + rest.join(', '));
  return lines;
}

module.exports = { Launchpad, sniffImage, cleanAttributes, cleanLink, ago, queueReport, LIMITS };

// --- operator CLI (curation happens here, over SSH, never over HTTP) -------------------------
// Usage, from the app root on the server:
//   node src/launchpad.js              what is waiting for review
//   node src/launchpad.js all          every submission, whatever its state
//   node src/launchpad.js review <id>  one page with everything a decision needs
//   node src/launchpad.js show <id>
//   node src/launchpad.js approve <id> <slug>
//   node src/launchpad.js reject <id> [reason]
if (require.main === module) {
  const dataDir = process.env.VERGINALS_DATA_DIR || path.join(__dirname, '..', 'data');
  const lp = new Launchpad({ dataDir });
  const [raw, a, b] = process.argv.slice(2);
  const cmd = raw || 'list'; // asking with no argument at all is the common case
  try {
    if (cmd === 'list') {
      console.log(queueReport(lp.listSubmissions()).join('\n'));
    } else if (cmd === 'all') {
      const subs = lp.listSubmissions();
      if (!subs.length) console.log('no submissions');
      for (const d of subs) {
        console.log(`${d.id}  ${d.status.padEnd(8)}  ${String(d.items.length).padStart(4)} items  ${d.name}${d.slug ? '  -> /' + d.slug : ''}`);
      }
    } else if (cmd === 'show' && a) {
      const d = lp._loadDraft(a);
      console.log(JSON.stringify({ ...d, items: d.items.slice(0, 5) }, null, 2));
      if (d.items.length > 5) console.log(`(+ ${d.items.length - 5} more items)`);
      console.log('');
      // The two things a decision needs that JSON buries: how to reach them, and where to look.
      console.log(`contact        ${d.contact || '(none given)'}`);
      for (const [k, v] of Object.entries(d.links || {})) if (v) console.log(`${k.padEnd(14)} ${v}`);
      if (d.mintPriceUnits > 0) {
        console.log(`mint price     ${(d.mintPriceUnits / 1000000).toLocaleString()} XVG -> ${d.payoutAddress}`);
      } else {
        console.log('mint price     free');
      }
      console.log(`review the images in: ${path.join(lp.subsDir, d.id, 'images')}`);
    } else if (cmd === 'review' && a) {
      // Written next to the submission, opened from disk. Curation stays off HTTP; this only
      // replaces a JSON dump and a directory path with something a decision can be made from.
      const { reviewPage } = require('./launchpadreview');
      const d = lp._loadDraft(a);
      const out = path.join(lp.subsDir, d.id, 'review.html');
      fs.writeFileSync(out, reviewPage(d, path.join(lp.subsDir, d.id, 'images')));
      console.log(out);
    } else if (cmd === 'approve' && a && b) {
      // The payout address is checked against THIS network before a mint page can point money at
      // it. bitcoinjs is already a dependency here, so this costs nothing and catches a testnet
      // address, a truncated paste, or a checksum that never was.
      const bitcoin = require('bitcoinjs-lib');
      const { pickNetwork } = require('./cli');
      const { network } = pickNetwork(process.env.VERGINALS_NETWORK || 'mainnet');
      const usable = (addr) => {
        try { bitcoin.address.toOutputScript(addr, network); return true; } catch (_) { return false; }
      };
      console.log(JSON.stringify(lp.approve(a, b, { validAddress: usable })));
      console.log('live after the API cache refreshes (about 30 seconds), no restart needed');
    } else if (cmd === 'reject' && a) {
      console.log(JSON.stringify(lp.reject(a, b)));
    } else {
      console.log('usage: node src/launchpad.js [list] | all | show <id> | review <id> | approve <id> <slug> | reject <id> [reason]');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}
