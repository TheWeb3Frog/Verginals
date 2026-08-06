// Adventure Mode UI. An ES module loaded only when /api/info reports adventure:true, so nothing
// here costs anything on a server with the feature off.
//
// Screens implemented, in the order the art direction settled on (pass 04):
//   4a  daily home    — the clock, three things to do today, then your living line
//   1d  pairing       — relatedness and viability BEFORE the commit button
//   5   nursery       — the three attentions, and what they steer
//
// Two rules carried over from the design review, because they are easy to lose in code:
//
//   GOLD MEANS YOU CAN DO SOMETHING ABOUT IT. The season clock never wears it: a countdown is the
//   one escalation a player cannot act on, so it runs on its own ramp (CLOCK_RAMP in the kit).
//
//   THE PIP BAR IS THE ANCHOR. Zygosity reads from the notch, not the colour, so it survives
//   greyscale and red-green deficiency. Never draw a pip without its notch.

import {
  PALETTE, TRAIT_LAYERS, LAYER_RECTS, spriteUrl, seasonChip, SEASON_DAYS,
} from './verginals-kit.js';

const P = PALETTE;
const LOCI = ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House'];

// One hue per trait slot. The kit's pipBar() takes allele COLOURS, but the server deliberately
// sends zygosity rather than the allele pair — a player's hidden carriers are exactly what an
// opponent would want to read. So the colour identifies the slot and the notch carries the
// genetics, which is the channel pass 3a proved load-bearing anyway.
const SLOT_HUE = {
  Background: P.water, Body: P.ember, Collar: P.veil,
  Face: P.prismA, Rune: P.moss, House: P.fire,
};

