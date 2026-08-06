// verginals-kit.js — Verginals Adventure Mode UI kit, as data.
// Every sprite is a 16x16 grid of palette keys. Nothing is a bitmap until you ask for one.
// Layer order for creature composition: Body -> Ears -> Collar -> Face -> Rune.
// Collar sits UNDER Face: the pendant plate is opaque and clipped Rainbow (19,712px)
// and Crying (9,472px). Rune stays last so the glyph still reads on the plate.

export const PALETTE = {
  ink:'#0E0E13', coal:'#17171E', panel:'#1E1E28', slab:'#2A2A36', edge:'#3C3C4C',
  ash:'#6E6F82', fog:'#A9AAB8', bone:'#E6E4DC', paper:'#F7F5EE',
  fire:'#E8452C', ember:'#FF9A2E', fireDark:'#A62615',
  earth:'#7FA83F', moss:'#A8CC63', loam:'#4A6B2A',
  water:'#3E8FD0', foam:'#86D3E8', deep:'#245F94',
  prismA:'#FF3E7F', prismB:'#FFD23E', prismC:'#3EE0C0', prismD:'#7A5CFF',
  voidFill:'#12121C', voidGlow:'#EFEFFA',
  toxic:'#9BE04A', toxDark:'#4B7A1E',
  veil:'#7C74A8', veilLight:'#A9A2CC', veilDark:'#4C466B',
  gold:'#FFC93C', goldLight:'#FFE9A3', goldDark:'#C4801A',
  glass:'#C9CCDA'
};

export const FRAME = [
  '..KKKKKKKKKKKK..',
  '.KLLLLLLLLLLLLK.',
  'KLLFFFFFFFFFFLLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KLFFFFFFFFFFFFLK',
  'KDDFFFFFFFFFFDDK',
  '.KDDDDDDDDDDDDK.',
  '..KKKKKKKKKKKK..'
];

