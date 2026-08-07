// Charts for the asset market preview. Canvas, no libraries: the site's CSP is default-src 'self'
// and a chart is not worth a build step.
//
// Two decisions worth stating, because both go against what a token market normally looks like.
//
// NO CANDLESTICKS. An OHLC candle needs an open, a high, a low and a close inside every interval.
// Trades here are individual atomic swaps, and on a young asset there are a handful a day. Deriving
// four numbers from two trades draws a shape that says "market" while carrying almost no
// information. A line through the actual trades, with the trades marked, shows thin volume as thin
// instead of dressing it up.
//
// NO SECOND Y AXIS. Price and volume are different scales, so they are two charts stacked on a
// shared x rather than one chart with two axes, which is the single most misread chart there is.

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

const css = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const TOKENS = () => ({
  accent: css('--accent', '#4cc2f1'),
  line: css('--line', '#26323f'),
  muted: css('--muted', '#8ea0b2'),
  txt: css('--txt', '#e8eff6'),
  surface: css('--card', '#16202c'),
});

const fmtPrice = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4));
const fmtShort = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B`
  : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
    : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));

/** Set up a canvas at device resolution and return its 2d context in CSS pixels. */
function fit(canvas, w, h) {
  const r = DPR();
  canvas.width = Math.round(w * r);
  canvas.height = Math.round(h * r);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}

/**
 * A price line with its trades marked.
 *
 * @param {object} opts
 * @param {Array}  opts.points  [{ t: unix seconds, v: price, trade?: boolean }]
 * @param {Function} [opts.onHover] called with the hovered point, or null
 */
export function priceChart(host, opts) {
  const { points } = opts;
  const T = TOKENS();
  const PAD = { l: 8, r: 62, t: 14, b: 22 };

  host.textContent = '';
  host.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  host.append(canvas);

  const tip = document.createElement('div');
  tip.className = 'vr-tip';
  tip.hidden = true;
  host.append(tip);

  let geom = null;

  const draw = () => {
    const w = host.clientWidth;
    const h = opts.height || 260;
    const ctx = fit(canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    const lo = Math.min(...points.map((p) => p.v));
    const hi = Math.max(...points.map((p) => p.v));
    const pad = (hi - lo) * 0.12 || hi * 0.1 || 1;
    const min = Math.max(0, lo - pad);
    const max = hi + pad;
    const x = (i) => PAD.l + (i / (points.length - 1)) * (w - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * (h - PAD.t - PAD.b);
    geom = { x, y, w, h, min, max };

    // Grid: hairline, solid, one step off the surface, and recessive. Four lines, no more.
    ctx.strokeStyle = T.line;
    ctx.lineWidth = 1;
    ctx.fillStyle = T.muted;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const v = min + ((max - min) * i) / 3;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, yy);
      ctx.lineTo(w - PAD.r, yy);
      ctx.stroke();
      ctx.fillText(fmtPrice(v), w - PAD.r + 8, yy);
    }

    // Area wash at ~10%, never a saturated block.
    ctx.beginPath();
    ctx.moveTo(x(0), y(points[0].v));
    for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i].v));
    ctx.lineTo(x(points.length - 1), h - PAD.b);
    ctx.lineTo(x(0), h - PAD.b);
    ctx.closePath();
    ctx.fillStyle = `${T.accent}1a`;
    ctx.fill();

    // The line: 2px, round join and cap.
    ctx.beginPath();
    ctx.moveTo(x(0), y(points[0].v));
    for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i].v));
    ctx.strokeStyle = T.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Every actual trade gets a dot. This is the honest part: gaps between dots are days when
    // nothing traded, and the reader can see that rather than infer a smooth market.
    for (let i = 0; i < points.length; i++) {
      if (!points[i].trade) continue;
      ctx.beginPath();
      ctx.arc(x(i), y(points[i].v), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = T.accent;
      ctx.fill();
      ctx.strokeStyle = T.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // End marker, ≥8px with its 2px surface ring, plus the one direct label worth having.
    const last = points.length - 1;
    ctx.beginPath();
    ctx.arc(x(last), y(points[last].v), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = T.accent;
    ctx.fill();
    ctx.strokeStyle = T.surface;
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  // The crosshair finds the X: readers aim at a date, never at a 2px line.
  const overlay = document.createElement('div');
  overlay.className = 'vr-cross';
  overlay.hidden = true;
  host.append(overlay);

  const move = (clientX) => {
    if (!geom) return;
    const rect = host.getBoundingClientRect();
    const px = clientX - rect.left;
    const step = (geom.w - PAD.l - PAD.r) / (points.length - 1);
    let i = Math.round((px - PAD.l) / step);
    i = Math.max(0, Math.min(points.length - 1, i));
    const p = points[i];

    overlay.hidden = false;
    overlay.style.left = `${geom.x(i)}px`;
    overlay.style.top = `${PAD.t}px`;
    overlay.style.height = `${geom.h - PAD.t - PAD.b}px`;

    tip.hidden = false;
    tip.textContent = '';
    // Values lead, labels follow: the reader already knows the series and wants the number.
    const v = document.createElement('div');
    v.className = 'vr-tip-v';
    v.textContent = `${fmtPrice(p.v)} XVG`;
    const d = document.createElement('div');
    d.className = 'vr-tip-l';
    d.textContent = new Date(p.t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      + (p.trade ? ' · traded' : ' · no trade, last price');
    tip.append(v, d);
    const tx = Math.min(Math.max(geom.x(i) - 60, 0), geom.w - 150);
    tip.style.left = `${tx}px`;
    tip.style.top = `${Math.max(0, geom.y(p.v) - 58)}px`;
    if (opts.onHover) opts.onHover(p);
  };

  const leave = () => {
    overlay.hidden = true;
    tip.hidden = true;
    if (opts.onHover) opts.onHover(null);
  };

  host.addEventListener('pointermove', (e) => move(e.clientX));
  host.addEventListener('pointerleave', leave);
  // Same details on keyboard focus as on hover.
  host.tabIndex = 0;
  host.addEventListener('focus', () => {
    const rect = host.getBoundingClientRect();
    move(rect.left + rect.width - PAD.r);
  });
  host.addEventListener('blur', leave);

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
  return { redraw: draw };
}

/**
 * Volume, as its own chart under the price one. Bars carry their own hover: on bars the mark is the
 * hit target, so there is no crosshair here.
 */
export function volumeChart(host, opts) {
  const { points } = opts;
  const T = TOKENS();
  const PAD = { l: 8, r: 62, t: 8, b: 20 };

  host.textContent = '';
  host.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  host.append(canvas);
  const tip = document.createElement('div');
  tip.className = 'vr-tip';
  tip.hidden = true;
  host.append(tip);

  let bars = [];

  const draw = () => {
    const w = host.clientWidth;
    const h = opts.height || 84;
    const ctx = fit(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(...points.map((p) => p.v), 1);
    const inner = w - PAD.l - PAD.r;
    const slot = inner / points.length;
    // Cap the bar and let the leftover be air rather than filling the slot, with a 2px gap between
    // neighbours so they read as separate without a stroke.
    const bw = Math.min(24, Math.max(2, slot - 2));

    ctx.fillStyle = T.muted;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtShort(max), w - PAD.r + 8, PAD.t + 5);

    bars = [];
    for (let i = 0; i < points.length; i++) {
      const bh = (points[i].v / max) * (h - PAD.t - PAD.b);
      const bx = PAD.l + i * slot + (slot - bw) / 2;
      const by = h - PAD.b - bh;
      bars.push({ x: bx, w: bw, i });
      if (bh <= 0) continue;
      // 4px rounded data-end, square at the baseline.
      const r = Math.min(4, bw / 2, bh);
      ctx.beginPath();
      ctx.moveTo(bx, h - PAD.b);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by, bx + r, by);
      ctx.lineTo(bx + bw - r, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
      ctx.lineTo(bx + bw, h - PAD.b);
      ctx.closePath();
      ctx.fillStyle = `${T.accent}59`;
      ctx.fill();
    }
  };

  host.addEventListener('pointermove', (e) => {
    const rect = host.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // The hit target is bigger than the mark: nearest slot, not the painted pixels.
    let best = null;
    let bestD = Infinity;
    for (const b of bars) {
      const d = Math.abs(px - (b.x + b.w / 2));
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best || bestD > 24) { tip.hidden = true; return; }
    const p = points[best.i];
    tip.hidden = false;
    tip.textContent = '';
    const v = document.createElement('div');
    v.className = 'vr-tip-v';
    v.textContent = `${fmtShort(p.v)} XVG`;
    const d = document.createElement('div');
    d.className = 'vr-tip-l';
    d.textContent = `${new Date(p.t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${p.trades || 0} trade${p.trades === 1 ? '' : 's'}`;
    tip.append(v, d);
    tip.style.left = `${Math.min(Math.max(best.x - 55, 0), host.clientWidth - 150)}px`;
    tip.style.top = '2px';
  });
  host.addEventListener('pointerleave', () => { tip.hidden = true; });

  draw();
  new ResizeObserver(() => draw()).observe(host);
  return { redraw: draw };
}

/** A 12-point sparkline for a table row. One hue, no axes, no labels: it is a shape, not a chart. */
export function sparkline(values, w = 88, h = 26) {
  const T = TOKENS();
  const canvas = document.createElement('canvas');
  const ctx = fit(canvas, w, h);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) => 1 + (i / (values.length - 1)) * (w - 2);
  const y = (v) => 3 + (1 - (v - lo) / span) * (h - 6);
  ctx.beginPath();
  ctx.moveTo(x(0), y(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
  ctx.strokeStyle = T.accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  canvas.setAttribute('role', 'img');
  return canvas;
}

export { fmtPrice, fmtShort };
