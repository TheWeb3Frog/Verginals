// Adventure Mode UI. An ES module loaded only when /api/info reports adventure:true, so nothing
// here costs anything on a server with the feature off.
//
// Screens implemented, in the order the art direction settled on (pass 04):
//   4a  daily home:     the clock, three things to do today, then your living line
//   1d  pairing:        relatedness and viability BEFORE the commit button
//   5   nursery:        the three attentions, and what they steer
//
// Two rules carried over from the design review, because they are easy to lose in code:
//
//   GOLD MEANS YOU CAN DO SOMETHING ABOUT IT. The season clock never wears it: a countdown is the
//   one escalation a player cannot act on, so it runs on its own ramp (CLOCK_RAMP in the kit).
//
//   THE PIP BAR IS THE ANCHOR. Zygosity reads from the notch, not the colour, so it survives
//   greyscale and red-green deficiency. Never draw a pip without its notch.

import {
  PALETTE, TRAIT_LAYERS, LAYER_RECTS, spriteUrl, seasonChip, SEASON_DAYS, pipBar,
} from './verginals-kit.js';
import {
  sprite, elementBadge, moveIcon, attentionIcon, egg, playEffect, effectFor, arena, alleleColor,
  creatureSprite,
} from './adventure-art.js';
import { habitat } from './adventure-habitat.js';

const P = PALETTE;
const LOCI = ['Background', 'Body', 'Collar', 'Face', 'Rune', 'House'];

// The fallback hue per slot, used only when a payload arrives without its allele pair. Real
// colours come from the alleles themselves now, which is what makes a bloodline scannable: the
// same hidden trait is the same colour in every row it appears in.
const SLOT_HUE = {
  Background: P.water, Body: P.ember, Collar: P.veil,
  Face: P.prismA, Rune: P.moss, House: P.fire,
};

// Ids are `d_12_lx9f`. The middle number is the only part a player ever needs to tell two of their
// own creatures apart, and the tail is noise on a 150px rail.
const shortId = (id) => {
  const raw = String(id || '');
  if (raw.startsWith('alpha:')) return `Alpha #${raw.slice(6)}`;
  const parts = raw.split('_');
  return parts.length > 1 ? `#${parts[1]}` : raw;
};

const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
// The session token from the Arena sign-in. Every adventure route is gated on it, so without this
// the whole module 401s on its first call.
let TOKEN = null;
export function setToken(t) { TOKEN = t; }