export const SPRITES = {
  fireBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFFFKFFFFFFLK',
    'KLFFFFFKKFFFFFLK','KLFFFFKKKFFFFFLK','KLFFFKKKKKFFFFLK','KLFFFKKFKKKFFFLK',
    'KLFFKKKFFKKKFFLK','KLFFKKFFFFKKFFLK','KLFFKKFFFFKKFFLK','KLFFFKKFFKKFFFLK',
    'KLFFFFKKKKFFFFLK','KDDFFFFKKFFFFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  earthBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFFFFFFFFFFLK',
    'KLFFFFFKKFFFFFLK','KLFFFFKKKKFFFFLK','KLFFFKKFFKKFFFLK','KLFFKKFFFFKKFFLK',
    'KLFKKFFFFFFKKFLK','KLFKKKKKKKKKKFLK','KLFFFFFFFFFFFFLK','KLFFKKKKKKKKFFLK',
    'KLFFFFFFFFFFFFLK','KDDFKKKKKKKKFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  waterBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFFFFKFFFFFLK',
    'KLFFFFFKKKFFFFLK','KLFFFFKKKKKFFFLK','KLFFFKKKKKKKFFLK','KLFFKKKKKKKKKFLK',
    'KLFFKKKKKKKKKFLK','KLFFFKKKKKKKFFLK','KLFFFFKKKKKFFFLK','KLFFFFFFFFFFFFLK',
    'KLFFKKFFKKFFKKLK','KDDFFFFKKFFKKDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  prismBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFFFKKFFFFFLK',
    'KLFFFFKKKKFFFFLK','KLFFFKKKKKKFFFLK','KLFFKKKKKKKKFFLK','KLFKKKKKKKKKKFLK',
    'KLFKKKKKKKKKKFLK','KLFFKKKKKKKKFFLK','KLFFFKKKKKKFFFLK','KLFFFFKKKKFFFFLK',
    'KLFFFFFKKFFFFFLK','KDDFFFFFFFFFFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  voidBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFWWWWWWFFFLK',
    'KLFFWWWWWWWWFFLK','KLFWWWFFFFWWWFLK','KLFWWFFFFFFWWFLK','KLFWWFFFFFFWWFLK',
    'KLFWWFFFFFFWWFLK','KLFWWFFFFFFWWFLK','KLFWWWFFFFWWWFLK','KLFFWWWWWWWWFFLK',
    'KLFFFWWWWWWFFFLK','KDDFFFFFFFFFFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  toxicBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFKKFFFFKKFFLK',
    'KLFFFKKFFKKFFFLK','KLFFFFKKKKFFFFLK','KLFFFKKKKKKFFFLK','KLFFKKWKKWKKFFLK',
    'KLFFKKKKKKKKFFLK','KLFFFKKKKKKFFFLK','KLFFFFKKKKFFFFLK','KLFFFKKFFKKFFFLK',
    'KLFFKKFFFFKKFFLK','KDDFFFFFFFFFFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  veilBadge: [
    '..KKKKKKKKKKKK..','.KLLLLLLLLLLLLK.','KLLFFFFFFFFFFLLK','KLFFFFFFFFFFFFLK',
    'KLFFKKKKKKKKFFLK','KLFKKFFFFFFKKFLK','KLFKFFKKKKFFKFLK','KLFKFKKWWKKFKFLK',
    'KLFKFFKKKKFFKFLK','KLFKKFFFFFFKKFLK','KLFFKKKKKKKKFFLK','KLFFFFFFFFFFFFLK',
    'KLFFKFFKFFKFFKLK','KDDFFFFFFFFFFDDK','.KDDDDDDDDDDDDK.','..KKKKKKKKKKKK..'
  ],
  fireMove: [
    '................','.......KK.......','.......KK.......','......KFFK......',
    '.....KFFFFK.....','.....KFFFFK.....','....KFFLLFFK....','....KFLLLLFK....',
    '...KFFLLLLFFK...','...KFLLWWLLFK...','...KFLLWWLLFK...','...KFFLLLLFFK...',
    '....KFFLLFFK....','....KKFFFFKK....','.....KKKKKK.....','................'
  ],
  earthMove: [
    '................','................','.......KKK......','......KFFFK.....',
    '.....KFLLFFK....','....KFLLLFFFK...','....KFLLFFFFK...','...KFFLFFFFFFK..',
    '...KFFFFFFFFFK..','..KFFFFFFDDFFK..','..KFFFFFDDDDFK..','..KFFDDFDDDDFK..',
    '..KFDDDDFDDFFK..','..KKFFFFFFFFKK..','...KKKKKKKKKK...','................'
  ],
  waterMove: [
    '................','.......KK.......','.......KK.......','......KFFK......',
    '......KFFK......','.....KFLFFK.....','.....KFLFFK.....','....KFLLFFFK....',
    '....KFLLFFFK....','...KFLLFFFFFK...','...KFLFFFFFFK...','...KFFFFFFFFK...',
    '...KFFFFFFFFK...','....KKFFFFKK....','.....KKKKKK.....','................'
  ],
  flask: [
    '................','.....KKKKKK.....','.....KWWWWK.....','.....KFFFFK.....',
    '.....KFFFFK.....','....KKFFFFKK....','....KFFFFFFK....','...KKFFFFFFKK...',
    '...KFPPPPPPFK...','...KFPPPPPPFK...','...KPPPPPPPPK...','...KPPWPPWPPK...',
    '...KPPPPPPPPK...','...KKPPPPPPKK...','....KKKKKKKK....','................'
  ],
  spar: [
    '................','..KK........KK..','.KFFK......KFFK.','.KFFFK....KFFFK.',
    '..KFFFK..KFFFK..','...KFFFKKFFFK...','....KFFFFFFK....','....KFFFFFFK....',
    '....KFFFFFFK....','...KFFFKKFFFK...','..KFFFK..KFFFK..','.KFFFK....KFFFK.',
    '.KFFK......KFFK.','..KK........KK..','................','................'
  ],
  drill: [
    '................','.....KKKKKK.....','...KKFFFFFFKK...','..KFFFFFFFFFFK..',
    '..KFFFKKKKFFFK..','.KFFKKFFFFKKFFK.','.KFFKFFKKFFKFFK.','.KFFKFKFFKFKFFK.',
    '.KFFKFKFFKFKFFK.','.KFFKFFKKFFKFFK.','.KFFKKFFFFKKFFK.','..KFFFKKKKFFFK..',
    '..KFFFFFFFFFFK..','...KKFFFFFFKK...','.....KKKKKK.....','................'
  ],
  feed: [
    '................','.........KK.....','........KFFK....','.......KFFFK....',
    '.......KFFK.....','................','..KKKKKKKKKKKK..','..KFFFFFFFFFFK..',
    '..KFLLLLLLLLFK..','..KFFFFFFFFFFK..','...KFFFFFFFFK...','...KFFFFFFFFK...',
    '....KFFFFFFK....','.....KKKKKK.....','................','................'
  ],
  play: [
    '................','......KKKK......','....KKFFFFKK....','...KFFFFFFFFK...',
    '..KFFLFFFFLFFK..','..KFLFFLLFFLFK..','.KFFFFLFFLFFFFK.','.KFFLFFFFFFLFFK.',
    '.KFFLFFFFFFLFFK.','.KFFFFLFFLFFFFK.','..KFLFFLLFFLFK..','..KFFLFFFFLFFK..',
    '...KFFFFFFFFK...','....KKFFFFKK....','......KKKK......','................'
  ],
  orb: [
    '................','......KKKK......','....KKWWWWKK....','...KWWLLLLGGK...',
    '..KWLLGGLLGGGK..','..KLLGGLLGGGGK..','.KLGGLLGGLLGGGK.','.KLGGLLGGLLGGGK.',
    '.KLGGGLLGGLLGGK.','.KGGGGLLGGLLGGK.','..KGGGGLLGGLLK..','..KGGGGGLLGGLK..',
    '...KGGGGGLLGK...','....KKGGGGKK....','......KKKK......','................'
  ],
  diamond: [
    '................','................','.......KK.......','......KFFK......',
    '.....KFFFFK.....','....KFFFFFFK....','...KFFFFFFFFK...','..KFFFFFFFFFFK..',
    '..KFFFFFFFFFFK..','...KFFFFFFFFK...','....KFFFFFFK....','.....KFFFFK.....',
    '......KFFK......','.......KK.......','................','................'
  ],
  egg0: [
    '................','......KKKK......','.....KWWWWK.....','....KWWLLLLK....',
    '...KWLLLLLLLK...','...KWLLLLLLLK...','..KWLLLLLLLLLK..','..KWLLLLLLLLLK..',
    '..KWLLLLLLLLLK..','..KWLLLLLLLLLK..','..KWLLLLLLLLLK..','...KLLLLLLLLK...',
    '...KKLLLLLLKK...','....KKKKKKKK....','................','................'
  ],
  egg1: [
    '................','......KKKK......','.....KWWWWK.....','....KWWLLLLK....',
    '...KWLLLLLLLK...','...KWLLLLLLLK...','..KWLLLLLLLLLK..','..KWLLLLKLLLLK..',
    '..KWLLLKLLLLLK..','..KWLLLLLLLLLK..','..KWLLLLLLLLLK..','...KLLLLLLLLK...',
    '...KKLLLLLLKK...','....KKKKKKKK....','................','................'
  ],
  egg2: [
    '................','......KKKK......','.....KWWWWK.....','....KWWLLLLK....',
    '...KWLLLLLLLK...','...KWLLLCLLLK...','..KWLLLLKLLLLK..','..KWLLLKKLLLLK..',
    '..KWLLKKLLLLLK..','..KWLLLKKLLLLK..','..KWLLLLKLLLLK..','...KLLLCLLLLK...',
    '...KKLLLLLLKK...','....KKKKKKKK....','................','................'
  ],
  ghost: [
    '................','...KK......KK...','...KGK....KGK...','...KGGK..KGGK...',
    '...KGGGKKGGGK...','..KGGGGGGGGGGK..','..KGGGGGGGGGGK..','..KGWWGGGGWWGK..',
    '..KGWWGGGGWWGK..','..KGGGGGGGGGGK..','..KGGGGGGGGGGK..','..KGGGGGGGGGGK..',
    '..KGGKGGKGGKGGK.','..KGKKKGKKGKKGK.','..K..KK..KK..K..','................'
  ],
  sprout: [
    '................','................','................','................',
    '.......KK.......','....KKKFFKKK....','...KFFFFFFFFK...','..KFFFKFFKFFFK..',
    '..KFFKFFFFKFFK..','..KFFFFFFFFFFK..','...KFFFFFFFFK...','....KKKFFKKK....',
    '.......KK.......','................','................','................'
  ],
  bang: [
    '................','.......KK.......','......KFFK......','......KFFK......',
    '.....KFFFFK.....','.....KFFFFK.....','....KFFFFFFK....','....KFFFFFFK....',
    '...KFFFFFFFFK...','...KFFFFFFFFK...','..KFFFFFFFFFFK..','..KFFFFFFFFFFK..',
    '..KKKKKKKKKKKK..','................','......KKKK......','......KFFK......'
  ],
  emptyBox: [
    '................','..KKKKKKKKKKKK..','..KFFFFFFFFFFK..','..KFFFFFFFFFFK..',
    '..KFFKKKKKKFFK..','..KFKFFFFFFKFK..','..KFKFFFFFFKFK..','..KFKFFFFFFKFK..',
    '..KFKFFFFFFKFK..','..KFKFFFFFFKFK..','..KFFKKKKKKFFK..','..KFFFFFFFFFFK..',
    '..KFFFFFFFFFFK..','..KKKKKKKKKKKK..','................','................'
  ],
  fireFx1: [
    '................','................','.......K........','....K..KK..K....',
    '.....KKFKKK.....','....KKFFFKK.....','...KKFFWFFKK....','..KKFFWWWFFKK...',
    '...KKFFWFFKK....','....KKFFFKK.....','.....KKFKKK.....','....K..KK..K....',
    '.......K........','................','................','................'
  ],
  fireFx2: [
    '................','....K.......K...','................','..K...KKKK...K..',
    '.....KFFFFK.....','....KF....FK....','...KF......FK...','...KF......FK...',
    '...KF......FK...','....KF....FK....','.....KFFFFK.....','..K...KKKK...K..',
    '................','....K.......K...','................','................'
  ],
  earthFx1: [
    '................','................','.....K....K.....','....KFK..KFK....',
    '.....KK..KK.....','................','..K.KK.KK.KK.K..','.KFKFFKFFKFFKFK.',
    'KFFFFFFFFFFFFFFK','.KKFFKFFKFFKFFK.','...KK.KK.KK.KK..','................',
    '................','................','................','................'
  ],
  earthFx2: [
    '................','................','................','................',
    '................','......K.K.......','.....KFKFK......','..K.KFFFFFK.K...',
    '.KFKFFFFFFFKFK..','KFFFFFFFFFFFFFK.','.KKKKKKKKKKKKK..','................',
    '................','................','................','................'
  ],
  waterFx1: [
    '................','..K..........K..','..K...KKKK...K..','...K.KFFFFK.K...',
    '.....KFFFFK.....','....KFFFFFFK....','...KFFFFFFFFK...','...KFFFFFFFFK...',
    '....KFFFFFFK....','.....KFFFFK.....','......KKKK......','................',
    '................','................','................','................'
  ],
  waterFx2: [
    '................','.K.....K.....K..','K.K...K.K...K.K.','.K.....K.....K..',
    '................','....K.....K.....','...KFK...KFK....','....K.....K.....',
    '................','......KKKK......','.....KFFFFK.....','......KKKK......',
    '................','................','................','................'
  ],
  poisonFx1: [
    '................','................','.....KK...KK....','....KFFK.KFFK...',
    '...KFFFFKFFFFK..','..KFFFFFFFFFFK..','..KFFWFFFFWFFK..','..KFFFFFFFFFFK..',
    '...KFFFFFFFFK...','....KKFFFFKK....','......KKKK......','.......KK.......',
    '................','................','................','................'
  ],
  poisonFx2: [
    '................','................','......KKKK......','.....KFFFFK.....',
    '....KFFFFFFK....','....KFFFFFFK....','.....KFFFFK.....','......KKKK......',
    '.......K........','.......K........','......KFK.......','.......K........',
    '................','................','................','................'
  ],
  potionFx1: [
    '................','.......K........','......KWK.......','.......K........',
    '...K........K...','..KWK......KWK..','...K........K...','................',
    '......KKKK......','.....KFFFFK.....','.....KFFFFK.....','......KKKK......',
    '................','.....K....K.....','....KWK..KWK....','.....K....K.....'
  ],
  potionFx2: [
    '................','................','....K.......K...','...KWK.....KWK..',
    '....K.......K...','................','.......KK.......','......KFFK......',
    '......KFFK......','.......KK.......','................','....K.......K...',
    '...KWK.....KWK..','....K.......K...','................','................'
  ],
  crown: [
    '................','................','..K..........K..','..KK...KK...KK..',
    '..KFK..KFK..KFK.','..KFFKKFFFKKFFK.','..KFFFFFFFFFFFK.','..KFFFFFFFFFFFK.',
    '..KFFWFFWFFWFFK.','..KFFFFFFFFFFFK.','..KKKKKKKKKKKKK.','................',
    '................','................','................','................'
  ]
};