const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const api = async (path, opts) => {
  const r = await fetch(`/api/adventure${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts && opts.headers) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body;
};

// --- the pip bar ------------------------------------------------------------------------------

/**
 * Six slots, each a solid pip when homozygous and a notched one when heterozygous.
 *
 * The notch floors at 2px so it never vanishes in a list row — the detail the designer added in
 * pass 3a and the reason the bar still works at 6px.
 */
function pips(zygosity, cell = 14) {
  const wrap = el('div', 'display:flex;gap:2px');
  const notch = Math.max(2, Math.round(cell / 3));
  for (const locus of LOCI) {
    const het = zygosity[locus] === 'het';
    const col = el('div', 'display:flex;flex-direction:column;gap:2px');
    const top = el('div', `width:${cell}px;height:${cell}px;background:${SLOT_HUE[locus]};box-shadow:0 0 0 1px ${P.ink}`);
    if (het) top.style.clipPath = `polygon(0 0, calc(100% - ${notch}px) 0, 100% ${notch}px, 100% 100%, 0 100%)`;
    const bot = el('div', `width:${cell}px;height:${cell}px;background:${SLOT_HUE[locus]};box-shadow:0 0 0 1px ${P.ink}`
      + (het ? ';opacity:0.55' : ''));
    col.append(top, bot);
    col.title = `${locus}: ${het ? 'heterozygous — carries something hidden' : 'homozygous'}`;
    wrap.append(col);
  }
  return wrap;
}

// --- the creature -----------------------------------------------------------------------------

/**
 * Composite a creature from its trait layers.
 *
 * Layer order comes from the kit (Body -> Ears -> Collar -> Face -> Rune) and must not be
 * hand-written here: the collar's pendant plate is opaque, and two faces in 44 hang past it. Get
 * the order wrong and Rainbow renders as a truncated sprite.
 */
function creature(traits, px = 128) {
  const { w, h } = LAYER_RECTS.Body;
  const box = el('div', `position:relative;width:${px}px;height:${Math.round(px * h / w)}px;image-rendering:pixelated;flex:none`);
  for (const layer of TRAIT_LAYERS) {
    const value = traits[layer];
    if (!value) continue;
    const rect = LAYER_RECTS[layer] || LAYER_RECTS.Body;
    const img = el('img');
    img.src = spriteUrl(layer, value, '/sprites');
    img.alt = '';
    img.style.cssText = 'position:absolute;image-rendering:pixelated;'
      + `left:${(rect.x / w) * 100}%;top:${(rect.y / h) * 100}%;`
      + `width:${(rect.w / w) * 100}%;height:${(rect.h / h) * 100}%`;
    box.append(img);
  }
  return box;
}

// --- screens ----------------------------------------------------------------------------------

export class Adventure {
  constructor(root) {
    this.root = root;
    this.state = null;
  }

  async refresh() {
    this.state = await api('/stable');
    this.render();
  }

  render() {
    const s = this.state;
    this.root.textContent = '';
    this.root.append(this.clock(s.season), this.today(s), this.line(s));
  }

  /**
   * The season chip. Thirty cells, filled left to right, escalating on density first — it never
   * touches action gold, because the one thing a player cannot act on should not wear the colour
   * that means "act". Never animate it; it just fills.
   */
  clock(season) {
    const bar = el('div', 'display:flex;align-items:center;gap:12px;margin-bottom:24px');
    bar.append(el('div', `font:12px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.fog}`,
      `DAY ${season.day}/${season.days}`));
    bar.append(seasonChip(season.day, season.days));
    return bar;
  }

  /** Three things to do today, then nothing. A player must be able to clear the day and close it. */
  today(s) {
    const wrap = el('div', 'margin-bottom:28px');
    wrap.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:10px`, 'TODAY'));

    const juveniles = s.living.filter((c) => c.born && !c.adult);
    const attentions = juveniles.reduce((n, c) => n + c.attentionsLeft, 0);
    const tasks = [
      { label: 'BREED', detail: s.slots.full ? `Stable full — ${s.slots.used}/${s.slots.cap}` : `${s.slots.free} free slots`, on: !s.slots.full, go: () => this.pickParents() },
      { label: 'NURSERY', detail: attentions ? `${attentions} attentions left` : 'Nothing to raise today', on: attentions > 0, go: () => this.render() },
      { label: 'FIGHT THE BOT', detail: 'Unlimited — three count toward growth', on: true, go: null },
    ];
    for (const t of tasks) {
      const card = el('div', `display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:6px;`
        + `background:${P.panel};border:1px solid ${t.on ? P.edge : P.slab};${t.on ? 'cursor:pointer' : 'opacity:0.5'}`);
      card.append(el('div', `flex:1;font:13px/1.4 ui-monospace,monospace;color:${P.bone}`, t.label));
      card.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.ash}`, t.detail));
      // Gold only where a tap does something.
      card.append(el('div', `font:14px/1 ui-monospace,monospace;color:${t.on ? P.gold : P.slab}`, '→'));
      if (t.on && t.go) card.onclick = t.go;
      wrap.append(card);
    }
    return wrap;
  }

  /** Your living line: one row per creature, the pip bar first because it is the anchor. */
  line(s) {
    const wrap = el('div');
    wrap.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:10px`,
      `YOUR LINE · ${s.living.length} LIVING · ${s.slots.used}/${s.slots.cap} SLOTS`));
    if (!s.living.length) {
      wrap.append(el('div', `padding:20px;background:${P.panel};color:${P.ash};font:12px/1.6 ui-monospace,monospace`,
        'Nothing alive yet. Breed two Alphas to start a line — they must have rested two days first.'));
      return wrap;
    }
    for (const c of s.living) wrap.append(this.row(c));
    return wrap;
  }

  row(c) {
    const card = el('div', `display:flex;gap:14px;align-items:center;padding:12px;margin-bottom:8px;`
      + `background:${P.panel};border:1px solid ${P.slab}`);
    card.append(creature(c.traits, 72));

    const mid = el('div', 'flex:1;display:flex;flex-direction:column;gap:8px');
    mid.append(pips(c.zygosity, 14));
    const stateText = !c.born
      ? `Gestating — born in ${Math.max(0, Math.ceil((c.bornAt - Date.now() / 1000) / 3600))}h`
      : c.adult ? `Adult · generation ${c.generation}` : `Growing ${c.growth}/${c.growthToAdult}`;
    mid.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.fog}`,
      `${c.sex === 'F' ? '♀' : '♂'} ${stateText}${c.mutations && c.mutations.length ? ' · MUTATION' : ''}`));
    if (c.temperament && c.temperament.label !== 'Untouched') {
      mid.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.ash}`, c.temperament.label));
    }
    card.append(mid);

    if (c.born && !c.adult) card.append(this.attentions(c));
    else card.append(this.releaseButton(c));
    return card;
  }

  /**
   * The three attentions. Each matures the juvenile by the same amount and steers it somewhere
   * different — a "best" attention would collapse the choice, so they are drawn identically.
   */
  attentions(c) {
    const box = el('div', 'display:flex;flex-direction:column;gap:4px;align-items:flex-end');
    box.append(el('div', `font:10px/1 ui-monospace,monospace;letter-spacing:1px;color:${P.ash}`,
      `${c.attentionsLeft} OF 3 LEFT`));
    const row = el('div', 'display:flex;gap:4px');
    for (const kind of ['spar', 'drill', 'feed', 'play']) {
      const on = c.attentionsLeft > 0;
      const b = el('button', `padding:6px 8px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
        + `background:${P.slab};color:${on ? P.gold : P.ash};border:1px solid ${on ? P.edge : P.slab};`
        + `cursor:${on ? 'pointer' : 'default'}`, kind.toUpperCase());
      b.disabled = !on;
      b.onclick = async () => {
        b.disabled = true;
        try { await api(`/creature/${c.id}/attend`, { method: 'POST', body: JSON.stringify({ kind }) }); }
        catch (e) { this.toast(e.message); }
        await this.refresh();
      };
      row.append(b);
    }
    box.append(row);
    return box;
  }

  /** §6: choosing what not to keep. Never phrased as killing, because it is not. */
  releaseButton(c) {
    const b = el('button', `padding:8px 10px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
      + `background:transparent;color:${P.ash};border:1px solid ${P.slab};cursor:pointer`, 'RELEASE');
    b.title = 'Leaves your stable and frees a slot. It keeps its page and its place on the season roster.';
    b.onclick = async () => {
      b.disabled = true;
      try { await api(`/creature/${c.id}/release`, { method: 'POST' }); } catch (e) { this.toast(e.message); }
      await this.refresh();
    };
    return b;
  }

  // --- picking the parents ------------------------------------------------------------------------

  /**
   * Choose two Alphas. Only Alphas start a line — that is what makes them the permanent breeding
   * stock and the reason to own one (§1).
   *
   * The wall this screen has to explain: every descendant of ONE Alpha pair is a full sibling, so
   * a player with a single pair stops at generation 1 unless they bring in unrelated blood. That is
   * §3.4 working as designed, but a newcomer who hits it with no explanation reads a broken game
   * rather than an invitation (spec §7bis). So the count is stated up front, not discovered.
   */
  async pickParents() {
    let data;
    try { data = await api('/alphas'); } catch (e) { return this.toast(e.message); }

    const panel = el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`);
    panel.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:12px`,
      'PICK A MOTHER AND A FATHER'));

    if (!data.alphas.length) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.fog}`,
        'You hold no Alpha Verginals. Only an Alpha can start a line.'));
      this.root.prepend(panel);
      return undefined;
    }
    if (!data.females || !data.males) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.ember}`,
        `Breeding needs one of each. You hold ${data.females} female and ${data.males} male `
        + '— pink ears are female, grey are male.'));
    } else if (data.females + data.males < 4) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.fog};margin-bottom:12px`,
        'Every descendant of one pair is a full sibling, so this line will stall at the first '
        + 'generation. Going deeper needs unrelated blood — a second pair, or another player\'s Alpha.'));
    }

    const sel = { mother: null, father: null };
    const grid = el('div', 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px');
    const go = el('button', `padding:10px 14px;font:12px/1 ui-monospace,monospace;letter-spacing:1px;border:none`,
      'CONTINUE');

    const paint = () => {
      // Gold marks the chosen pair, because selecting is the action on this screen.
      for (const card of grid.children) {
        const chosen = card._alpha === sel.mother || card._alpha === sel.father;
        card.style.cssText = card._base + `;border:1px solid ${chosen ? P.gold : P.slab}`
          + (card._alpha.fertile ? ';cursor:pointer' : ';opacity:0.45');
      }
      const ready = sel.mother && sel.father;
      go.style.cssText = `padding:10px 14px;font:12px/1 ui-monospace,monospace;letter-spacing:1px;border:none;`
        + `background:${ready ? P.gold : P.slab};color:${ready ? P.ink : P.ash};`
        + `cursor:${ready ? 'pointer' : 'default'}`;
      go.disabled = !ready;
    };

    for (const a of data.alphas) {
      const card = el('div');
      card._alpha = a;
      card._base = 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px;width:96px;'
        + `background:${P.coal}`;
      card.append(creature(a.traits, 72));
      card.append(el('div', `font:10px/1 ui-monospace,monospace;color:${P.bone}`,
        `${a.sex === 'F' ? '♀' : '♂'} #${a.number}`));
      card.append(el('div', `font:9px/1.3 ui-monospace,monospace;color:${a.fertile ? P.moss : P.ash};text-align:center`,
        a.label));
      if (a.fertile) {
        card.onclick = () => {
          const slot = a.sex === 'F' ? 'mother' : 'father';
          sel[slot] = sel[slot] === a ? null : a;
          paint();
        };
      }
      grid.append(card);
    }

    go.onclick = () => {
      panel.remove();
      this.openPairing({ carrierKey: sel.mother.carrierKey }, { carrierKey: sel.father.carrierKey });
    };
    panel.append(grid, go);
    if (data.truncated) {
      panel.append(el('div', `margin-top:8px;font:10px/1.4 ui-monospace,monospace;color:${P.ash}`,
        'Showing your first 60 Alphas.'));
    }
    paint();
    this.root.prepend(panel);
    return undefined;
  }

  // --- pairing ----------------------------------------------------------------------------------

  /**
   * The pairing screen. Its whole job is §3.4: put the relation and one percentage in front of the
   * player BEFORE the confirm button, so an abstract coefficient becomes a decision they can weigh.
   */
  async openPairing(motherRef, fatherRef) {
    if (!motherRef || !fatherRef) return this.toast('Pick two parents from your Alphas first.');
    let pv;
    try { pv = await api('/preview', { method: 'POST', body: JSON.stringify({ mother: motherRef, father: fatherRef }) }); }
    catch (e) { return this.toast(e.message); }

    const panel = el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`);
    panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.bone}`, `${pv.relation}.`));
    if (pv.warning) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.ember};margin-top:4px`, pv.warning));
    }
    for (const side of ['mother', 'father']) {
      const f = pv[side] && pv[side].fertility;
      if (f) panel.append(el('div', `font:11px/1.6 ui-monospace,monospace;color:${f.fertile ? P.moss : P.ash}`,
        `${side}: ${f.label}`));
    }

    if (pv.ok) {
      const go = el('button', `margin-top:12px;padding:10px 14px;font:12px/1 ui-monospace,monospace;letter-spacing:1px;`
        + `background:${P.gold};color:${P.ink};border:none;cursor:pointer`, 'BREED');
      go.onclick = () => this.commit(motherRef, fatherRef, panel);
      panel.append(go);
    } else {
      panel.append(el('div', `margin-top:8px;font:11px/1.6 ui-monospace,monospace;color:${P.ash}`,
        (pv.blockers || []).map(describeBlocker).join(' · ')));
    }
    this.root.prepend(panel);
    return undefined;
  }

  /**
   * Commit, then reveal. The hash is shown before the outcome exists and the seed after, so a
   * player who cares can rerun genetics.breed() and confirm the animal they were given is the
   * animal the seed produced.
   */
  async commit(motherRef, fatherRef, panel) {
    panel.textContent = '';
    let open;
    try { open = await api('/pair', { method: 'POST', body: JSON.stringify({ mother: motherRef, father: fatherRef }) }); }
    catch (e) { return this.toast(e.message); }
    panel.append(el('div', `font:11px/1.6 ui-monospace,monospace;color:${P.ash};word-break:break-all`,
      `committed ${open.serverSeedHash}`));

    let r;
    try { r = await api(`/pair/${open.pairingId}/resolve`, { method: 'POST' }); }
    catch (e) { return this.toast(e.message); }

    if (!r.conceived) {
      // Said plainly. The pairing not taking IS the cost of inbreeding, and softening it would hide
      // the only signal that tells a player their line has closed up.
      panel.append(el('div', `margin-top:8px;font:12px/1.6 ui-monospace,monospace;color:${P.ember}`,
        `The pairing did not take. Viability was ${Math.round(r.viability * 100)}%.`));
      return undefined;
    }
    panel.append(el('div', `margin-top:8px;font:12px/1.6 ui-monospace,monospace;color:${P.moss}`,
      `Expecting. Born in two days — generation ${r.generation}.`));
    if (r.mutations && r.mutations.length) {
      for (const m of r.mutations) {
        panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.prismB}`,
          `MUTATION · ${m.locus} became ${m.value}, from neither parent.`));
      }
    }
    panel.append(el('div', `margin-top:6px;font:10px/1.6 ui-monospace,monospace;color:${P.ash};word-break:break-all`,
      `seed ${r.seed}`));
    await this.refresh();
    return undefined;
  }

  toast(message) {
    const t = el('div', `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:50;`
      + `padding:10px 14px;background:${P.slab};color:${P.bone};border:1px solid ${P.edge};`
      + 'font:12px/1.4 ui-monospace,monospace', message);
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }
}

function describeBlocker(b) {
  if (b.kind === 'resting') return `the ${b.side} is resting`;
  if (b.kind === 'slots') return `no free slot (${b.used}/${b.cap})`;
  if (b.kind === 'sex') return 'a pairing needs one female and one male';
  return b.kind;
}

/** Mount only when the server says the feature is on. */
export async function mount(root) {
  const info = await fetch('/api/info').then((r) => r.json()).catch(() => ({}));
  if (!info.adventure) return null;
  const a = new Adventure(root);
  await a.refresh();
  return a;
}

export { pips, creature, SEASON_DAYS };