const api = async (path, opts) => {
  const headers = { 'content-type': 'application/json', ...(opts && opts.headers) };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`/api/adventure${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body;
};

// --- the pip bar ------------------------------------------------------------------------------

/**
 * The kit's own pipBar, called with real allele colours.
 *
 * This used to be a local reimplementation, drawing one fixed hue per slot because the server only
 * sent hom/het. That threw away what the bar is for: the design has the top row carrying what is
 * expressed and the bottom row what is carried, so a whole bloodline can be scanned for a hidden
 * trait without opening a card. The roster now sends the pair, expressed first, and the drawing is
 * the designer's again.
 *
 * The notch on a heterozygous top pip is the shape channel and survives greyscale and red-green
 * deficiency. It lives inside the kit. Never draw a pip without it.
 */
function pips(c, cell = 14) {
  if (!c.alleles) {
    // A roster from a server that predates the allele payload. Fall back to the slot hue rather
    // than drawing nothing: the shape channel still carries the zygosity.
    const pairs = LOCI.map((l) => {
      const hue = SLOT_HUE[l];
      return c.zygosity && c.zygosity[l] === 'het' ? [hue, P.slab] : [hue, hue];
    });
    return pipBar(pairs, cell);
  }
  const bar = pipBar(LOCI.map((l) => (c.alleles[l] || []).map(alleleColor)), cell);

  // The kit infers heterozygosity by comparing the two COLOURS, which is right when every allele
  // has its own. Ours are hashed into a sixteen-colour palette and Face alone has 44 values, so two
  // different alleles land on the same colour often enough to matter. Left alone the bar would draw
  // "breeds true" over a creature carrying something hidden, which is the one thing it must never
  // do. So the shape channel is reconciled against the allele names, which are the truth.
  const notch = Math.max(2, Math.round(cell / 3));
  [...bar.children].forEach((col, i) => {
    const l = LOCI[i];
    const pair = c.alleles[l] || [];
    const het = pair.length === 2 && pair[0] !== pair[1];
    const [top, bottom] = col.children;
    const drawnHet = top.children.length > 0;
    if (het && !drawnHet) {
      const n = document.createElement('div');
      n.style.cssText = `position:absolute;right:0;top:0;width:${notch}px;height:${notch}px;background:${P.ink}`;
      top.append(n);
    } else if (!het && drawnHet) {
      top.children.length = 0;
    }
    bottom.style.cssText = bottom.style.cssText.replace(/;opacity:0\.55/, '') + (het ? ';opacity:0.55' : '');
    col.title = het
      ? `${l}: shows ${pair[0]}, carries ${pair[1]}`
      : `${l}: ${pair[0]} (homozygous, breeds true)`;
  });
  return bar;
}

// The cycle, as one fact rather than three: Fire burns Earth, Earth buries Water, Water douses Fire.
// Read backwards it answers "what just beat me", which is how a losing round names its attacker
// without the server revealing a move it is still keeping blind.
const BEATS = { fire: 'earth', earth: 'water', water: 'fire' };
const beatenBy = (element) => Object.keys(BEATS).find((k) => BEATS[k] === element) || 'fire';

/** Which arena a creature fights in. Its House is scenery here, never a rule (§4.2). */
function houseElement(c) {
  const house = String((c.traits && c.traits.House) || '').toLowerCase();
  if (house.includes('fire')) return 'fire';
  if (house.includes('water')) return 'water';
  if (house.includes('earth')) return 'earth';
  // Anything else (a Prism, a House the collection spells differently) gets stone.
  return 'fire';
}

// --- the creature -----------------------------------------------------------------------------

/** The compositor lives in the art module, so the habitat and this screen cannot drift apart. */
const creature = (traits, px = 128) => creatureSprite(traits, px);

// --- screens ----------------------------------------------------------------------------------

export class Adventure {
  constructor(root) {
    this.root = root;
    this.state = null;
    // Two containers, and the split matters. `notices` holds whatever the player has just done
    // (a hatch, a mutation, a fight result) and is NEVER cleared by a re-render. `body` is the
    // roster and is rebuilt from scratch every time.
    //
    // Without this, every action erased its own outcome: breed() appended "MUTATION · Face became
    // Rainbow" and then called refresh(), which wiped the root a frame later. The rarest event in
    // the game was invisible.
    this.notices = el('div');
    this.body = el('div');
    root.append(this.notices, this.body);
    // Which creature the player is standing in front of, or null for the roster. The habitat runs an
    // animation loop, so `hab` is held to be torn down: a re-render that only dropped the element
    // would leave the loop running against a node nobody can see.
    this.viewing = null;
    this.hab = null;
    this.caption = 0;
  }

  /** Everything that must stop when the screen it belongs to goes away. */
  closeHabitat() {
    if (this.caption) { clearInterval(this.caption); this.caption = 0; }
    if (this.hab) { this.hab.destroy(); this.hab = null; }
    // Dropped too, or an act still in flight writes its result into a panel that is no longer on
    // the page.
    this.showFacts = null;
  }

  async refresh() {
    this.state = await api('/stable');
    this.render();
  }

  render() {
    const s = this.state;
    this.closeHabitat();
    this.body.textContent = '';
    if (this.viewing) {
      const c = (s.living || []).find((x) => x.id === this.viewing);
      // A creature can leave the roster between renders, by being released or by the season ending.
      // Falling back to the roster is the only honest thing to do with a screen about something
      // that is no longer there.
      if (c && c.born) { this.body.append(this.habitatScreen(c)); return; }
      this.viewing = null;
    }
    this.body.append(this.clock(s.season), this.today(s), this.line(s), this.nav());
  }

  /** Put a panel where a refresh cannot destroy it. Replaces the previous one. */
  notice(panel) {
    // A meeting habitat lives in here, and this container is deliberately never cleared by a
    // re-render, so its animation loop would outlive the panel it belongs to.
    if (this.meeting) { this.meeting.destroy(); this.meeting = null; }
    this.notices.textContent = '';
    this.notices.append(panel);
    return panel;
  }

  /**
   * The season chip. Thirty cells, filled left to right, escalating on density first. It never
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
    // Anything born can fight, adult or not. Bot mode is where you learn a creature (§4.4).
    const fightable = s.living.filter((c) => c.born);
    const tasks = [];
    // The Orb goes first when it exists: it is the only thing on this screen that expires with the
    // season, and it is the one decision a player must not miss.
    if (s.orbs) {
      tasks.push({
        label: 'SPEND THE DNA ORB', detail: `${s.orbs} held`, on: true, icon: ['orb', 'orbP'],
        go: () => this.orbPanel(),
      });
    }
    tasks.push(
      {
        label: 'BREED',
        detail: s.slots.full
          ? `Stable full (${s.slots.used}/${s.slots.cap})`
          : (s.freeBreedsLeft ? `${s.freeBreedsLeft} instant pairings left` : `${s.slots.free} free slots`),
        on: !s.slots.full,
        go: () => this.pickParents(),
      },
      { label: 'NURSERY', detail: attentions ? `${attentions} attentions left` : 'Nothing to raise today', on: attentions > 0, go: () => this.render() },
      {
        label: 'FIGHT THE BOT',
        detail: fightable.length ? 'Unlimited, three a day count toward growth' : 'Nothing born yet',
        on: fightable.length > 0,
        go: () => this.fightPanel(fightable[0]),
      },
    );
    for (const t of tasks) {
      const card = el('div', `display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:6px;`
        + `background:${P.panel};border:1px solid ${t.on ? P.edge : P.slab};${t.on ? 'cursor:pointer' : 'opacity:0.5'}`);
      if (t.icon) {
        const icon = sprite(t.icon[0], t.icon[1], 2);
        if (icon) card.append(icon);
      }
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
      // The empty stable gets the kit's own empty state rather than a paragraph on its own. An
      // empty screen is the first thing a new player sees, and it should still look drawn.
      const box = el('div', `display:flex;gap:16px;align-items:center;padding:20px;background:${P.panel}`);
      const mark = sprite('emptyBox', 'emptyP', 3);
      if (mark) box.append(mark);
      box.append(el('div', `color:${P.ash};font:12px/1.6 ui-monospace,monospace`,
        s.freeBreedsLeft
          ? `Nothing alive yet. Breed two Alphas to start a line. Your first ${s.freeBreedsLeft} pairings are `
            + 'born straight away, with no rest and no gestation.'
          : 'Nothing alive yet. Breed two Alphas to start a line. They must have rested two days first.'));
      wrap.append(box);
      return wrap;
    }
    for (const c of s.living) wrap.append(this.row(c));
    return wrap;
  }

  /**
   * The two screens that are about the season rather than the day. Below the line, because they
   * are what you read once the day is cleared, not what you came to do.
   */
  nav() {
    const row = el('div', 'display:flex;gap:8px;margin-top:20px;flex-wrap:wrap');
    const link = (label, go) => {
      const b = el('button', `padding:9px 12px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
        + `background:transparent;color:${P.fog};border:1px solid ${P.slab};cursor:pointer`, label);
      b.onclick = go;
      return b;
    };
    row.append(link('BLOODLINE', () => this.lineagePanel()));
    row.append(link('LADDERS', () => this.laddersPanel()));
    row.append(link('HALL OF FAME', () => this.hallPanel()));
    return row;
  }

  row(c) {
    const card = el('div', `display:flex;gap:14px;align-items:center;padding:12px;margin-bottom:8px;`
      + `background:${P.panel};border:1px solid ${P.slab}`);

    // An unborn creature is an egg, and the egg is further along every time you come back. That is
    // the wait made visible: no countdown, just something that has changed since you last looked.
    if (!c.born) {
      const nest = el('div', 'width:72px;height:78px;display:flex;align-items:center;justify-content:center;flex:none');
      const span = Math.max(1, c.bornAt - (c.conceivedAt || (c.bornAt - 2 * 86400)));
      const done = 1 - Math.max(0, Math.min(1, (c.bornAt - Date.now() / 1000) / span));
      const e = egg(done, 4);
      if (e) nest.append(e);
      card.append(nest);
    } else {
      // The portrait is the way in. Clicking an animal to go and see it is the gesture this screen
      // has always implied, and a row of buttons beside it never said.
      const portrait = el('button', 'background:none;border:0;padding:0;cursor:pointer;line-height:0;flex:none');
      portrait.title = 'Go and see it';
      portrait.setAttribute('aria-label', `Visit ${shortId(c.id)}`);
      portrait.append(creature(c.traits, 72));
      portrait.onclick = () => { this.viewing = c.id; this.render(); };
      card.append(portrait);
    }

    const mid = el('div', 'flex:1;display:flex;flex-direction:column;gap:8px');
    mid.append(pips(c, 14));
    const stateText = !c.born
      ? `Gestating, born in ${Math.max(0, Math.ceil((c.bornAt - Date.now() / 1000) / 3600))}h`
      : c.adult ? `Adult · generation ${c.generation}` : `Growing ${c.growth}/${c.growthToAdult}`;
    const stateLine = el('div', 'display:flex;align-items:center;gap:6px');
    // A juvenile carries the sprout, an adult its House badge. One glance tells you which of your
    // six is still growing without reading a single number.
    const mark = c.born && !c.adult ? sprite('sprout', 'sproutP', 2) : (c.born ? elementBadge(houseElement(c), 2) : null);
    if (mark) stateLine.append(mark);
    if (c.mutations && c.mutations.length) {
      const bang = sprite('bang', 'warnP', 2);
      if (bang) { bang.title = 'This one carries a mutation'; stateLine.append(bang); }
    }
    stateLine.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.fog}`,
      `${c.sex === 'F' ? '♀' : '♂'} ${stateText}${c.mutations && c.mutations.length ? ' · MUTATION' : ''}`));
    mid.append(stateLine);
    if (c.temperament && c.temperament.label !== 'Untouched') {
      mid.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.ash}`, c.temperament.label));
    }
    card.append(mid);

    const actions = el('div', 'display:flex;flex-direction:column;gap:6px;align-items:flex-end');
    // Freshly out of the egg and untouched: offer the reveal rather than dropping it into a list row.
    const unmet = c.born && c.growth <= 1 && c.temperament && c.temperament.label === 'Untouched';
    if (unmet) {
      const meet = el('button', `padding:8px 10px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
        + `background:${P.gold};color:${P.ink};border:none;cursor:pointer`, 'MEET IT');
      meet.onclick = () => this.hatch(c);
      actions.append(meet);
    }
    if (c.born) actions.append(this.fightButton(c));
    if (c.born && !c.adult) actions.append(this.attentions(c));
    else if (c.born) actions.append(this.releaseButton(c));
    card.append(actions);
    return card;
  }

  /**
   * The creature's own screen.
   *
   * Everything here already existed as a rule. §5.1 gives a juvenile three attentions a day across
   * four kinds, and says attention "makes it grow FASTER and decides WHAT IT BECOMES". On the roster
   * that was four buttons and a label. Here the four kinds are objects on the floor, the growth is
   * how big the animal is, and what it became is how it spends its time when nobody is clicking.
   */
  habitatScreen(c) {
    const wrap = el('div');

    const top = el('div', 'display:flex;align-items:center;gap:10px;margin-bottom:14px');
    const back = el('button', `padding:8px 10px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
      + `background:transparent;color:${P.fog};border:1px solid ${P.slab};cursor:pointer`, 'YOUR LINE');
    back.onclick = () => { this.viewing = null; this.render(); };
    top.append(back);
    const badge = elementBadge(houseElement(c), 2);
    if (badge) top.append(badge);
    top.append(el('div', `font:12px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.bone}`,
      `${c.sex === 'F' ? '♀' : '♂'} ${shortId(c.id)}`));
    wrap.append(top);

    const counts = (c.temperament && c.temperament.counts) || {};
    this.hab = habitat({
      traits: c.traits,
      element: houseElement(c),
      growth: c.growth,
      growthToAdult: c.growthToAdult,
      attentions: counts,
      height: 300,
      onAct: async (kind) => {
        try {
          const r = await api(`/creature/${c.id}/attend`, { method: 'POST', body: JSON.stringify({ kind }) });
          // attend() hands back the growth GAIN, not the total, and no breakdown. The totals come
          // from re-reading the stable, so the habitat is never shown a number the server did not
          // just confirm.
          this.state = await api('/stable');
          const fresh = (this.state.living || []).find((x) => x.id === c.id);
          if (fresh && this.showFacts) this.showFacts(fresh);
          if (r.ok === false) return { ok: false };
          return {
            ok: true,
            growth: fresh ? fresh.growth : undefined,
            attentions: fresh && fresh.temperament ? fresh.temperament.counts : undefined,
          };
        } catch (e) {
          this.toast(e.message);
          return { ok: false };
        }
      },
    });
    wrap.append(this.hab.el);

    // What it is doing, in words, under the scene. It reads as a caption rather than a status,
    // because nothing here is a warning: there is no neglect in this game and no bar to keep full.
    const doing = el('div', `margin-top:10px;font:11px/1.6 ui-monospace,monospace;color:${P.ash};min-height:18px`);
    const SAYS = {
      idle: 'is looking around', wander: 'is pacing', sniff: 'is nosing at something',
      nap: 'is dozing', ball: 'is chasing the ball', practise: 'is practising',
    };
    const say = () => { doing.textContent = `It ${SAYS[this.hab.behaviour] || 'is settling in'}.`; };
    say();
    this.caption = setInterval(say, 700);
    wrap.append(doing);

    const facts = el('div', `display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:12px;`
      + `padding:12px;background:${P.panel};border:1px solid ${P.slab}`);
    facts.append(pips(c, 14));
    const values = {};
    const stat = (key, label) => {
      const b = el('div', 'display:flex;flex-direction:column;gap:3px');
      b.append(el('div', `font:9px/1 ui-monospace,monospace;letter-spacing:1px;color:${P.ash}`, label));
      values[key] = el('div', `font:12px/1 ui-monospace,monospace;color:${P.bone}`);
      b.append(values[key]);
      facts.append(b);
    };
    stat('growth', 'GROWTH');
    stat('today', 'TODAY');
    stat('becoming', 'BECOMING');
    // Rewritten in place rather than by re-rendering: a re-render would tear down the habitat, and
    // the animal would blink out of existence in the middle of being fed.
    this.showFacts = (x) => {
      values.growth.textContent = x.adult ? 'grown' : `${x.growth} of ${x.growthToAdult}`;
      values.today.textContent = x.adult ? 'nothing left to raise' : `${x.attentionsLeft} of 3 attentions`;
      values.becoming.textContent = (x.temperament && x.temperament.label) || 'Untouched';
    };
    this.showFacts(c);
    wrap.append(facts);

    wrap.append(el('div', `margin-top:10px;font:11px/1.7 ui-monospace,monospace;color:${P.ash}`,
      c.adult
        ? 'Grown. It keeps the temperament you gave it, and the four things on the floor no longer '
          + 'change anything.'
        : 'Touch one of the four things on the floor. None of them is better than the others: they '
          + 'grow it at the same rate and steer it somewhere different.'));
    return wrap;
  }

  /**
   * Pick three elements and where the poison and the potion go, then fight the bot.
   *
   * NOTE: this is not yet §4.4's turn-by-turn bot. game.js resolves all three rounds from one
   * committed loadout, so a round-at-a-time fight is an engine change rather than a screen. What
   * this does give is the thing §4.4 is actually for: somewhere to learn a creature you have just
   * bred, before committing three moves blind in a tournament.
   */
  fightButton(c) {
    const b = el('button', `padding:8px 10px;font:10px/1 ui-monospace,monospace;letter-spacing:1px;`
      + `background:${P.slab};color:${P.gold};border:1px solid ${P.edge};cursor:pointer`,
      c.fightsCountedLeft > 0 ? `FIGHT · ${c.fightsCountedLeft} OF 3 COUNT` : 'FIGHT · PRACTICE');
    b.title = c.fightsCountedLeft > 0
      ? 'Unlimited fights. Three a day feed growth; the rest are practice.'
      : 'Today\'s three have counted. Fight as much as you like. This is practice now.';
    b.onclick = () => this.fightPanel(c);
    return b;
  }

  /**
   * A turn-by-turn bot fight (§4.4). One move at a time, each round resolved and read before the
   * next is chosen. That is the whole point: this is where you learn a creature you have just
   * bred, before committing three moves blind in a tournament.
   *
   * The bot's whole match was fixed by the committed seed when the duel opened, so it cannot pick
   * in reaction to you. The hash is shown from the start and the seed at the end, so a player who
   * cares can check that.
   */
  async fightPanel(c) {
    let duel;
    try { duel = await api(`/creature/${c.id}/duel`, { method: 'POST' }); }
    catch (e) { return this.toast(e.message); }

    const panel = this.notice(el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`));
    panel.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash}`,
      `FIGHT · ROUND 1 OF ${duel.rounds}`));
    panel.append(el('div', `font:11px/1.6 ui-monospace,monospace;color:${P.fog};margin-bottom:12px`,
      'Fire burns Earth · Earth buries Water · Water douses Fire'));

    // The arena. Which one you fight in follows the creature's own House, so a Fire line fights on
    // warm stone: the backdrop is the one place the element gets to be scenery rather than a rule.
    const ground = arena(houseElement(c), 160);
    const stage = el('div', 'position:absolute;left:0;right:0;bottom:14%;display:flex;'
      + 'align-items:flex-end;justify-content:space-around;padding:0 8%');
    const youBox = el('div', 'position:relative');
    youBox.append(creature(c.traits, 84));
    // The bot is a silhouette until the seed is revealed. Drawing it as a creature would be a lie:
    // the server has not told us what it looks like, and it must not, or the fight stops being blind.
    const botBox = el('div', 'position:relative');
    botBox.append(el('div', `width:84px;height:${Math.round(84 * 624 / 576)}px;background:${P.ink};`
      + `border:1px solid ${P.slab};opacity:0.85`));
    stage.append(youBox, botBox);
    ground.append(stage);
    panel.append(ground);

    const log = el('div', 'display:flex;flex-direction:column;gap:4px;margin:12px 0');
    const controls = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap');
    panel.append(log, controls);
    panel.append(el('div', `margin-top:10px;font:9px/1.4 ui-monospace,monospace;color:${P.ash};word-break:break-all`,
      `committed ${duel.serverSeedHash}`));

    const spent = { poison: false, potion: false };
    let pending = { poison: false, potion: false };
    // Poison is the one effect that loops, because it is the one thing that stays on the board.
    // It is cleared at the top of the next round.
    let stopPoison = null;

    const send = async (element) => {
      controls.textContent = '';
      const spentThisRound = { ...pending };
      let r;
      try {
        r = await api(`/duel/${duel.duelId}/round`, {
          method: 'POST',
          body: JSON.stringify({ element, poison: pending.poison, potion: pending.potion }),
        });
      } catch (e) { this.toast(e.message); return draw(); }
      if (pending.poison) spent.poison = true;
      if (pending.potion) spent.potion = true;
      pending = { poison: false, potion: false };

      const w = r.result.winner === 'p1';

      // The hit lands on whoever lost it, and it is the winning element that throws it. When the bot
      // wins on the elemental cycle we can name its element without being told: exactly one element
      // beats yours. Everything else stays hidden until the seed is revealed.
      if (stopPoison) { stopPoison(); stopPoison = null; }
      if (spentThisRound.potion) playEffect(youBox, 'potionDrunk', { scale: 3 });
      if (spentThisRound.poison) stopPoison = playEffect(botBox, 'poisonOn', { scale: 3 });
      const hit = r.result.reason === 'element'
        ? effectFor(w ? element : beatenBy(element))
        : (r.result.reason === 'poison' ? null : effectFor(element));
      if (hit) playEffect(w ? botBox : youBox, hit, { scale: 3 });

      const line = el('div', `display:flex;align-items:center;gap:8px;font:12px/1.6 ui-monospace,monospace;`
        + `color:${w ? P.moss : P.ember}`);
      const icon = moveIcon(element, 2);
      if (icon) line.append(icon);
      line.append(el('span', '', `Round ${r.round}: ${w ? 'you' : 'the bot'} (${r.result.reason})`));
      log.append(line);

      if (!r.done) {
        panel.firstChild.textContent = `FIGHT · ROUND ${r.round + 1} OF ${duel.rounds}`;
        return draw();
      }
      panel.firstChild.textContent = r.won ? 'YOU WON' : 'YOU LOST';
      panel.firstChild.style.color = r.won ? P.moss : P.ember;
      if (stopPoison) { stopPoison(); stopPoison = null; }
      // The bot's three moves, now that the seed is out and they cannot influence anything. The
      // silhouette gets its badges: you finally see what you were fighting.
      if (r.botMoves && r.botMoves.length) {
        const reveal = el('div', 'position:absolute;left:50%;top:8px;transform:translateX(-50%);display:flex;gap:3px');
        for (const m of r.botMoves) {
          const b = elementBadge(m.element, 2);
          if (b) reveal.append(b);
        }
        botBox.append(reveal);
      }
      if (r.won) {
        const crown = sprite('crown', 'crownP', 3);
        if (crown) {
          crown.style.cssText += ';position:absolute;left:50%;top:-14px;transform:translateX(-50%);z-index:3';
          youBox.append(crown);
        }
      }
      log.append(el('div', `margin-top:6px;font:11px/1.6 ui-monospace,monospace;color:${P.ash}`,
        r.counted
          ? (r.adult ? 'Counted toward growth, and it is an adult now.' : 'Counted toward growth.')
          : "Practice. Today's three have already counted. Fight as much as you like."));
      // Revealed only now, when there is nothing left for it to influence.
      log.append(el('div', `font:9px/1.4 ui-monospace,monospace;color:${P.ash};word-break:break-all`,
        `seed ${r.seed}`));
      const again = el('button', `margin-top:8px;padding:8px 12px;font:10px/1 ui-monospace,monospace;`
        + `letter-spacing:1px;background:${P.slab};color:${P.gold};border:1px solid ${P.edge};cursor:pointer`,
        'FIGHT AGAIN');
      again.onclick = () => this.fightPanel(c);
      log.append(again);
      await this.refresh();
      return undefined;
    };

    const draw = () => {
      controls.textContent = '';
      for (const element of ['fire', 'earth', 'water']) {
        const b = el('button', `display:flex;align-items:center;gap:6px;padding:6px 12px;`
          + `font:11px/1 ui-monospace,monospace;letter-spacing:1px;`
          + `background:${P.coal};color:${P.fog};border:1px solid ${P.slab};cursor:pointer`);
        const icon = elementBadge(element, 2);
        if (icon) b.append(icon);
        b.append(el('span', '', element.toUpperCase()));
        b.onclick = () => send(element);
        controls.append(b);
      }
      // One of each per match. A spent charge is shown spent rather than removed, so the player can
      // see what they no longer have.
      for (const kind of ['poison', 'potion']) {
        const b = el('button', '', kind.toUpperCase());
        const on = pending[kind];
        b.style.cssText = `padding:8px 10px;font:9px/1 ui-monospace,monospace;letter-spacing:1px;background:transparent;`
          + `border:1px solid ${on ? P.gold : P.slab};color:${spent[kind] ? P.slab : (on ? P.gold : P.ash)};`
          + `cursor:${spent[kind] ? 'default' : 'pointer'}`;
        b.disabled = spent[kind];
        b.title = spent[kind] ? `Your ${kind} is spent for this match` : `Add your ${kind} to this round`;
        b.onclick = () => { pending[kind] = !pending[kind]; draw(); };
        controls.append(b);
      }
    };

    draw();
    return undefined;
  }

  /**
   * The three attentions. Each matures the juvenile by the same amount and steers it somewhere
   * different. A "best" attention would collapse the choice, so they are drawn identically.
   */
  attentions(c) {
    const box = el('div', 'display:flex;flex-direction:column;gap:4px;align-items:flex-end');
    box.append(el('div', `font:10px/1 ui-monospace,monospace;letter-spacing:1px;color:${P.ash}`,
      `${c.attentionsLeft} OF 3 LEFT`));
    const row = el('div', 'display:flex;gap:4px');
    for (const kind of ['spar', 'drill', 'feed', 'play']) {
      const on = c.attentionsLeft > 0;
      // Each attention has its own drawing, and they are all the same size. None of them is the
      // best one, so none of them may look like it.
      const b = el('button', `display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;`
        + `font:9px/1 ui-monospace,monospace;letter-spacing:1px;`
        + `background:${P.slab};color:${on ? P.gold : P.ash};border:1px solid ${on ? P.edge : P.slab};`
        + `cursor:${on ? 'pointer' : 'default'};${on ? '' : 'opacity:0.5'}`);
      const icon = attentionIcon(kind, 2);
      if (icon) b.append(icon);
      b.append(el('span', '', kind.toUpperCase()));
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

  // --- the bloodline ------------------------------------------------------------------------------

  /**
   * The pedigree, read as brackets: the pair on the left rail, everything they produced on the
   * right, one block per mating. Every node carries the pip bar at 7px, which is the whole point:
   * you can scan a bloodline for a hidden trait without opening a single card.
   *
   * Escalation is carried by the left rule and the copy, never by an alert colour over the whole
   * panel. A red panel would fight the creature art, and the art is what you came to read.
   */
  async lineagePanel() {
    let data;
    try { data = await api('/lineage'); } catch (e) { return this.toast(e.message); }

    const panel = this.notice(el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`));
    panel.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:12px`,
      `BLOODLINE · ${data.total} BRED · ${data.living} LIVING`));

    if (!data.blocks.length) {
      const box = el('div', 'display:flex;gap:14px;align-items:center');
      const mark = sprite('emptyBox', 'emptyP', 3);
      if (mark) box.append(mark);
      box.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.ash}`,
        'Nothing bred yet. The first pairing draws the first bracket.'));
      panel.append(box);
      return undefined;
    }

    // Severity lives only on the 6px left rule: moss, gold, fire. Three levels, three colours.
    const RULE = { clear: P.moss, watch: P.gold, close: P.fire };
    for (const b of data.blocks) {
      const block = el('div', `display:flex;gap:12px;padding:10px 0 10px 12px;margin-bottom:10px;`
        + `border-left:6px solid ${RULE[b.severity] || P.moss};background:${P.coal}`);

      const rail = el('div', 'width:150px;flex:none;display:flex;flex-direction:column;gap:4px');
      rail.append(el('div', `font:10px/1.4 ui-monospace,monospace;letter-spacing:1px;color:${P.ash}`,
        `GENERATION ${b.generation}`));
      rail.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.fog}`, shortId(b.mother)));
      rail.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.fog}`, shortId(b.father)));
      rail.append(el('div', `margin-top:4px;font:10px/1.4 ui-monospace,monospace;color:${RULE[b.severity] || P.moss}`,
        b.penaltyPct > 0 ? `${b.relation}. −${b.penaltyPct}% viability` : b.relation));
      block.append(rail);

      const kids = el('div', 'flex:1;display:flex;flex-wrap:wrap;gap:10px');
      for (const k of b.kids) {
        const node = el('div', `display:flex;flex-direction:column;gap:4px;padding:6px;background:${P.panel};`
          + `border:1px solid ${P.slab}${k.released ? ';opacity:0.55' : ''}`);
        node.append(pips(k, 7));
        const label = el('div', 'display:flex;align-items:center;gap:4px');
        if (k.mutations && k.mutations.length) {
          const bang = sprite('bang', 'warnP', 1);
          if (bang) { bang.title = 'carries a mutation'; label.append(bang); }
        }
        if (k.released) {
          const g = sprite('ghost', 'ghostP', 1);
          if (g) { g.title = 'released: it left the stable, it did not die'; label.append(g); }
        }
        label.append(el('span', `font:9px/1.4 ui-monospace,monospace;color:${P.ash}`,
          `${k.sex === 'F' ? '♀' : '♂'} ${k.record ? `${k.record.wins}-${k.record.fights - k.record.wins}` : ''}`));
        node.append(label);
        node.title = `${shortId(k.id)} · generation ${k.generation}`
          + (k.rarity ? ` · rarity ${Math.round(k.rarity)}` : '');
        kids.append(node);
      }
      block.append(kids);
      panel.append(block);
    }
    return undefined;
  }

  // --- the ladders --------------------------------------------------------------------------------

  /**
   * Two ladders, side by side, because they measure two different things and the whole of §2.1 is
   * that a breeder and a fighter both get somewhere. Combat is won-lost; Genetics is the rarest
   * thing you actually managed to express.
   */
  async laddersPanel() {
    let data;
    try { data = await api('/ladders'); } catch (e) { return this.toast(e.message); }

    const panel = this.notice(el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`));
    const cols = el('div', 'display:flex;gap:16px;flex-wrap:wrap');

    const board = (title, sub, rows, value) => {
      const col = el('div', 'flex:1;min-width:220px');
      col.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.bone}`, title));
      col.append(el('div', `font:9px/1.6 ui-monospace,monospace;letter-spacing:1px;color:${P.ash};margin-bottom:8px`, sub));
      if (!rows.length) {
        col.append(el('div', `font:11px/1.6 ui-monospace,monospace;color:${P.ash}`, 'Nothing on this ladder yet.'));
        return col;
      }
      rows.slice(0, 10).forEach((r, i) => {
        const line = el('div', `display:flex;align-items:center;gap:8px;padding:5px 0;`
          + `border-bottom:1px solid ${P.slab}${r.released ? ';opacity:0.55' : ''}`);
        // The leader wears the crown, and only the leader. A rank number under it would be noise.
        const lead = i === 0 ? sprite('crown', 'crownP', 1) : null;
        line.append(lead || el('div', `width:16px;font:10px/1 ui-monospace,monospace;color:${P.ash}`, String(i + 1)));
        if (r.traits) line.append(creature(r.traits, 28));
        line.append(el('div', `flex:1;font:10px/1.4 ui-monospace,monospace;color:${P.fog}`, shortId(r.id)));
        line.append(el('div', `font:11px/1 ui-monospace,monospace;color:${i === 0 ? P.gold : P.bone}`, value(r)));
        col.append(line);
      });
      return col;
    };

    cols.append(board('COMBAT', `SEASON ${String(this.state.season.id || 1).padStart(2, '0')} · W – L`,
      data.combat, (r) => `${r.wins}–${r.fights - r.wins}`));
    cols.append(board('GENETICS', 'RAREST EXPRESSED', data.genetics, (r) => String(Math.round(r.score || 0))));
    panel.append(cols);
    panel.append(el('div', `margin-top:10px;font:10px/1.6 ui-monospace,monospace;color:${P.ash}`,
      'The top of either ladder earns a DNA Orb at season end. One per player, however many you top: '
      + 'the Orb carries one bloodline.'));
    return undefined;
  }

  // --- Paradise and the Hall of Fame ---------------------------------------------------------------

  /**
   * Paradise: where the released are, and the only place in the game whose backdrop is brighter
   * than the creatures standing on it. Same neutral discipline as the arenas, shifted one step
   * violet and one step lighter.
   *
   * Ghosts drift on a slow sine bob. The light column behind the gate is a single 50% block, not a
   * gradient: a gradient would read as glow, and this is a gate, not a heaven.
   */
  paradise(rows) {
    const box = el('div', `position:relative;height:190px;overflow:hidden;background:${P.veilDark};`
      + `border:1px solid ${P.veil}`);
    const beam = el('div', `position:absolute;left:50%;top:0;bottom:0;width:54px;margin-left:-27px;`
      + `background:${P.veilLight};opacity:0.5`);
    box.append(beam);
    box.append(el('div', `position:absolute;left:0;right:0;bottom:0;height:26%;background:${P.veil};opacity:0.55`));

    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rows.slice(0, 8).forEach((r, i) => {
      const slot = el('div', `position:absolute;bottom:${26 + (i % 2) * 12}%;`
        + `left:${8 + (i * 11) % 84}%;cursor:pointer`);
      const g = sprite('ghost', 'ghostP', 3);
      if (!g) return;
      slot.append(g);
      slot.title = `${shortId(r.id)}: released, not dead. It kept its page and its place on the roster.`;
      box.append(slot);
      if (still) return;
      // Each ghost on its own phase, so they never march in step.
      const phase = i * 0.9;
      const start = Date.now();
      setInterval(() => {
        slot.style.transform = `translateY(${(Math.sin((Date.now() - start) / 1400 + phase) * 5).toFixed(1)}px)`;
      }, 60);
    });
    return box;
  }

  /**
   * The Hall of Fame plaque. The frame is the only gold surface in the game outside the DNA Orb,
   * which is what makes it mean something: two-tone bevel, four corner blocks, and the pip bar on
   * the plaque underneath, so the genetics stay visible even in the trophy case.
   */
  plaque(c, title) {
    const frame = el('div', `position:relative;padding:10px;background:${P.goldDark};`
      + `border:3px solid ${P.gold};display:flex;flex-direction:column;align-items:center;gap:6px;width:200px`);
    for (const [a, b] of [['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']]) {
      frame.append(el('div', `position:absolute;${a}:-3px;${b}:-3px;width:7px;height:7px;background:${P.goldLight}`));
    }
    const crown = sprite('crown', 'crownP', 2);
    if (crown) frame.append(crown);
    if (c.traits) frame.append(creature(c.traits, 96));
    frame.append(el('div', `font:12px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ink}`,
      shortId(c.id).toUpperCase()));
    frame.append(el('div', `font:9px/1.4 ui-monospace,monospace;letter-spacing:1px;color:${P.ink}`, title));
    const plate = el('div', `padding:6px;background:${P.ink};display:flex;justify-content:center;width:100%`);
    plate.append(pips(c, 9));
    frame.append(plate);
    return frame;
  }

  async hallPanel() {
    let data;
    let line;
    try {
      data = await api('/ladders');
      line = await api('/lineage');
    } catch (e) { return this.toast(e.message); }

    const panel = this.notice(el('div', `padding:16px;background:${P.panel};border:1px solid ${P.edge};margin-bottom:20px`));
    panel.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:12px`,
      'HALL OF FAME'));

    // Two plaques, one per ladder, because those are the two ways to be worth remembering. A season
    // with nothing on either gets told so rather than shown an empty gold frame, which would read
    // as a bug rather than as an empty season.
    const best = [];
    if (data.combat[0] && data.combat[0].fights) {
      best.push([data.combat[0], `SEASON ${String((this.state.season && this.state.season.id) || 1).padStart(2, '0')} · `
        + `${data.combat[0].wins} WIN${data.combat[0].wins === 1 ? '' : 'S'}`]);
    }
    if (data.genetics[0] && data.genetics[0].score) {
      best.push([data.genetics[0], `RAREST EXPRESSED · ${Math.round(data.genetics[0].score)}`]);
    }
    if (!best.length) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.ash};margin-bottom:16px`,
        'Nothing has earned a plaque yet. Win a fight, or breed something rarer than anything else '
        + 'in your line.'));
    } else {
      const row = el('div', 'display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px');
      for (const [c, title] of best) row.append(this.plaque(c, title));
      panel.append(row);
    }

    const released = (line.blocks || []).flatMap((b) => b.kids.filter((k) => k.released));
    panel.append(el('div', `font:11px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:8px`,
      `PARADISE · ${released.length} RELEASED`));
    panel.append(this.paradise(released));
    panel.append(el('div', `margin-top:8px;font:10px/1.6 ui-monospace,monospace;color:${P.ash}`,
      'Released is not dead. They keep their page, their record and their place on the season '
      + 'roster. Nothing is deleted, ever.'));
    return undefined;
  }

  // --- picking the parents ------------------------------------------------------------------------

  /**
   * Choose two Alphas. Only Alphas start a line, which is what makes them the permanent breeding
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
      this.notice(panel);
      return undefined;
    }
    if (!data.females || !data.males) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.ember}`,
        `Breeding needs one of each. You hold ${data.females} female and ${data.males} male. `
        + 'Pink ears are female, grey are male.'));
    } else if (data.females + data.males < 4) {
      panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.fog};margin-bottom:12px`,
        'Every descendant of one pair is a full sibling, so this line will stall at the first '
        + 'generation. Going deeper needs unrelated blood: a second pair, or another player\'s Alpha.'));
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
      // The two Alphas travel with the refs. The server's preview does not carry traits, and the
      // meeting has to draw two animals, so they are handed on from the only screen that has them.
      this.openPairing(
        { carrierKey: sel.mother.carrierKey }, { carrierKey: sel.father.carrierKey },
        { mother: sel.mother, father: sel.father },
      );
    };
    panel.append(grid, go);
    if (data.truncated) {
      panel.append(el('div', `margin-top:8px;font:10px/1.4 ui-monospace,monospace;color:${P.ash}`,
        'Showing your first 60 Alphas.'));
    }
    paint();
    this.notice(panel);
    return undefined;
  }

  // --- pairing ----------------------------------------------------------------------------------

  /**
   * The pairing screen. Its whole job is §3.4: put the relation and one percentage in front of the
   * player BEFORE the confirm button, so an abstract coefficient becomes a decision they can weigh.
   */
  async openPairing(motherRef, fatherRef, parents = null) {
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
      go.onclick = () => this.commit(motherRef, fatherRef, panel, parents);
      panel.append(go);
    } else {
      panel.append(el('div', `margin-top:8px;font:11px/1.6 ui-monospace,monospace;color:${P.ash}`,
        (pv.blockers || []).map(describeBlocker).join(' · ')));
    }
    this.notice(panel);
    return undefined;
  }

  /**
   * Commit, then reveal. The hash is shown before the outcome exists and the seed after, so a
   * player who cares can rerun genetics.breed() and confirm the animal they were given is the
   * animal the seed produced.
   */
  async commit(motherRef, fatherRef, panel, parents = null) {
    panel.textContent = '';
    let open;
    try { open = await api('/pair', { method: 'POST', body: JSON.stringify({ mother: motherRef, father: fatherRef }) }); }
    catch (e) { return this.toast(e.message); }
    panel.append(el('div', `font:11px/1.6 ui-monospace,monospace;color:${P.ash};word-break:break-all`,
      `committed ${open.serverSeedHash}`));

    // The meeting. It sits between the commit and the reveal on purpose: the seed is already fixed
    // and published, so nothing that happens on screen can be suspected of deciding the outcome.
    // It is a ceremony around a decision that has already been made, which is the only honest place
    // to put one.
    if (parents && parents.mother && parents.father) {
      const meet = el('div', 'margin-top:10px');
      meet.append(el('div', `font:10px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.ash};margin-bottom:6px`,
        'THEY MEET'));
      this.meeting = habitat({
        traits: parents.mother.traits,
        element: houseElement(parents.mother),
        growth: 6, growthToAdult: 6, attentions: {}, height: 200, props: false,
      });
      meet.append(this.meeting.el);
      panel.append(meet);
      try { await this.meeting.visit({ traits: parents.father.traits }); }
      catch (e) { /* the meeting is decoration: never let it hold up the reveal */ }
    }

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
      r.freeBreed
        ? `Born, generation ${r.generation}.`
        : `Expecting. Born in two days, generation ${r.generation}.`));
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

  /**
   * The hatch (design pass 3e). Egg, a hard two-frame split, a white burst, then the juvenile.
   *
   * The sequencing is the design call and it is worth keeping: the animal settles FIRST, and the
   * name and the pip bar arrive after. The genetics are the actual reveal, so they land last.
   * A player who is shown a bar and a creature at the same instant reads the bar.
   *
   * Honours prefers-reduced-motion by going straight to the settled state; nothing here is load
   * bearing except the order.
   */
  hatch(c) {
    const panel = this.notice(el('div', `padding:24px;background:${P.panel};border:1px solid ${P.edge};`
      + 'margin-bottom:20px;display:flex;flex-direction:column;align-items:center;gap:12px'));
    const stage = el('div', 'position:relative;display:flex;align-items:flex-end;justify-content:center;height:180px');
    panel.append(stage);

    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const settle = () => {
      stage.textContent = '';
      // The adult-width ground shadow: a juvenile is the same drawing at a smaller scale, so the
      // shadow is what tells you it is small rather than far away.
      const shadow = el('div', `position:absolute;bottom:6px;width:120px;height:8px;border-radius:50%;`
        + `background:${P.ink};opacity:0.55`);
      stage.append(shadow, creature(c.traits, 132));
      const name = el('div', `font:13px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.bone};opacity:0`,
        `${c.sex === 'F' ? '♀' : '♂'} GENERATION ${c.generation}`);
      const bar = el('div', 'display:flex;justify-content:center;opacity:0');
      bar.append(pips(c, 18));
      panel.append(name, bar);
      const reveal = () => { name.style.transition = bar.style.transition = 'opacity .5s'; name.style.opacity = bar.style.opacity = '1'; };
      if (still) reveal(); else setTimeout(reveal, 420);
      if (c.mutations && c.mutations.length) {
        for (const m of c.mutations) {
          panel.append(el('div', `font:12px/1.6 ui-monospace,monospace;color:${P.prismB}`,
            `MUTATION · ${m.locus} became ${m.value}, from neither parent.`));
        }
      }
    };

    if (still) return settle();
    const egg = el('div', `width:96px;height:112px;background:${P.bone};border:4px solid ${P.ink};`
      + 'border-radius:50% 50% 46% 46%;image-rendering:pixelated');
    stage.append(egg);
    setTimeout(() => { egg.style.transform = 'translateX(-6px)'; }, 260);
    setTimeout(() => { egg.style.transform = 'translateX(6px)'; }, 400);
    setTimeout(() => {
      const burst = el('div', `position:absolute;bottom:24px;width:150px;height:150px;border-radius:50%;`
        + `background:${P.paper};transition:opacity .35s`);
      stage.append(burst);
      setTimeout(() => { burst.style.opacity = '0'; }, 60);
      setTimeout(settle, 300);
    }, 560);
    return undefined;
  }

  /**
   * Spending the DNA Orb (design pass 4b). One orb, one bloodline, no undo.
   *
   * The decision is genetic, so the pip bar is drawn at 18px here (larger than anywhere else in
   * the game) and the win record sits under it as a subordinate line. The candidates are NOT
   * ranked, and the button stays inert until one is chosen.
   */
  async orbPanel() {
    let data;
    try { data = await api('/orb'); } catch (e) { return this.toast(e.message); }
    const panel = this.notice(el('div', `padding:16px;background:${P.panel};border:1px solid ${P.gold};margin-bottom:20px`));
    panel.append(el('div', `font:12px/1 ui-monospace,monospace;letter-spacing:2px;color:${P.gold}`,
      `DNA ORB ×${data.orbs}`));
    if (!data.orbs || !data.candidates.length) {
      panel.append(el('div', `margin-top:8px;font:12px/1.6 ui-monospace,monospace;color:${P.fog}`,
        data.orbs ? 'Nothing saved to carry.' : 'You hold no Orb. They go to the top of each ladder at season end.'));
      return undefined;
    }
    panel.append(el('div', `margin-top:4px;margin-bottom:14px;font:12px/1.6 ui-monospace,monospace;color:${P.fog}`,
      'Carries one bloodline into the next season. Everything else you bred is gone.'));

    let chosen = null;
    const grid = el('div', 'display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px');
    const go = el('button', '', 'SPEND THE ORB');
    const paint = () => {
      for (const card of grid.children) {
        card.style.cssText = card._base + `;border:1px solid ${card._c === chosen ? P.gold : P.slab}`;
      }
      go.style.cssText = `padding:10px 14px;font:12px/1 ui-monospace,monospace;letter-spacing:1px;border:none;`
        + `background:${chosen ? P.gold : P.slab};color:${chosen ? P.ink : P.ash};cursor:${chosen ? 'pointer' : 'default'}`;
      go.disabled = !chosen;
    };
    for (const cand of data.candidates) {
      const card = el('div');
      card._c = cand;
      card._base = `display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px;width:300px;background:${P.coal};cursor:pointer`;
      // The bar first and biggest: the decision is genetic, and the record is subordinate to it.
      const plate = el('div', `padding:8px;background:${P.ink};display:flex;justify-content:center`);
      plate.append(pips(cand, 18));
      card.append(plate, creature(cand.traits, 96));
      card.append(el('div', `font:11px/1.4 ui-monospace,monospace;color:${P.bone}`,
        `${cand.sex === 'F' ? '♀' : '♂'} generation ${cand.generation}`));
      card.append(el('div', `font:10px/1.4 ui-monospace,monospace;color:${P.ash}`,
        `${cand.record.wins} wins in ${cand.record.fights}`));
      card.onclick = () => { chosen = chosen === cand ? null : cand; paint(); };
      grid.append(card);
    }
    go.onclick = async () => {
      go.disabled = true;
      let r;
      try { r = await api('/orb/spend', { method: 'POST', body: JSON.stringify({ id: chosen.id }) }); }
      catch (e) { return this.toast(e.message); }
      await this.refresh();
      this.hatch({ traits: r.traits, zygosity: chosen.zygosity, sex: chosen.sex, generation: 0, mutations: [] });
      return undefined;
    };
    panel.append(grid, go);
    panel.append(el('div', `margin-top:8px;font:10px/1.4 ui-monospace,monospace;color:${P.ash}`,
      'This cannot be undone, and there is no second orb.'));
    paint();
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