export const PALETTES = {
  fire: { K:PALETTE.ink, F:PALETTE.fire, L:PALETTE.ember, D:PALETTE.fireDark, W:PALETTE.goldLight },
  earth:{ K:PALETTE.ink, F:PALETTE.earth, L:PALETTE.moss, D:PALETTE.loam, W:PALETTE.paper },
  water:{ K:PALETTE.ink, F:PALETTE.water, L:PALETTE.foam, D:PALETTE.deep, W:PALETTE.paper },
  prism:{ K:PALETTE.ink, F:PALETTE.prismA, L:PALETTE.prismB, D:PALETTE.prismD, W:PALETTE.prismC },
  vd:   { K:'#000000', F:PALETTE.voidFill, L:'#33324A', D:'#05050A', W:PALETTE.voidGlow },
  toxic:{ K:PALETTE.ink, F:PALETTE.toxic, L:'#C6F58A', D:PALETTE.toxDark, W:PALETTE.paper },
  veil: { K:PALETTE.ink, F:PALETTE.veil, L:PALETTE.veilLight, D:PALETTE.veilDark, W:PALETTE.paper },
  fireMove: { K:PALETTE.ink, F:PALETTE.fire, L:PALETTE.ember, W:PALETTE.goldLight },
  earthMove:{ K:PALETTE.ink, F:PALETTE.moss, L:'#CBE79A', D:PALETTE.loam },
  waterMove:{ K:PALETTE.ink, F:PALETTE.water, L:PALETTE.foam },
  poison:{ K:PALETTE.ink, F:PALETTE.glass, W:PALETTE.paper, P:PALETTE.toxic },
  potion:{ K:PALETTE.ink, F:PALETTE.glass, W:PALETTE.goldLight, P:PALETTE.fire },
  sparP:{ K:PALETTE.ink, F:PALETTE.fire },
  drillP:{ K:PALETTE.ink, F:PALETTE.water },
  feedP:{ K:PALETTE.ink, F:PALETTE.earth, L:PALETTE.moss },
  playP:{ K:PALETTE.ink, F:PALETTE.gold, L:PALETTE.goldLight },
  orbP: { K:PALETTE.ink, W:'#FFF6D6', G:'#F2A81E', L:PALETTE.goldLight },
  won:  { K:PALETTE.ink, F:PALETTE.gold },
  lost: { K:'#4A2A2A', F:'#2A1A1E' },
  pending:{ K:PALETTE.edge },
  eggP: { K:PALETTE.ink, W:'#FFFFFF', L:'#EDE7D6', C:PALETTE.gold },
  ghostP:{ K:PALETTE.ink, G:'#E8DFCF', W:PALETTE.slab },
  sproutP:{ K:PALETTE.ink, F:PALETTE.earth },
  warnP:{ K:PALETTE.ink, F:PALETTE.gold },
  emptyP:{ K:PALETTE.edge, F:'#1A1A21' },
  fireFx:  { K:PALETTE.ink, F:PALETTE.ember, W:PALETTE.goldLight },
  earthFx: { K:PALETTE.ink, F:PALETTE.moss,  W:PALETTE.paper },
  waterFx: { K:PALETTE.ink, F:PALETTE.foam,  W:PALETTE.paper },
  poisonFx:{ K:PALETTE.ink, F:PALETTE.toxic, W:PALETTE.paper },
  potionFx:{ K:PALETTE.ink, F:PALETTE.goldLight, W:PALETTE.paper },
  crownP:  { K:PALETTE.ink, F:PALETTE.gold,  W:PALETTE.goldLight }
};

