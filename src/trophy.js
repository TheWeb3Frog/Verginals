'use strict';
// Verginals Arena trophy artwork: a self-contained SVG that embeds the champion's Verginal (as a
// data URI, so the trophy is permanent and needs nothing external), framed with a crown, the
// tournament name and the date. The treasury inscribes this to the winner; because it is a normal
// Verge inscription it is then tradeable on the marketplace. Pure and deterministic: no I/O here,
// the caller supplies the image data URI.

const HOUSE_COLOR = { fire: '#e87040', water: '#40a0e8', earth: '#60c040' };
const GOLD = '#d4a840';
const SILVER = '#c8d0d8';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} p
 * @param {number} p.number         champion's Verginals collection number
 * @param {string} [p.house]        fire | water | earth (accent colour)
 * @param {string} p.imageDataUri   data: URI of the champion's Verginal image (embedded)
 * @param {string} p.tournamentName
 * @param {string} p.dateISO        e.g. '2026-07-14'
 * @param {('CHAMPION'|'RUNNER-UP')} [p.place]
 * @returns {string} a standalone SVG document
 */
function buildTrophySVG(p) {
  const place = p.place === 'RUNNER-UP' ? 'RUNNER-UP' : 'CHAMPION';
  const accent = HOUSE_COLOR[String(p.house || '').toLowerCase()] || '#4cc2f1';
  const medal = place === 'CHAMPION' ? GOLD : SILVER;
  const date = esc(p.dateISO || '');
  const tname = esc(p.tournamentName || 'Arena Cup');
  const num = Number(p.number);

  // 640x800 portrait. The Verginal sits in a framed medallion; the crown, place and titles frame it.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 800" width="640" height="800" role="img" aria-label="${place} trophy, Verginals #${num}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0e1620"/>
      <stop offset="1" stop-color="#0a0f16"/>
    </linearGradient>
    <linearGradient id="medal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${medal}"/>
      <stop offset="1" stop-color="#8a6f22"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.5">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <style>
      text { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; fill: #e8eff6; }
      .title { font-size: 46px; font-weight: 800; letter-spacing: 2px; }
      .sub { font-size: 22px; font-weight: 600; fill: #aebccb; }
      .small { font-size: 16px; fill: #7c8b9a; letter-spacing: 1px; }
      .num { font-size: 30px; font-weight: 800; fill: ${accent}; }
      image { image-rendering: pixelated; }
    </style>
  </defs>

  <rect width="640" height="800" fill="url(#bg)"/>
  <rect width="640" height="800" fill="url(#glow)"/>
  <rect x="14" y="14" width="612" height="772" rx="18" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/>

  <!-- crown -->
  <g transform="translate(320 96)" fill="url(#medal)" stroke="#6b551a" stroke-width="2">
    <path d="M -56 30 L -56 -6 L -28 18 L 0 -26 L 28 18 L 56 -6 L 56 30 Z"/>
    <circle cx="-56" cy="-10" r="7"/><circle cx="0" cy="-30" r="8"/><circle cx="56" cy="-10" r="7"/>
    <rect x="-58" y="30" width="116" height="12" rx="3"/>
  </g>

  <text x="320" y="196" text-anchor="middle" class="title" fill="${medal}">${place}</text>

  <!-- medallion framing the Verginal -->
  <g transform="translate(320 430)">
    <circle r="182" fill="none" stroke="url(#medal)" stroke-width="10"/>
    <clipPath id="clip"><circle r="168"/></clipPath>
    <image href="${esc(p.imageDataUri)}" x="-168" y="-168" width="336" height="336" clip-path="url(#clip)" preserveAspectRatio="xMidYMid slice"/>
  </g>

  <text x="320" y="672" text-anchor="middle" class="num">Verginals #${num}${p.house ? ` &#183; House of ${esc(String(p.house)[0].toUpperCase() + String(p.house).slice(1))}` : ''}</text>
  <text x="320" y="712" text-anchor="middle" class="sub">${tname}</text>
  <text x="320" y="748" text-anchor="middle" class="small">VERGINALS ARENA${date ? ` &#183; ${date}` : ''}</text>
</svg>`;
}

module.exports = { buildTrophySVG };
