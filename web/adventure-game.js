// Second Form: the vertical slice. Minute zero to minute twelve.
//
// One hunt, one fight with the Flip fully staged, and the nutrient loop closing on screen. That is
// deliberately all of it. Everything downstream of minute twelve (breeding, Vigor, inbreeding, the
// grail hunt) is designed and specified, and none of it is worth building until this stretch is
// compelling, because nothing downstream can rescue it.
//
// The rules are not reimplemented here. adventure-core.js is the same code node runs and the same
// code the tests cover, so a fight the player watches is a fight a server could recompute.

import { pool, combat, hunt as HUNT, vivarium as VIV, runes as RUNES } from '/adventure-core.js';
import { drawCat, drawRune, drawSilhouette, preload, traitsOf, houseHex } from '/adventure-creature.js';

const $ = (id) => document.getElementById(id);
const cv = $('scene'), ctx = cv.getContext('2d');

// --- scene ------------------------------------------------------------------------------------

const S = {
  screen: 'title',
  t: 0,
  look: { x: 0, y: 0, dilate: false },
  me: null, them: null, fight: null,
  hunt: null, viv: null,
  shakes: 0, flipStage: null, floats: [], wave: null,
  vivFx: [],
};

function fit() {
  const d = Math.min(devicePixelRatio || 1, 2);
  cv.width = innerWidth * d; cv.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
addEventListener('resize', fit); fit();

addEventListener('pointermove', (e) => {
  const cx = innerWidth / 2, cy = innerHeight * 0.42;
  S.look.x = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth * 0.5)));
  S.look.y = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight * 0.5)));
  S.look.dilate = e.clientY < innerHeight * 0.55;
});

function show(name) {
  S.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 's-' + name;
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms);
}
function hint(id, text) { const el = $(id); el.style.opacity = 0; setTimeout(() => { el.textContent = text; el.style.opacity = 1; }, 200); }

// --- the founder ------------------------------------------------------------------------------

// A founder is homozygous at every locus, which is the whole reason the Flip button starts locked.
// Drawn at collection frequency so the cat on the title screen is a plausible Alpha, not a showcase.
function makeFounder(seed) {
  const genome = {};
  for (const locus of pool.LOCI) {
    const r = HUNT.drawByFrequency(locus, HUNT.draw(seed, 'f:' + locus));
    genome[locus] = [r, r];
  }
  return combat.createFighter({ id: 'founder:' + seed, name: 'Your Alpha', genome, catnip: 0 });
}

// --- render -----------------------------------------------------------------------------------

function bg(g0, g1) {
  const g = ctx.createLinearGradient(0, 0, 0, innerHeight);
  g.addColorStop(0, g0); g.addColorStop(1, g1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, innerWidth, innerHeight);
}