export const TRAIT_LAYERS = ['Body', 'Ears', 'Collar', 'Face', 'Rune'];

// Face art is authored at 560x560 and sits inside the 576x624 body frame.
export const LAYER_RECTS = {
  Body:   { x: 0, y: 0, w: 576, h: 624 },
  Ears:   { x: 0, y: 0, w: 576, h: 624 },
  Face:   { x: 8, y: 0, w: 560, h: 560 },
  Collar: { x: 0, y: 0, w: 576, h: 624 },
  Rune:   { x: 0, y: 0, w: 576, h: 624 }
};

export function spriteUrl(layer, name, base = 'sprites') {
  return base + '/' + layer + '/' + encodeURIComponent(name) + '.webp';
}

// --- renderers -------------------------------------------------------------

// DOM: one element, one box-shadow. Cheapest way to put a sprite on a page.
export function toBoxShadow(rows, pal, cell = 1) {
  const parts = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = pal[rows[y][x]];
      if (c) parts.push(`${x * cell}px ${y * cell}px 0 0 ${c}`);
    }
  }
  return parts.join(',');
}

export function toElement(rows, pal, cell = 1, doc = document) {
  const wrap = doc.createElement('div');
  wrap.style.cssText = `position:relative;width:${rows[0].length * cell}px;height:${rows.length * cell}px`;
  const px = doc.createElement('div');
  px.style.cssText = `position:absolute;left:0;top:0;width:${cell}px;height:${cell}px;box-shadow:${toBoxShadow(rows, pal, cell)}`;
  wrap.appendChild(px);
  return wrap;
}

