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

const MAX_ITEMS = 500;
const MAX_IMAGE_BYTES = 60 * 1024; // inscriptions get expensive fast; keep launch v1 modest
const MAX_DRAFT_BYTES = 20 * 1024 * 1024; // one submission's total image budget
const DEFAULT_BUDGET_BYTES = 200 * 1024 * 1024; // everything under launchpad/ combined
const MAX_PENDING = 20; // review-queue cap so disk can't be flooded before curation
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unfinalized drafts older than this are pruned
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

  createDraft({ name, symbol, description, creator }) {
    this.pruneDrafts();
    if (this.pendingCount() >= MAX_PENDING) throw new Error('the review queue is full, please try again later');
    const d = {
      id: crypto.randomBytes(8).toString('hex'),
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

  finalize(id) {
    const d = this._loadDraft(id);
    if (d.status !== 'draft') throw new Error('this submission is closed');
    if (d.items.length < 1) throw new Error('add at least one item first');
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

  approve(id, slug) {
    const d = this._loadDraft(id);
    if (d.status !== 'pending') throw new Error(`submission is ${d.status}, not pending`);
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
    const manifest = {
      name: d.name,
      symbol: d.symbol || null,
      supply: d.items.length,
      media_type: d.mediaType,
      description: d.description || '',
      creator: d.creator || '',
      slug,
      launched_at: new Date().toISOString().slice(0, 10),
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

  get(slug) {
    if (!/^[a-z0-9-]{3,32}$/.test(String(slug || ''))) return null;
    if (!this.live.has(slug)) this.refresh();
    return this.live.get(slug) || null;
  }

  list() {
    this.refresh();
    return [...this.live.entries()].map(([slug, { ctl, manifest }]) => Object.assign(
      { slug, description: manifest.description || '', creator: manifest.creator || '', mediaType: manifest.media_type },
      ctl.status(),
    ));
  }
}

module.exports = { Launchpad, sniffImage, cleanAttributes };

// --- operator CLI (curation happens here, over SSH, never over HTTP) -------------------------
// Usage, from the app root on the server:
//   node src/launchpad.js list
//   node src/launchpad.js show <id>
//   node src/launchpad.js approve <id> <slug>
//   node src/launchpad.js reject <id> [reason]
if (require.main === module) {
  const dataDir = process.env.VERGINALS_DATA_DIR || path.join(__dirname, '..', 'data');
  const lp = new Launchpad({ dataDir });
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      const subs = lp.listSubmissions();
      if (!subs.length) console.log('no submissions');
      for (const d of subs) {
        console.log(`${d.id}  ${d.status.padEnd(8)}  ${String(d.items.length).padStart(4)} items  ${d.name}${d.slug ? '  -> /' + d.slug : ''}`);
      }
    } else if (cmd === 'show' && a) {
      const d = lp._loadDraft(a);
      console.log(JSON.stringify({ ...d, items: d.items.slice(0, 5) }, null, 2));
      if (d.items.length > 5) console.log(`(+ ${d.items.length - 5} more items)`);
      console.log(`review the images in: ${path.join(lp.subsDir, d.id, 'images')}`);
    } else if (cmd === 'approve' && a && b) {
      console.log(JSON.stringify(lp.approve(a, b)));
      console.log('live after the API cache refreshes (about 30 seconds), no restart needed');
    } else if (cmd === 'reject' && a) {
      console.log(JSON.stringify(lp.reject(a, b)));
    } else {
      console.log('usage: node src/launchpad.js list | show <id> | approve <id> <slug> | reject <id> [reason]');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = 1;
  }
}
