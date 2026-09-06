'use strict';
// One page that answers "should this go live", instead of a JSON dump and a path on a server.
//
// The review command printed the draft record and told the operator which directory the images were
// in. That directory is on a machine they reach over ssh, so looking at the art meant copying files
// down by hand, and the decision that actually matters, whether this is somebody else's art, could
// not be made from the terminal at all.
//
// Everything a decision needs, on one page: every image, what the collection is made of, whether it
// contains the same file twice, what it charges and who it pays, and the links resolved so the X
// account can be opened and checked.
//
// It is a FILE, not a route. Curation is deliberately unreachable over HTTP and this does not
// change that: the page is written next to the submission and opened from disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TILES = 300; // a 10,000 item collection would otherwise be a 200 MB page

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Every item's file, hashed, so the same picture submitted twice is found before anybody mints it.
 * Duplicates are the most common defect in a generated collection and the least visible: nothing
 * about a 10,000 item folder makes two identical files obvious.
 */
function duplicates(dir, items) {
  const seen = new Map();
  const dupes = [];
  for (const it of items) {
    const file = path.join(dir, it.filename);
    let h;
    try { h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch (_) { continue; }
    const first = seen.get(h);
    if (first) dupes.push({ a: first, b: it.number });
    else seen.set(h, it.number);
  }
  return dupes;
}

/** What the collection is made of, counted rather than claimed. */
function distribution(items) {
  const groups = new Map();
  for (const it of items) {
    for (const a of it.attributes || []) {
      if (!groups.has(a.trait_type)) groups.set(a.trait_type, new Map());
      const g = groups.get(a.trait_type);
      g.set(a.value, (g.get(a.value) || 0) + 1);
    }
  }
  return [...groups.entries()].map(([type, values]) => ({
    type,
    values: [...values.entries()].sort((a, b) => b[1] - a[1]),
  }));
}

/** One item's picture, inlined so the page is a single file that can be opened anywhere. */
function tile(dir, it, mediaType) {
  let data = '';
  try { data = fs.readFileSync(path.join(dir, it.filename)).toString('base64'); }
  catch (_) { return `<figure class="t missing"><div class="ph">missing</div><figcaption>#${it.number}</figcaption></figure>`; }
  return `<figure class="t"><img src="data:${mediaType};base64,${data}" alt="" loading="lazy" />`
    + `<figcaption>#${it.number} ${esc(it.name || '')}</figcaption></figure>`;
}

/**
 * @param {object} draft   the submission record
 * @param {string} dir     the directory holding its images
 * @returns {string} a standalone HTML page
 */
function reviewPage(draft, dir) {
  const items = draft.items || [];
  const dupes = duplicates(dir, items);
  const dist = distribution(items);
  const bytes = draft.totalBytes || 0;
  const formats = new Set(items.map((i) => path.extname(i.filename).toLowerCase()));
  const withTraits = items.filter((i) => (i.attributes || []).length).length;

  const facts = [
    ['Items', items.length.toLocaleString()],
    ['Total size', (bytes / 1024 / 1024).toFixed(2) + ' MB'],
    ['Largest allowed', '16 KB each'],
    ['Formats', [...formats].join(', ') || 'none'],
    ['With traits', `${withTraits.toLocaleString()} of ${items.length.toLocaleString()}`],
    ['Mint price', draft.mintPriceUnits > 0 ? (draft.mintPriceUnits / 1e6).toLocaleString() + ' XVG' : 'free'],
    ['Resale royalty', draft.royaltyBps > 0 ? (draft.royaltyBps / 100) + '%' : 'none'],
    ['Paid to', draft.payoutAddress || 'nobody'],
    ['Submitted by', draft.address || 'unsigned'],
    ['Contact', draft.contact || 'none given'],
  ];

  const links = Object.entries(draft.links || {}).filter(([, v]) => v);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Review: ${esc(draft.name)}</title>
<style>
  :root { --bg:#0b1017; --card:#16202c; --line:#26323f; --txt:#e8eff6; --muted:#8ea0b2;
          --dim:rgba(232,239,246,.5); --accent:#4cc2f1; --ok:#38d39f; --danger:#ff6b6b;
          --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color-scheme:dark; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:400 14px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .wrap { max-width:1200px; margin:0 auto; padding:32px 24px 80px }
  h1 { font-size:30px; line-height:1.1; letter-spacing:-.02em; margin:0 0 4px }
  .by { color:var(--muted); margin:0 0 22px }
  h2 { font-size:17px; margin:34px 0 12px; padding-bottom:8px; border-bottom:1px solid var(--line) }
  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1px;
           background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden }
  .f { background:var(--card); padding:12px 14px }
  .f dt { font:500 10px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--dim); margin-bottom:5px }
  .f dd { margin:0; font:500 14px/1.35 var(--mono); word-break:break-all }
  .alert { border-radius:10px; padding:13px 16px; margin:14px 0; border:1px solid var(--danger); color:var(--danger) }
  .fine { border-color:var(--ok); color:var(--ok) }
  .links a { color:var(--accent); margin-right:16px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(112px,1fr)); gap:8px }
  .t { margin:0; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden }
  .t img { width:100%; aspect-ratio:1; object-fit:cover; display:block }
  .t .ph { aspect-ratio:1; display:grid; place-items:center; color:var(--danger); font-size:11px }
  .t figcaption { padding:5px 7px; font:400 10.5px/1.35 var(--mono); color:var(--muted);
                  white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  .t.missing { border-color:var(--danger) }
  .dist { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:18px }
  .dg h3 { font:500 10px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--dim); margin:0 0 8px }
  .dr { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:13px }
  .dr span { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .dr b { font:500 12px/1.4 var(--mono); white-space:nowrap }
  .dr.rare b { color:var(--accent) }
  .desc { color:var(--muted); max-width:70ch }
  .cmd { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px;
         font:400 12.5px/1.7 var(--mono); color:var(--txt); overflow-x:auto; white-space:pre }
</style></head><body><div class="wrap">

<h1>${esc(draft.name)}</h1>
<p class="by">${esc(draft.tagline || draft.description || '')}${draft.creator ? ' &middot; by ' + esc(draft.creator) : ''}</p>

${dupes.length
    ? `<div class="alert"><b>${dupes.length} duplicate image${dupes.length === 1 ? '' : 's'}.</b> `
      + dupes.slice(0, 12).map((d) => `#${d.b} is the same file as #${d.a}`).join(', ')
      + (dupes.length > 12 ? `, and ${dupes.length - 12} more` : '') + '.</div>'
    : '<div class="alert fine">No duplicate images. Every file in this collection is distinct.</div>'}
${formats.size > 1 ? `<div class="alert"><b>Mixed formats:</b> ${[...formats].join(', ')}. A collection is one format.</div>` : ''}

<h2>The facts</h2>
<dl class="facts">${facts.map(([k, v]) => `<div class="f"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>

${links.length ? `<h2>Links</h2><p class="links">${links.map(([k, v]) => `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(k)}: ${esc(v)}</a>`).join('')}</p>` : ''}

${draft.description ? `<h2>Description</h2><p class="desc">${esc(draft.description)}</p>` : ''}

${dist.length ? `<h2>What it is made of</h2><div class="dist">${dist.map((g) => `<div class="dg"><h3>${esc(g.type)}</h3>`
    + g.values.slice(0, 14).map(([v, n]) => {
      const pct = (n / items.length) * 100;
      return `<div class="dr${pct < 5 ? ' rare' : ''}"><span>${esc(v)}</span><b>${n} &middot; ${pct < 1 ? pct.toFixed(2) : pct.toFixed(0)}%</b></div>`;
    }).join('')
    + (g.values.length > 14 ? `<div class="dr"><span>and ${g.values.length - 14} more</span><b></b></div>` : '')
    + '</div>').join('')}</div>` : ''}

<h2>Every item${items.length > MAX_TILES ? `, first ${MAX_TILES} of ${items.length.toLocaleString()}` : ''}</h2>
<div class="grid">${items.slice(0, MAX_TILES).map((it) => tile(dir, it, draft.mediaType || 'image/webp')).join('')}</div>

<h2>Decide</h2>
<div class="cmd">./scripts/launchpad approve ${esc(draft.id)} &lt;slug&gt;
./scripts/launchpad reject ${esc(draft.id)} "why"</div>

</div></body></html>`;
}

module.exports = { reviewPage, duplicates, distribution, MAX_TILES };