// Canvas: crisp at any integer scale, no resampling.
export function toCanvas(rows, pal, scale = 1) {
  const c = document.createElement('canvas');
  c.width = rows[0].length * scale;
  c.height = rows.length * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const col = pal[rows[y][x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}

export function toDataURL(rows, pal, scale = 1) {
  return toCanvas(rows, pal, scale).toDataURL('image/png');
}

// --- genetics --------------------------------------------------------------

// A creature's AlleleLedger is 6 pairs, in this order, written at hatch and never mutated.
export const TRAIT_ORDER = ['Body', 'Face', 'Rune', 'Collar', 'Ears', 'House'];

export function isHeterozygous(pair) { return pair[0] !== pair[1]; }
export function zygosity(pair) { return isHeterozygous(pair) ? 'HET' : 'HOM'; }

// The 6x2 pip bar: the same object at every size, from list rows to the Hall of Fame plaque.
export function pipBar(ledgerColors, cell = 7, doc = document) {
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'display:flex;gap:2px';
  const notch = Math.max(2, Math.round(cell / 3));
  ledgerColors.forEach(pair => {
    const het = isHeterozygous(pair);
    const col = doc.createElement('div');
    col.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    pair.forEach((c, i) => {
      const p = doc.createElement('div');
      p.style.cssText = `position:relative;width:${cell}px;height:${cell}px;background:${c};box-shadow:0 0 0 1px ${PALETTE.ink}` +
        (i === 1 && het ? ';opacity:0.55' : '');
      // Shape channel: heterozygous top pips carry a hard corner notch, so zygosity
      // reads without colour. Do not remove — six screens depend on this primitive.
      if (i === 0 && het) {
        const n = doc.createElement('div');
        n.style.cssText = `position:absolute;right:0;top:0;width:${notch}px;height:${notch}px;background:${PALETTE.ink}`;
        p.appendChild(n);
      }
      col.appendChild(p);
    });
    wrap.appendChild(col);
  });
  return wrap;
}

// --- effects ---------------------------------------------------------------

export const EFFECTS = {
  fireHit:     { frames: ['fireFx1', 'fireFx2'],     palette: 'fireFx',   ms: 240, anchor: 'chest' },
  earthHit:    { frames: ['earthFx1', 'earthFx2'],   palette: 'earthFx',  ms: 240, anchor: 'feet' },
  waterHit:    { frames: ['waterFx1', 'waterFx2'],   palette: 'waterFx',  ms: 240, anchor: 'chest' },
  poisonOn:    { frames: ['poisonFx1', 'poisonFx2'], palette: 'poisonFx', ms: 240, anchor: 'chest', loop: true },
  potionDrunk: { frames: ['potionFx1', 'potionFx2'], palette: 'potionFx', ms: 240, anchor: 'head' }
};

// --- season clock ----------------------------------------------------------

export const SEASON_DAYS = 30;

// The countdown chip is persistent on every screen. Mortality only lands if
// day N of 30 has been visible all month.
// PALETTE RULE: gold means "you can act on this" — the Orb, the primary button,
// locked picks, unspent attention. The season clock is the one escalation the
// player cannot act on, so it runs on its own desaturated warm ramp and
// escalates by DENSITY first (score lines, then cell height). Never use gold here.
export const CLOCK_RAMP = { open: '#5C5A62', closing: '#8A7A5E', final: '#A8704E' };

export function seasonPhase(day, total = SEASON_DAYS) {
  const left = total - day;
  if (left <= 2) return { key: 'final', label: 'FINAL DAYS', color: CLOCK_RAMP.final, density: 3 };
  if (left <= 7) return { key: 'closing', label: 'LAST WEEK', color: CLOCK_RAMP.closing, density: 2 };
  return { key: 'open', label: 'SEASON OPEN', color: CLOCK_RAMP.open, density: 1 };
}

// The persistent chip. density: 1 flat, 2 one score line, 3 two lines + taller cells.
export function seasonChip(day, total = SEASON_DAYS, doc = document) {
  const phase = seasonPhase(day, total);
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'display:flex;gap:2px;align-items:flex-end';
  for (let i = 0; i < total; i++) {
    const on = i < day;
    const cell = doc.createElement('div');
    const h = on && phase.density >= 3 ? 18 : 14;
    cell.style.cssText = `position:relative;width:6px;height:${h}px;background:${on ? phase.color : PALETTE.slab};box-shadow:0 0 0 1px ${PALETTE.ink}`;
    if (on && phase.density >= 2) {
      const l = doc.createElement('div');
      l.style.cssText = `position:absolute;left:0;right:0;top:4px;height:2px;background:${PALETTE.ink}`;
      cell.appendChild(l);
    }
    if (on && phase.density >= 3) {
      const l2 = doc.createElement('div');
      l2.style.cssText = `position:absolute;left:0;right:0;top:9px;height:2px;background:${PALETTE.ink}`;
      cell.appendChild(l2);
    }
    wrap.appendChild(cell);
  }
  return wrap;
}

// --- daily budgets ---------------------------------------------------------

export const DAILY_CARE = 3;        // attentions per day, hard cap
export const BOT_FIGHTS_COUNTED = 3; // unlimited bot fights, only 3 grow the juvenile