function render(dt) {
  S.t += dt;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  if (S.screen === 'title') renderTitle();
  else if (S.screen === 'hunt') renderHunt();
  else if (S.screen === 'fight') renderFight();
  else if (S.screen === 'spoils') renderSpoils();
  else if (S.screen === 'viv') renderViv();

  // floating damage numbers, gold and large when the triangle is with you
  S.floats = S.floats.filter((f) => (f.life -= dt) > 0);
  for (const f of S.floats) {
    const p = 1 - f.life / f.max;
    ctx.save();
    ctx.globalAlpha = Math.min(1, f.life * 3);
    ctx.fillStyle = f.color;
    ctx.font = `800 ${f.size}px var(--sans), system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y - p * 46);
    ctx.restore();
  }
}

function renderTitle() {
  bg('#141826', '#0B0D14');
  const s = Math.min(innerWidth * 0.42, 230);
  // The sprites have fixed eyes, so attention is carried by the whole creature instead: it leans a
  // few degrees toward the cursor. Cheap, works on all 33 bodies, and needs no new art.
  ctx.save();
  ctx.translate(innerWidth * 0.72, innerHeight * 0.46);
  ctx.rotate(S.look.x * 0.045);
  drawCat(ctx, S.me, { x: 0, y: S.look.y * 4, size: s, breathe: S.t * 1.6 });
  ctx.restore();
}

function renderHunt() {
  bg('#101a20', '#0B0D14');
  // a soft horizon so the map does not float in a void
  ctx.fillStyle = '#0e1b1e';
  ctx.beginPath(); ctx.ellipse(innerWidth / 2, innerHeight * 1.15, innerWidth, innerHeight * 0.45, 0, 0, 7); ctx.fill();
}

function renderFight() {
  const f = S.fight;
  const arenaHue = { 'Night Sky': ['#0d1030', '#05060f'], Punk: ['#2a0f30', '#0B0D14'], Zombie: ['#12220f', '#0B0D14'], Spectrum: ['#241035', '#0B0D14'] };
  const pair = arenaHue[f ? f.arena.name : ''] || ['#1a1420', '#0B0D14'];
  bg(pair[0], pair[1]);

  if (f && f.arena.name === 'Night Sky') {
    for (let i = 0; i < 60; i++) {
      const x = (i * 977 % innerWidth), y = (i * 613 % (innerHeight * 0.6));
      ctx.fillStyle = `rgba(255,255,255,${0.12 + 0.5 * Math.abs(Math.sin(S.t + i))})`;
      ctx.fillRect(x, y, 1.6, 1.6);
    }
  }

  const shake = S.shakes > 0 ? Math.sin(S.t * 60) * S.shakes * 7 : 0;
  ctx.save(); ctx.translate(shake, 0);
  S.shakes = Math.max(0, S.shakes - 0.9 / 60);

  const s = Math.min(innerWidth * 0.30, 140);
  const stage = S.flipStage;

  // the opponent, upper left, facing us
  drawCat(ctx, S.them, {
    x: innerWidth * 0.30, y: innerHeight * 0.34, size: s, breathe: S.t * 1.5, facing: 1, hideRune: true,
    desaturate: stage && stage.side === 1 ? stage.desat : 0,
    flash: stage && stage.side === 1 ? stage.flash : 0,
  });
  drawRune(ctx, RUNES.familyOf(S.them.rune), RUNES.colourOf(S.them.rune),
    innerWidth * 0.30 + s * 0.74, innerHeight * 0.34 - s * 0.44, s * 0.34,
    f ? Math.min(1, S.them.runeCharge / combat.runeCost(f, 1)) : 0,
    f ? S.them.runeCharge >= combat.runeCost(f, 1) : false);

  // yours, lower right
  drawCat(ctx, S.me, {
    x: innerWidth * 0.68, y: innerHeight * 0.60, size: s * 1.05, breathe: S.t * 1.7, facing: -1, hideRune: true,
    desaturate: stage && stage.side === 0 ? stage.desat : 0,
    flash: stage && stage.side === 0 ? stage.flash : 0,
  });

  // the Flip rewrite: a band of light sweeping bottom to top over the sprite
  if (stage && stage.sweep > 0) {
    const who = stage.side === 0 ? { x: innerWidth * 0.68, y: innerHeight * 0.60, s: s * 1.05 } : { x: innerWidth * 0.30, y: innerHeight * 0.34, s };
    const top = who.y - who.s * 0.6, h = who.s * 1.25;
    const yy = top + h * (1 - stage.sweep);
    const g = ctx.createLinearGradient(0, yy - 20, 0, yy + 20);
    g.addColorStop(0, '#ffffff00'); g.addColorStop(0.5, '#ffffffcc'); g.addColorStop(1, '#ffffff00');
    ctx.fillStyle = g;
    ctx.fillRect(who.x - who.s * 0.7, yy - 20, who.s * 1.4, 40);
  }
  ctx.restore();
}

function renderSpoils() { bg('#171326', '#0B0D14'); }

// The paludarium, in cross section. Water at the bottom, land above, and everything the simulation
// says exists gets a body on screen: this is the one screen where the player has to be able to
// count their own animals.
function renderViv() {
  const v = S.viv;
  bg('#101825', '#0B0D14');
  const waterTop = innerHeight * 0.70;
  const soilTop = innerHeight * 0.52;

  // basin
  const lvl = v ? v.basin.water / v.basinCap : 0;
  const wy = innerHeight - (innerHeight - waterTop) * Math.max(0.06, lvl);
  const wg = ctx.createLinearGradient(0, wy, 0, innerHeight);
  wg.addColorStop(0, '#2f6f9e88'); wg.addColorStop(1, '#123a5ccc');
  ctx.fillStyle = wg; ctx.fillRect(0, wy, innerWidth, innerHeight - wy);
  ctx.strokeStyle = '#7fd0f055'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= innerWidth; x += 8) ctx.lineTo(x, wy + Math.sin(x * 0.02 + S.t * 1.4) * 3);
  ctx.stroke();

  // algae motes
  const algae = v ? v.basin.algae : 0;
  for (let i = 0; i < algae * 3; i++) {
    const x = (i * 131 % innerWidth), y = wy + 14 + (i * 71 % Math.max(20, innerHeight - wy - 20));
    ctx.fillStyle = '#8fd04a88';
    ctx.beginPath(); ctx.arc(x + Math.sin(S.t + i) * 4, y, 2.4, 0, 7); ctx.fill();
  }

  // glims
  const glims = v ? v.glims.length : 0;
  for (let i = 0; i < glims; i++) {
    const ph = S.t * 0.6 + i * 1.7;
    const x = innerWidth * (0.15 + 0.7 * (0.5 + 0.5 * Math.sin(ph)));
    const y = wy + 26 + ((i * 37) % Math.max(24, innerHeight - wy - 40));
    const dir = Math.cos(ph) >= 0 ? 1 : -1;
    ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
    ctx.fillStyle = '#cfe8f5';
    ctx.beginPath(); ctx.ellipse(0, 0, 9, 4.4, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-15, -5); ctx.lineTo(-15, 5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#0B0D14';
    ctx.beginPath(); ctx.arc(4, -1, 1.4, 0, 7); ctx.fill();
    ctx.restore();
  }

  // soil
  const sg = ctx.createLinearGradient(0, soilTop, 0, wy);
  sg.addColorStop(0, '#3a2a1e'); sg.addColorStop(1, '#241a12');
  ctx.fillStyle = sg; ctx.fillRect(0, soilTop, innerWidth, wy - soilTop);
  const damp = v ? Math.min(1, v.humidity / 100) : 0;
  ctx.fillStyle = `rgba(60,40,24,${0.25 + damp * 0.5})`;
  ctx.fillRect(0, soilTop, innerWidth, 10);

  // plants
  const plants = v ? v.plants : [];
  plants.forEach((p, i) => {
    const x = innerWidth * (0.08 + 0.84 * ((i + 0.5) / Math.max(6, plants.length)));
    const mature = p.stage === 'mature';
    const h = (mature ? 52 : 18) * (0.9 + 0.1 * Math.sin(S.t * 1.2 + i));
    const col = p.species === 'Catnip' ? '#9AC46A' : '#7FA83F';
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, soilTop); ctx.quadraticCurveTo(x + Math.sin(S.t + i) * 5, soilTop - h * 0.6, x, soilTop - h); ctx.stroke();
    if (mature) {
      ctx.fillStyle = col;
      for (const a of [-0.7, 0.7]) {
        ctx.beginPath(); ctx.ellipse(x + a * 11, soilTop - h + 4, 9, 5, a * 0.5, 0, 7); ctx.fill();
      }
      if (p.species === 'Catnip') { ctx.fillStyle = '#D8E88A'; ctx.beginPath(); ctx.arc(x, soilTop - h - 5, 4, 0, 7); ctx.fill(); }
    }
  });

  // greens waiting to be eaten
  for (let i = 0; i < Math.min(8, v ? v.greens : 0); i++) {
    ctx.fillStyle = '#A8CC63';
    ctx.beginPath(); ctx.arc(innerWidth * 0.12 + i * 15, soilTop - 6, 4, 0, 7); ctx.fill();
  }

  // nubbins hopping on the substrate
  const nub = v ? v.nubbins.length : 0;
  for (let i = 0; i < Math.min(nub, 14); i++) {
    const ph = S.t * 1.8 + i * 2.1;
    const x = innerWidth * (0.1 + 0.8 * ((i * 0.37 + Math.sin(ph * 0.3) * 0.15 + 1) % 1));
    const hop = Math.max(0, Math.sin(ph)) * 9;
    const squash = 1 + Math.max(0, -Math.sin(ph)) * 0.18;
    ctx.save(); ctx.translate(x, soilTop - 9 - hop); ctx.scale(squash, 1 / squash);
    ctx.fillStyle = '#D8CDB6';
    ctx.beginPath(); ctx.ellipse(0, 0, 10, 8, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#B3A88F';
    ctx.beginPath(); ctx.ellipse(-4, -6, 2.4, 5, -0.3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3, -6, 2.4, 5, 0.3, 0, 7); ctx.fill();
    ctx.fillStyle = '#0B0D14';
    ctx.beginPath(); ctx.arc(4, -1, 1.3, 0, 7); ctx.fill();
    ctx.restore();
  }

  // droppings on the substrate, inert until the water carries them
  for (let i = 0; i < Math.min(10, v ? v.droppings : 0); i++) {
    ctx.fillStyle = '#4a3a26';
    ctx.beginPath(); ctx.arc(innerWidth * 0.2 + i * 19, soilTop - 3, 3, 0, 7); ctx.fill();
  }

  // the irrigation wave: the one animation that explains the whole nutrient loop
  if (S.wave !== null) {
    S.wave += 1 / 72;
    const x = S.wave * innerWidth * 1.3 - innerWidth * 0.15;
    const g = ctx.createLinearGradient(x - 90, 0, x + 30, 0);
    g.addColorStop(0, '#7fd0f000'); g.addColorStop(0.7, '#7fd0f066'); g.addColorStop(1, '#7fd0f000');
    ctx.fillStyle = g; ctx.fillRect(x - 90, soilTop - 6, 120, wy - soilTop + 10);
    if (S.wave > 1) S.wave = null;
  }
}

let last = performance.now();
function loop(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; render(dt); requestAnimationFrame(loop); }
requestAnimationFrame(loop);

// --- title ------------------------------------------------------------------------------------

S.me = makeFounder(String(Math.floor(Math.random() * 1e9)));
preload(traitsOf(S.me));
show('title');

$('go-hunt').onclick = () => {
  S.hunt = HUNT.generateHunt('run-' + Date.now(), { firstEver: true, party: 1 });
  drawMap();
  show('hunt');
  hint('hunt-hint', 'Eight steps, then you have to be home. The icons are what is there.');
};

// --- hunt -------------------------------------------------------------------------------------

const ICON = { dew: '💧', pool: '💧', spring: '💧', seeds: '🌱', nubbin: '🐇', glim: '🐟', wild: '🐈', empty: '·' };

function drawMap() {
  const map = $('map'); map.innerHTML = '';
  S.hunt.nodes.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'node' + (n.visited ? ' done' : '') + (n.type === 'wild' && !n.visited ? ' wild' : '');
    b.textContent = n.visited ? '·' : ICON[n.type];
    b.disabled = n.visited || S.hunt.over;
    b.onclick = () => step(i);
    map.appendChild(b);
  });
  $('stamina').textContent = 'Stamina ' + S.hunt.stamina;
  const g = S.hunt.bag;
  $('bag').textContent = `Water ${g.water} · ${g.seeds} seeds · ${g.nubbins} nubbins · ${g.glims} glims`;
  $('go-home').hidden = !(S.hunt.stamina <= 2 || S.hunt.over);
}

function step(i) {
  const got = HUNT.visit(S.hunt, i);
  if (got.error) return toast(got.error);
  drawMap();
  if (got.wild) return startFight(got.wild);
  const bits = [];
  if (got.water) bits.push(got.water + ' water');
  if (got.seeds) bits.push(got.seeds + ' seeds');
  if (got.nubbins) bits.push(got.nubbins + ' nubbins');
  if (got.glims) bits.push(got.glims + ' glims');
  if (bits.length) toast(bits.join(', '));
  if (got.water && !step.taught) { step.taught = true; hint('hunt-hint', 'That water is the only thing that will move nitrogen through your vivarium.'); }
  if (S.hunt.over) hint('hunt-hint', 'Out of stamina. Head home.');
}

$('go-home').onclick = () => enterVivarium();

// --- combat -----------------------------------------------------------------------------------

function startFight(wild) {
  // The first fight is taught by the opponent, because the player's own cat is whatever they own
  // and cannot be scripted. It is generated to lose: its House is the one yours beats, and its
  // Second Form is the one that beats you, so the Flip lands as a scare and never as a defeat.
  const beatenBy = { Fire: 'Earth', Water: 'Fire', Earth: 'Water' };
  if (!startFight.taught) {
    const mine = S.me.house;
    const target = pool.rankOf('House', beatenBy[mine]);
    const flipTo = pool.rankOf('House', { Fire: 'Water', Water: 'Earth', Earth: 'Fire' }[mine]);
    wild.genome.House = [target, flipTo];
    wild.genome.Face = [pool.rankOf('Face', 'Perplexed Small'), pool.rankOf('Face', 'Perplexed Small')];
    wild.genome.Rune = [pool.rankOf('Rune', 'Fire Red'), pool.rankOf('Rune', 'Fire Red')];
    // House is fully co-dominant (1111/1111/1111), so which of the two a hybrid SHOWS is a draw
    // seeded on its id, not the order of the pair. Setting the genome is therefore not enough: the
    // first fight has to be favourable to the player and the coin can land either way. Re-salt the
    // id until the wild wears the House the player beats, and keep the other as its Second Form,
    // which is exactly the cat the tutorial needs: losing now, winning after it flips.
    let salted = null;
    for (let k = 0; k < 32 && !salted; k++) {
      const c = combat.createFighter({ id: wild.id + ':' + k, name: 'Wild Alpha', genome: wild.genome, catnip: 1 });
      if (c.house === beatenBy[mine]) salted = c;
    }
    wild = salted || combat.createFighter({ id: wild.id, name: 'Wild Alpha', genome: wild.genome, catnip: 1 });
    // Cow gives a founder with Force under 10 an unwinnable slog, so the tutorial opponent is small.
    if (combat.forceOf(S.me) < 10) wild.maxHp = wild.hp = 35;
  }
  S.them = wild;
  preload(traitsOf(wild));
  S.fight = combat.startFight({ a: S.me, b: S.them, seed: 'fight-' + Date.now() });
  S.fight.mine = 0;
  paintFight();
  show('fight');
  hint('fight-hint', 'Claw. Watch the size and colour of the number.');
  if (S.fight.toAct === 1) scheduleBot(750);
}

function paintFight() {
  const f = S.fight;
  const set = (el, x, sub) => {
    el.querySelector('b').textContent = x.name;
    el.querySelector('span').textContent = sub;
    const bar = el.querySelector('.hpbar');
    const pct = Math.max(0, x.hp / x.maxHp);
    bar.querySelector('i').style.width = (pct * 100) + '%';
    bar.classList.toggle('low', pct < 0.35);
  };
  const vision = combat.visionOf(f, 0);
  set($('f-them'), S.them, `${S.them.house} · ${S.them.body.name}` + (vision === 'genome' ? ' · you see everything' : ''));
  set($('f-me'), S.me, `${S.me.house} · ${S.me.body.name}`);

  const cost = combat.runeCost(f, 0);
  const ready = S.me.runeCharge >= cost;
  $('b-rune').classList.toggle('ready', ready);
  $('rune-charge').textContent = ready ? RUNES.familyOf(S.me.rune).toLowerCase() : `${Math.min(S.me.runeCharge, cost)}/${cost}`;

  const canFlip = S.me.canFlip && !S.me.hasFlipped && S.me.catnip > 0;
  $('b-flip').classList.toggle('locked', !canFlip);
  $('flip-note').textContent = !S.me.canFlip ? 'no second form' : (S.me.hasFlipped ? 'spent' : (S.me.catnip ? 'ready' : 'needs catnip'));
  $('second-frame').hidden = false;
}

function float(text, side, color, size) {
  const x = side === 0 ? innerWidth * 0.68 : innerWidth * 0.30;
  const y = side === 0 ? innerHeight * 0.50 : innerHeight * 0.24;
  S.floats.push({ text, x, y, color, size, life: 1.1, max: 1.1 });
}

function playEvents(events) {
  for (const e of events) {
    if (e.type === 'hit') {
      const gold = e.mult > 1, weak = e.mult < 1;
      float(String(e.amount), 1 - e.side, gold ? '#FFC93C' : weak ? '#8b93a8' : '#E9E5DA', gold ? 40 : weak ? 20 : 26);
      S.shakes = gold ? 0.55 : 0.3;
    } else if (e.type === 'miss') float('miss', 1 - e.side, '#667187', 18);
    else if (e.type === 'heal') float('+' + e.amount, e.side, '#7FA83F', 22);
    else if (e.type === 'burn') float(String(e.amount), e.side, '#E8452C', 22);
    else if (e.type === 'shielded') float('blocked', e.side, '#4FA3E0', 20);
    else if (e.type === 'rune') toast(`${e.side === 0 ? 'You cast' : 'It casts'} ${e.family}. ${(RUNES.FAMILIES[e.family] || {}).text || ''}`);
    else if (e.type === 'flip') stageFlip(e.side, e.to);
    else if (e.type === 'flipLocked') toast('A founder is the same cat all the way through. Only a bred Alpha has a second form.');
    else if (e.type === 'flipNoCatnip') toast('You have no catnip. Catnip grows in the vivarium.');
    else if (e.type === 'timeout') toast('Neither of you could finish it. The healthier cat walks away.');
    else if (e.type === 'down') endFight(e.side !== 0);
  }
  paintFight();
}

// 400 ms freeze, the colour drains, the sprite is rewritten bottom to top, colour returns.
function stageFlip(side, to) {
  S.flipStage = { side, desat: 0, sweep: 0, flash: 0 };
  const t0 = performance.now();
  (function anim() {
    const p = (performance.now() - t0) / 1400;
    if (p >= 1) { S.flipStage = null; toast(`New body, new House: ${to.house}. Look at your damage numbers now.`); return; }
    const st = S.flipStage;
    st.desat = p < 0.28 ? p / 0.28 : (p < 0.72 ? 1 : Math.max(0, 1 - (p - 0.72) / 0.28));
    st.sweep = p > 0.30 && p < 0.78 ? (p - 0.30) / 0.48 : 0;
    st.flash = p > 0.72 && p < 0.80 ? 0.6 : 0;
    requestAnimationFrame(anim);
  })();
}

function playerMove(action) {
  const f = S.fight;
  if (!f || f.over || f.toAct !== 0) return;
  const before = f.log.length;
  combat.act(f, action);
  playEvents(f.log.slice(before));
  if (!f.over) scheduleBot(S.flipStage ? 1500 : 700);
}

// Tier 1, Feral: fires the rune the moment it charges, and only flips in a panic. The telegraph is
// not optional. Without a tell one turn ahead, the Flip is a coin flip rather than a read.
//
// One bot turn at a time. The telegraph pauses for a beat and reschedules itself, and the player's
// move schedules a turn too, so without this lock the two chains overlap: the tell fires, a second
// call takes the turn with a Claw, and the Flip the player was just warned about never arrives.
// The bug looked like the bot ignoring its own tell, which is the worst thing this design can do.
let botPending = false;
function scheduleBot(ms) {
  if (botPending) return;
  botPending = true;
  setTimeout(() => { botPending = false; botTurn(); }, ms);
}

function botTurn() {
  const f = S.fight;
  if (!f || f.over || f.toAct !== 1) return;
  const b = S.them;
  const ready = b.runeCharge >= combat.runeCost(f, 1);
  const wantFlip = b.canFlip && !b.hasFlipped && b.catnip > 0 && b.hp / b.maxHp < 0.32;

  if (wantFlip && !f.telegraphed) {
    f.telegraphed = true;
    toast('Its ears flatten. It is reaching for catnip.');
    return scheduleBot(1200);
  }
  const move = wantFlip ? 'FLIP' : (ready ? 'RUNE' : 'CLAW');
  const before = f.log.length;
  combat.act(f, move);
  playEvents(f.log.slice(before));
  if (!f.over && f.toAct === 1) scheduleBot(700);
  if (!f.over && !playerMove.taught && S.me.runeCharge >= combat.runeCost(f, 0)) {
    playerMove.taught = true;
    hint('fight-hint', 'Your rune is full. It fills one quarter per turn, and a matching collar fills it twice as fast.');
  }
}

$('b-claw').onclick = () => playerMove('CLAW');
$('b-rune').onclick = () => {
  if (S.me.runeCharge < combat.runeCost(S.fight, 0)) return toast('Not charged yet.');
  playerMove('RUNE');
};
$('b-flip').onclick = () => {
  if (!S.me.canFlip) return toast('Your founder is homozygous: it shows everything it carries. Only a bred Alpha has a second form to flip to.');
  playerMove('FLIP');
};

// --- spoils -----------------------------------------------------------------------------------

function endFight(won) {
  startFight.taught = true;
  setTimeout(() => {
    $('spoils-title').textContent = won ? 'It yields' : 'It drives you off';
    const list = $('spoils-list'); list.innerHTML = '';
    const strand = won ? HUNT.takeStrand(S.hunt, S.them, 'Face', 'slice') : null;
    const rows = won
      ? [`<b>4</b> water`, `<b>1</b> strand of Face: <b>${strand.name}</b>`, `the wild kept its second form`]
      : [`you keep what you carried`, `a wound would go here, later`];
    for (const r of rows) { const li = document.createElement('li'); li.innerHTML = r; list.appendChild(li); }
    if (won) S.hunt.bag.water = Math.min(S.hunt.waterCap, S.hunt.bag.water + 4);
    show('spoils');
    if (won) setTimeout(flyStrand, 500);
  }, 900);
}

// The strand flies at the empty Second Form frame, does not fit, and drops. Nobody explains it.
function flyStrand() {
  const el = $('strand-fly');
  el.hidden = false; el.textContent = '⌁';
  el.style.transition = 'none';
  el.style.left = (innerWidth / 2 - 17) + 'px';
  el.style.top = (innerHeight * 0.55) + 'px';
  el.style.transform = 'translate(0,0)';
  requestAnimationFrame(() => {
    el.style.transition = '';
    el.style.transform = `translate(${innerWidth * 0.32}px, ${-innerHeight * 0.12}px)`;
    setTimeout(() => {
      el.style.transform = `translate(${innerWidth * 0.32}px, ${innerHeight * 0.22}px)`;
      el.style.opacity = '0';
      toast('It does not fit. You have nowhere to put someone else’s allele until you have a second cat.');
    }, 1000);
  });
}

$('go-viv').onclick = () => enterVivarium();

// --- vivarium ---------------------------------------------------------------------------------

function enterVivarium() {
  if (!S.viv) S.viv = VIV.createVivarium('slice', { now: 0 });
  S.vivClock = S.vivClock || 0;
  show('viv');
  paintViv();
  hint('viv-hint', `You carried home ${S.hunt.bag.seeds} seeds and ${S.hunt.bag.water} water. Plant first.`);
  for (let i = 0; i < S.hunt.bag.nubbins; i++) VIV.addNubbin(S.viv, S.vivClock);
  for (let i = 0; i < S.hunt.bag.glims; i++) VIV.addGlim(S.viv, S.vivClock);
  S.hunt.bag.nubbins = 0; S.hunt.bag.glims = 0;
  paintViv();
}

// The first plant is accelerated so the loop can close inside the first session. Every one after it
// runs at the real twenty minutes: this is a teaching cheat, used exactly once.
let firstPlant = true;

$('b-plant').onclick = () => {
  if (S.hunt.bag.seeds <= 0) return toast('No seeds. They are out there.');
  const p = VIV.plant(S.viv, 'Clover', S.vivClock);
  if (!p) return toast('No free tile.');
  if (firstPlant) { p.maturesAt = S.vivClock + 2; firstPlant = false; }
  S.hunt.bag.seeds -= 1;
  paintViv();
  hint('viv-hint', 'It needs damp soil to root, and the basin needs to overflow before anything moves.');
};

$('b-pour').onclick = () => {
  if (S.hunt.bag.water <= 0) return toast('Your flask is empty. That is what hunting is for.');
  const units = Math.min(40, S.hunt.bag.water);
  S.hunt.bag.water -= units;
  const before = S.viv.droppings;
  const events = VIV.pour(S.viv, units, S.vivClock);
  if (events.some((e) => e.type === 'irrigation')) {
    S.wave = 0;
    if (before > 0) hint('viv-hint', 'There it is. The droppings were doing nothing on the substrate. The water just turned them into nitrogen.');
    else hint('viv-hint', 'Irrigated. Nothing to carry yet: your nubbins have not eaten.');
  } else {
    hint('viv-hint', 'The soil is damp, but the basin has not overflowed. Nothing has been carried anywhere.');
  }
  pushLog(events);
  paintViv();
};

$('go-hunt2').onclick = () => {
  S.hunt = HUNT.generateHunt('run-' + Date.now(), { party: 1 });
  drawMap(); show('hunt');
  hint('hunt-hint', 'Water evaporates at 48 units a day. This is the rhythm now.');
};

const WORDS = {
  matured: (e) => [`${e.species} on a tile reached maturity.`, 'warm'],
  greens: () => ['A plant put out greens.', ''],
  ate: (e) => [e.what === 'greens' ? 'A nubbin ate.' : 'A glim took an algae mote.', ''],
  dropping: () => ['A nubbin left a dropping on the substrate.', ''],
  irrigation: () => ['Irrigation. The basin crossed the lip.', 'warm'],
  nitrate: (e) => [`${e.from} droppings washed into the basin as ${e.amount} nitrate.`, 'warm'],
  seep: (e) => [`${e.amount} nitrate seeped through the damp substrate.`, ''],
  algae: (e) => [`Nitrate spike: ${e.amount} algae bloomed.`, 'warm'],
  born: (e) => [`A ${e.species} was born.`, ''],
  starved: (e) => [`A ${e.species} starved.`, 'bad'],
  asphyxiated: () => ['A glim asphyxiated.', 'bad'],
  wilted: (e) => [`${e.species} dried out.`, 'bad'],
  torpor: () => ['The last nubbins went torpid rather than die.', 'bad'],
  flood: () => ['Flood. Too much water, too fast.', 'bad'],
  poured: (e) => [`Poured ${e.units} units.`, ''],
};

function pushLog(events) {
  const el = $('log');
  for (const e of events) {
    const w = WORDS[e.type]; if (!w) continue;
    const [text, cls] = w(e);
    const row = document.createElement('div');
    const mm = String(Math.floor(e.tick / 60)).padStart(2, '0'), ss = String(e.tick % 60).padStart(2, '0');
    row.innerHTML = `<time>${mm}:${ss}</time><span class="${cls}">${text}</span>`;
    el.appendChild(row);
  }
  el.scrollTop = el.scrollHeight;
}

function paintViv() {
  const v = S.viv;
  $('viv-water').textContent = `Flask ${S.hunt.bag.water} · basin ${v.basin.water}`;
  const s = VIV.snapshot(v);
  $('viv-life').textContent = `${s.mature}/${v.plants.length} plants · ${s.nubbins} nubbins · ${s.glims} glims · ${s.algae} algae`;
  $('b-plant').disabled = S.hunt.bag.seeds <= 0;
  $('b-pour').disabled = S.hunt.bag.water <= 0;
}

// The vivarium runs while you watch it, at one simulated minute per second, using the same resolver
// that catches up a five day absence. The live view illustrates ticks; it never computes them
// differently, which is the only reason the two can never disagree.
setInterval(() => {
  if (S.screen !== 'viv' || !S.viv) return;
  S.vivClock += 1;
  pushLog(VIV.resolve(S.viv, S.vivClock));
  paintViv();
}, 1000);
