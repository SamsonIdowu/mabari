// SPDX-License-Identifier: Apache-2.0
// Converted mechanically from design/mabari-prototype.html, so the pixels match exactly.
import {
  BASE_FLOOR,
  loungeBox,
  workDoorway,
  workWalls,
  LOUNGE_NOOK,
  deskTile,
  doorOf,
  LABEL_Y,
  LOUNGE_PITCH,
  type Floor,
  type Point,
  type Room,
} from './layout.ts';

export const PAL = {
  dark: {
    floorA: '#141416',
    floorB: '#17171A',
    plank: '#1E1E22',
    wallTop: '#26262A',
    wall: '#1B1B1E',
    wallLow: '#2A2A2F',
    wainscot: '#1B1B1E',
    base: '#0A0A0B',
    win: '#0E1622',
    winLite: '#16212F',
    star: '#E8E8EA',
    shaft: 'rgba(255,255,255,.035)',
    server: '#0E0E10',
    serverB: '#101012',
    carpet: '#1C1C20',
    carpetB: '#1E1E22',
    pantA: '#202024',
    pantB: '#232327',
    rug: '#202024',
    rugB: '#2A2A2F',
    desk: '#2C2C31',
    deskFront: '#1A1A1D',
    deskEdge: '#3A3A40',
    chair: '#0A0A0B',
    chairTop: '#26262A',
    metal: '#6B6B72',
    cab: '#2A2A2F',
    cabD: '#1A1A1D',
    shadow: 'rgba(0,0,0,.45)',
    night: '',
    vig: '',
    label: 'rgba(255,255,255,.28)',
    ink: '#EDEDEE',
    paper: '#2A2A2F',
    frame: '#3A3A40',
    art: '#121214',
    pot: '#E8E8EA',
    potD: '#BDBDC2',
    leaf: '#3E8A55',
    leafB: '#4FA868',
    wood: '#3A3A40',
    woodD: '#232327',
    glass: 'rgba(255,255,255,.06)',
  },
  light: {
    floorA: '#E7E6E3',
    floorB: '#E3E2DF',
    plank: '#D6D5D1',
    wallTop: '#FFFFFF',
    wall: '#F6F6F5',
    wallLow: '#DADAD7',
    wainscot: '#F6F6F5',
    base: '#1A1A1A',
    win: '#CFE0EC',
    winLite: '#E6F0F7',
    star: '#FFFFFF',
    shaft: 'rgba(255,255,255,.35)',
    server: '#CFCFCC',
    serverB: '#CBCBC8',
    carpet: '#DCDCD9',
    carpetB: '#D9D9D6',
    pantA: '#F1F1EF',
    pantB: '#EDEDEB',
    rug: '#D2D2CF',
    rugB: '#F4F4F2',
    desk: '#FBFBFA',
    deskFront: '#D9D9D6',
    deskEdge: '#FFFFFF',
    chair: '#141414',
    chairTop: '#2B2B2D',
    metal: '#9A9A9E',
    cab: '#F2F2F0',
    cabD: '#CFCFCC',
    shadow: 'rgba(0,0,0,.12)',
    night: '',
    vig: '',
    label: 'rgba(0,0,0,.32)',
    ink: '#111111',
    paper: '#FFFFFF',
    frame: '#111111',
    art: '#EDEDEB',
    pot: '#141414',
    potD: '#2B2B2D',
    leaf: '#3E8A55',
    leafB: '#57B072',
    wood: '#E4E4E1',
    woodD: '#C9C9C6',
    glass: 'rgba(255,255,255,.5)',
  },
};

type Ctx = CanvasRenderingContext2D;

export type Palette = (typeof PAL)['dark'] | (typeof PAL)['light'];

export function R(c: Ctx, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col;
  c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function ell(c: Ctx, x: number, y: number, rx: number, ry: number) {
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fill();
}

export function rrect(c: Ctx, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function blk(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  d: number,
  top: string,
  front: string,
  P: Palette,
  edge?: string,
) {
  c.fillStyle = P.shadow;
  c.fillRect(x + 3, y + h + d, w, 4);
  c.fillRect(x + w, y + 4, 3, h + d);
  R(c, x, y + h, w, d, front);
  R(c, x, y, w, h, top);
  R(c, x, y, w, 1, edge || 'rgba(255,255,255,.18)');
  R(c, x, y + h, w, 1, 'rgba(0,0,0,.18)');
}
function plant(c: Ctx, x: number, y: number, P: Palette) {
  R(c, x + 6, y + 18, 12, 1, 'rgba(0,0,0,.2)');
  blk(c, x + 6, y + 18, 12, 3, 9, P.pot, P.potD, P);
  c.fillStyle = P.leaf;
  ell(c, x + 12, y + 11, 9, 8);
  c.fillStyle = P.leafB;
  ell(c, x + 9, y + 7, 5, 5);
  ell(c, x + 15, y + 9, 4, 4);
  ell(c, x + 11, y + 13, 3, 3);
}
/** The back wall's height in world pixels. */
export const WALL = 44;
/** Where the server racks stand, in world pixels, before the rooms move along. */
export const RACKS = [966, 996, 1026, 1080, 1110, 1140];

/** The fabric of the lounge's armchairs: the prototype's library sofa's. */
export function sofaColours(theme: 'dark' | 'light') {
  return theme === 'dark'
    ? { top: '#2E2E33', front: '#1A1A1D', cushion: '#3A3A40' }
    : { top: '#2B2B2D', front: '#141414', cushion: '#4A4A4E' };
}

/** A label painted on the floor, letter spaced, in the prototype's style. */
export function floorLabel(c: Ctx, text: string, x: number, y: number, P: Palette) {
  c.font = '800 12px Nunito, sans-serif';
  c.fillStyle = P.label;
  c.fillText(text.split('').join(String.fromCharCode(8202)), x, y);
}

/**
 * A desk: a low partition behind it, a white top, a dark monitor and keyboard, a mug, a chair,
 * and one personal touch (a plant, a lamp or a stack of papers) picked by `touch`. x and y are
 * its corner.
 */
function desk(
  c: Ctx,
  x: number,
  y: number,
  theme: 'dark' | 'light',
  P: Palette,
  top = true,
  touch = 0,
) {
  if (top) {
    /* the partition between this desk and the one behind it */
    R(c, x + 2, y - 20, 64, 4, P.frame);
    R(c, x + 2, y - 20, 64, 1, 'rgba(255,255,255,.12)');
    R(c, x + 2, y - 16, 2, 14, P.frame);
    R(c, x + 64, y - 16, 2, 14, P.frame);
    blk(c, x + 4, y + 2, 60, 20, 12, P.desk, P.deskFront, P, P.deskEdge);
  }
  R(c, x + 8, y + 34, 2, 6, P.chair);
  R(c, x + 58, y + 34, 2, 6, P.chair);
  R(c, x + 29, y + 4, 6, 5, '#111113');
  R(c, x + 18, y - 12, 28, 18, '#111113');
  R(c, x + 20, y - 10, 24, 14, theme === 'dark' ? '#1C2430' : '#26303D');
  R(c, x + 20, y + 12, 22, 4, theme === 'dark' ? '#0E0E10' : '#1A1A1C');
  R(c, x + 48, y + 8, 8, 8, P.paper);
  R(c, x + 49, y + 9, 6, 6, theme === 'dark' ? '#3A3A40' : '#E7E6E3');
  if (top) {
    if (touch % 3 === 0) {
      /* a little plant */
      R(c, x + 8, y + 9, 6, 6, P.pot);
      R(c, x + 7, y + 4, 3, 5, P.leaf);
      R(c, x + 11, y + 3, 3, 6, P.leafB);
    } else if (touch % 3 === 1) {
      /* a desk lamp */
      R(c, x + 9, y + 13, 7, 2, P.metal);
      R(c, x + 11, y + 3, 2, 10, P.metal);
      R(c, x + 8, y + 1, 9, 4, theme === 'dark' ? '#E8E2D0' : '#2B2B2D');
    } else {
      /* a stack of papers */
      R(c, x + 7, y + 8, 10, 7, P.paper);
      R(c, x + 8, y + 6, 10, 7, theme === 'dark' ? '#3A3A40' : '#F4F4F2');
      R(c, x + 9, y + 8, 7, 1, P.metal);
    }
  }
  blk(c, x + 22, y + 42, 20, 8, 6, P.chairTop, P.chair, P);
}

/** Where the work area's two server racks stand, so scene.ts can blink their lights. */
export const WORK_RACKS = [10, 40];

/** What stands in the work area's back row after the server racks, and how wide each is. */
export type BackRowKind = 'shelf' | 'cabinets' | 'printer';
const BACK_ROW_KINDS: BackRowKind[] = ['shelf', 'cabinets', 'printer'];
const BACK_ROW_WIDTHS = [56, 64, 52];

/** How wide a piece of back row furniture is, so the trophy display can cover whole pieces. */
export function backRowWidth(kind: BackRowKind): number {
  return BACK_ROW_WIDTHS[BACK_ROW_KINDS.indexOf(kind)]!;
}

/**
 * Where the back row's furniture stands for a work area that ends at `end`: bookshelves, filing
 * cabinets and one printer, in turn, for as long as there is room. The trophy display takes the
 * furniture's places from the left, as many as it needs, so it asks for them here.
 */
export function backRow(end: number): { x: number; kind: BackRowKind }[] {
  const places: { x: number; kind: BackRowKind }[] = [];
  let x = 74;
  for (let index = 0; x + BACK_ROW_WIDTHS[index % BACK_ROW_KINDS.length]! <= end - 20; index++) {
    const kind = BACK_ROW_KINDS[index % BACK_ROW_KINDS.length]!;
    // One printer is enough: after it, shelves and cabinets.
    if (index >= BACK_ROW_KINDS.length && kind === 'printer') continue;
    places.push({ x, kind });
    x += BACK_ROW_WIDTHS[index % BACK_ROW_KINDS.length]! + 8;
  }
  return places;
}

/**
 * The work area, like an office: a carpet under the desks, a back row of server racks,
 * bookshelves, filing cabinets and a printer, and a front row with a water cooler, a whiteboard
 * and bins, leaving the door clear. Its desks are drawn after it.
 */
function drawWorkArea(c: Ctx, floor: Floor, theme: 'dark' | 'light', P: Palette) {
  const end = floor.workEnd + 24;
  const L = loungeColours(theme);
  /* office carpet under the desks, in large quiet tiles */
  R(c, 48, 104, end - 48, 490, P.carpet);
  R(c, 52, 108, end - 56, 482, P.carpetB);
  c.fillStyle = theme === 'dark' ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.035)';
  for (let x = 52 + 64; x < end - 4; x += 64) c.fillRect(x, 108, 1, 482);
  for (let y = 108 + 64; y < 590; y += 64) c.fillRect(52, y, end - 56, 1);

  /* the back row, under the wall: two server racks, then shelves, cabinets and a printer */
  for (const x of WORK_RACKS) {
    blk(
      c,
      x,
      52,
      26,
      6,
      44,
      theme === 'dark' ? '#202024' : '#2A2A2D',
      theme === 'dark' ? '#0C0C0E' : '#141416',
      P,
    );
    for (let slot = 0; slot < 5; slot++) {
      R(c, x + 3, 62 + slot * 8, 20, 5, theme === 'dark' ? '#18181B' : '#1E1E21');
    }
  }
  const row: { w: number; draw: (x: number) => void }[] = [
    {
      w: 56,
      draw: (x) => {
        /* a bookshelf of binders */
        blk(c, x, 54, 52, 6, 40, P.wood, P.woodD, P);
        for (let shelf = 0; shelf < 2; shelf++) {
          for (let book = 0; book < 7; book++) {
            R(c, x + 3 + book * 7, 63 + shelf * 17, 5, 13, L.spines[(book + shelf * 3) % 6]!);
          }
        }
      },
    },
    {
      w: 64,
      draw: (x) => {
        /* two filing cabinets */
        for (let cab = 0; cab < 2; cab++) {
          blk(c, x + cab * 30, 58, 28, 8, 36, P.cab, P.cabD, P);
          for (let drawer = 0; drawer < 3; drawer++) {
            R(c, x + cab * 30 + 2, 68 + drawer * 12, 24, 1, 'rgba(0,0,0,.18)');
            R(c, x + cab * 30 + 10, 72 + drawer * 12, 8, 2, P.metal);
          }
        }
      },
    },
    {
      w: 52,
      draw: (x) => {
        /* a printer on a low cabinet */
        blk(c, x, 74, 46, 8, 20, P.cab, P.cabD, P);
        blk(c, x + 6, 60, 34, 8, 14, P.desk, P.deskFront, P, P.deskEdge);
        R(c, x + 12, 62, 22, 3, theme === 'dark' ? '#0E0E10' : '#1A1A1C');
        R(c, x + 14, 56, 18, 5, P.paper);
        R(c, x + 34, 70, 3, 2, P.leafB);
      },
    },
  ];
  for (const place of backRow(end)) row[BACK_ROW_KINDS.indexOf(place.kind)]!.draw(place.x);

  /* the walls round the work area: glass partitions on its right and along its front, with a
     doorway facing Mabari's desk; the back wall closes it at the top */
  const walls = workWalls(floor);
  const doorway = workDoorway(floor);
  const glassWall = (x: number, y: number, w: number, h: number) => {
    R(c, x, y, w, h, P.glass);
    if (w > h) {
      R(c, x, y, w, 2, P.wallTop);
      R(c, x, y + h - 2, w, 2, P.wallLow);
    } else {
      R(c, x, y, 2, h, P.wallTop);
      R(c, x + w - 2, y, 2, h, P.wallLow);
    }
  };
  glassWall(walls.right - 4, WALL, 8, walls.front - WALL + 4);
  glassWall(0, walls.front - 4, doorway.in.x - 30, 8);
  glassWall(doorway.in.x + 30, walls.front - 4, walls.right + 4 - (doorway.in.x + 30), 8);
  /* posts either side of the doorway */
  R(c, doorway.in.x - 33, walls.front - 7, 4, 14, P.wallLow);
  R(c, doorway.in.x + 29, walls.front - 7, 4, 14, P.wallLow);

  /* the lobby, by the door: a water cooler, a whiteboard and bins, and plants */
  const door = doorOf(floor).x;
  blk(c, 14, 626, 18, 8, 26, P.cab, P.cabD, P);
  R(c, 16, 606, 14, 20, theme === 'dark' ? '#4E6B73' : '#BFD9E6');
  R(c, 16, 606, 14, 2, 'rgba(255,255,255,.4)');
  if (door - 140 > 60) {
    blk(c, 60, 610, 54, 30, 4, '#F4F4F2', '#C9C9C6', P);
    R(c, 66, 616, 22, 2, L.cushionA);
    R(c, 66, 622, 34, 2, P.metal);
    R(c, 66, 628, 16, 2, L.cushionB);
    R(c, 70, 644, 2, 18, P.metal);
    R(c, 102, 644, 2, 18, P.metal);
  }
  if (end - 40 > door + 90) {
    blk(c, end - 54, 640, 14, 8, 16, L.cushionA, L.beanD, P);
    blk(c, end - 36, 640, 14, 8, 16, P.metal, P.cabD, P);
  }
  plant(c, 6, 104, P);
  plant(c, end - 22, 104, P);
}

/** Where the lounge's moving parts are, so scene.ts can animate them over the background. */
export interface LoungeProps {
  /** The coffee machine's spout, where steam rises. */
  machine: Point;
  /** The floor lamp's shade, which glows. */
  lamp: Point;
  /** The fish tank's water, or null when the lounge is too small for one. */
  tank: { x: number; y: number; w: number; h: number } | null;
}

/** Where the lounge's furniture goes, as it grows with the number resting in it. */
export function loungeProps(floor: Floor): LoungeProps | null {
  const box = loungeBox(floor);
  if (!box) return null;
  const width = box.x1 - box.x0 - LOUNGE_NOOK;
  return {
    machine: { x: box.x0 + 25, y: box.y0 + 4 },
    lamp: { x: box.x1 - 30, y: box.y0 + 10 },
    tank: width >= 2 * LOUNGE_PITCH.x ? { x: box.x0 + 104, y: box.y0 + 6, w: 64, h: 22 } : null,
  };
}

/** The muted colours of the lounge's soft things: cushions, the beanbag, book spines. */
function loungeColours(theme: 'dark' | 'light') {
  return theme === 'dark'
    ? {
        cushionA: '#4E6B73',
        cushionB: '#6B5A4E',
        bean: '#3F4A5C',
        beanD: '#2C3442',
        water: '#1F3A47',
        sand: '#6B6050',
        spines: ['#4E6B73', '#6B5A4E', '#5B5B63', '#3F4A5C', '#7A7A82', '#58504A'],
        shade: '#E8E2D0',
      }
    : {
        cushionA: '#8FB3BD',
        cushionB: '#C9A98F',
        bean: '#9DB0C8',
        beanD: '#7D90A8',
        water: '#BFD9E6',
        sand: '#E3D6B8',
        spines: ['#8FB3BD', '#C9A98F', '#9A9A9E', '#9DB0C8', '#4A4A4E', '#B8A08A'],
        shade: '#FFF6DE',
      };
}

/**
 * The lounge: an open space with no boundary, with a coffee bar, a sofa and an armchair round a coffee table, a
 * floor lamp, a bookshelf and plants in its nook, and a fish tank and a beanbag once it is big
 * enough. It grows with the number resting in it. Its residents wander about it with their
 * coffee (scene.ts), which also brings the steam, the lamp's glow and the fish to life.
 */
function drawLounge(c: Ctx, floor: Floor, theme: 'dark' | 'light', P: Palette) {
  const box = loungeBox(floor)!;
  const props = loungeProps(floor)!;
  const L = loungeColours(theme);
  const sofa = sofaColours(theme);
  const { x0, y0, x1, y1 } = box;
  const width = x1 - x0;
  const seats = width - LOUNGE_NOOK;
  floorLabel(c, 'Lounge', x0, LABEL_Y, P);
  /* no rug, wall or border: the lounge's furniture stands on the open floor, so it reads as part
     of one free space the resting agents roam, with soft round rugs only under the tables */
  /* the coffee bar: a counter with the machine, a glass of pastries and a row of mugs */
  blk(c, x0 + 12, y0 + 18, 76, 10, 14, P.desk, P.deskFront, P, P.deskEdge);
  blk(
    c,
    props.machine.x - 9,
    y0 + 4,
    20,
    10,
    16,
    theme === 'dark' ? '#2A2A2F' : '#1E1E21',
    theme === 'dark' ? '#151518' : '#0E0E10',
    P,
  );
  R(c, props.machine.x - 3, y0 + 14, 8, 3, P.metal);
  R(c, props.machine.x + 6, y0 + 8, 3, 3, '#E8894A');
  R(c, x0 + 46, y0 + 12, 14, 9, P.glass);
  R(c, x0 + 46, y0 + 12, 14, 1, 'rgba(255,255,255,.35)');
  R(c, x0 + 49, y0 + 17, 4, 3, '#C9A06A');
  R(c, x0 + 54, y0 + 18, 4, 2, '#B98A55');
  [0, 1, 2].forEach((index) => {
    const mx = x0 + 64 + index * 7;
    R(c, mx, y0 + 18, 5, 5, [L.cushionA, P.paper, L.cushionB][index]!);
    R(c, mx + 5, y0 + 19, 1, 3, P.metal);
  });

  /* the fish tank, once there is room for it: water, sand, a plant; the fish swim in scene.ts */
  if (props.tank) {
    const { x, y, w, h } = props.tank;
    blk(c, x - 3, y + h, w + 6, 4, 10, P.wood, P.woodD, P);
    R(c, x - 2, y - 2, w + 4, h + 3, P.frame);
    R(c, x, y, w, h, L.water);
    R(c, x, y + h - 4, w, 4, L.sand);
    R(c, x + 8, y + h - 12, 2, 8, P.leaf);
    R(c, x + 11, y + h - 9, 2, 5, P.leafB);
    R(c, x + w - 14, y + h - 10, 2, 6, P.leaf);
    R(c, x, y, w, 1, 'rgba(255,255,255,.35)');
  }

  /*
   * Seating groups down the lounge, one for every two rows of it: a round rug with a low coffee
   * table (a book, a mug, a little vase), a sofa with cushions below it, and an armchair facing in.
   */
  const rows = Math.max(1, Math.round((y1 - y0 - 40) / LOUNGE_PITCH.y));
  const groups = Math.max(1, Math.floor(rows / 2));
  const span = (y1 - y0 - 50) / groups;
  for (let group = 0; group < groups; group++) {
    const cy = y0 + 50 + span * group + span / 2 - 14;
    const mid = { x: x0 + seats / 2 + (group % 2 ? 14 : -6), y: cy };
    c.fillStyle = theme === 'dark' ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)';
    c.beginPath();
    c.ellipse(mid.x, mid.y + 12, Math.min(seats / 2 - 10, 58), 26, 0, 0, Math.PI * 2);
    c.fill();
    blk(c, mid.x - 20, mid.y, 40, 12, 8, P.wood, P.woodD, P);
    R(c, mid.x - 14, mid.y + 3, 10, 6, group % 2 ? L.cushionB : L.cushionA);
    R(c, mid.x - 14, mid.y + 3, 10, 1, 'rgba(255,255,255,.3)');
    R(c, mid.x + 2, mid.y + 3, 5, 5, P.paper);
    R(c, mid.x + 11, mid.y - 2, 4, 8, P.pot);
    R(c, mid.x + 10, mid.y - 5, 2, 3, P.leafB);
    R(c, mid.x + 14, mid.y - 6, 2, 4, P.leaf);
    const sofaWidth = Math.min(seats - 60, 104);
    const sofaX = mid.x - sofaWidth / 2;
    blk(c, sofaX, mid.y + 26, sofaWidth, 12, 16, sofa.top, sofa.front, P);
    R(c, sofaX + 4, mid.y + 28, sofaWidth - 8, 6, sofa.cushion);
    R(c, sofaX + 8, mid.y + 20, 14, 9, L.cushionA);
    R(c, sofaX + sofaWidth - 22, mid.y + 20, 14, 9, L.cushionB);
    const chairX = group % 2 ? x0 + seats - 38 : x0 + 14;
    if (seats >= 2 * LOUNGE_PITCH.x || groups > 1) {
      blk(c, chairX, mid.y - 4, 24, 14, 16, sofa.top, sofa.front, P);
      R(c, chairX + 3, mid.y - 2, 18, 8, sofa.cushion);
    }
  }

  /* a beanbag by the coffee bar, once the lounge is deep enough */
  if (rows >= 3) {
    const bx = x0 + seats - 30;
    const by = y0 + 70;
    c.fillStyle = L.beanD;
    c.beginPath();
    c.ellipse(bx, by + 3, 15, 11, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = L.bean;
    c.beginPath();
    c.ellipse(bx - 1, by, 13, 9, 0, 0, Math.PI * 2);
    c.fill();
  }

  /* the nook: a floor lamp, a bookshelf and a big plant */
  const nook = x1 - LOUNGE_NOOK + 8;
  R(c, props.lamp.x, props.lamp.y + 6, 2, 34, P.metal);
  R(c, props.lamp.x - 5, props.lamp.y + 40, 12, 3, P.metal);
  R(c, props.lamp.x - 8, props.lamp.y - 2, 18, 9, L.shade);
  R(c, props.lamp.x - 8, props.lamp.y + 6, 18, 1, 'rgba(0,0,0,.15)');
  const shelfY = y0 + 64;
  if (shelfY + 46 < y1 - 40) {
    blk(c, nook + 6, shelfY, 44, 6, 40, P.wood, P.woodD, P);
    for (let row = 0; row < 2; row++) {
      for (let book = 0; book < 6; book++) {
        R(c, nook + 9 + book * 6, shelfY + 9 + row * 17, 4, 13, L.spines[(book + row * 2) % 6]!);
      }
    }
  }
  plant(c, nook + 22, y1 - 46, P);
  if (y1 - y0 > 300) plant(c, nook + 22, (y0 + y1) / 2 + 30, P);
  plant(c, x0 - 2, y1 - 30, P);
}

/** Where each room's floor runs, in tiles down from the back wall, and its walls in pixels. */
const ROOM_ROWS: Record<Room, { from: number; to: number; top: number; bottom: number }> = {
  server: { from: 1, to: 6, top: WALL, bottom: 7 * 32 + 6 },
  meeting: { from: 8, to: 11, top: 7 * 32 + 6, bottom: 12 * 32 + 6 },
  pantry: { from: 13, to: Infinity, top: 12 * 32 + 6, bottom: Infinity },
};

export function buildBg(theme: 'dark' | 'light', floor: Floor = BASE_FLOOR): HTMLCanvasElement {
  const W = floor.width;
  const H = floor.height;
  const shift = floor.shift;
  const cs = shift / 32;
  const roomAt = (rx: number, ty: number): Room | null => {
    if (rx < 30) return null;
    for (const room of floor.rooms) {
      const rows = ROOM_ROWS[room];
      if (ty >= rows.from && ty <= rows.to) return room;
    }
    return null;
  };
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  const P: Palette = PAL[theme];
  /* floor: large calm tiles, darker server room, soft carpet in meeting room, pale pantry. The
     floor starts under the back wall, so it shows from the wall's foot at y 44. A room's floor
     is drawn only while the room is in use. */
  for (let ty = 1; ty < Math.ceil(H / 32); ty++)
    for (let tx = 0; tx < Math.ceil(W / 32); tx++) {
      const n = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const v = (n % 4) / 250;
      const room = roomAt(tx - cs, ty);
      let col: string = P.floorA;
      if (room === 'server') col = P.server;
      else if (room === 'meeting') col = P.carpet;
      else if (room === 'pantry') col = (tx + ty) % 2 ? P.pantA : P.pantB;
      R(c, tx * 32, ty * 32, 32, 32, col);
      c.fillStyle = 'rgba(0,0,0,' + v + ')';
      c.fillRect(tx * 32, ty * 32, 32, 32);
      if (!room) {
        if (ty % 2 === 0) R(c, tx * 32, ty * 32, 32, 1, P.plank);
        if (tx % 2 === 0) R(c, tx * 32, ty * 32, 1, 32, P.plank);
      }
    }
  /* back wall: 44 px, clean, with no windows, prints or clock: the wall bar above the floor holds
     the projects and the clock now */
  R(c, 0, 0, W, WALL, P.wall);
  R(c, 0, 0, W, 4, P.wallTop);
  if (floor.rooms.length) drawRooms(c, floor, theme, P);
  /* the work area: its furniture, then a desk for each agent working at one, and one free desk */
  drawWorkArea(c, floor, theme, P);
  // The label sits on the carpet's front edge, clear of the shelves along the back.
  floorLabel(c, 'Work area', 60, 586, P);
  for (const index of floor.desks) {
    const dk = deskTile(index);
    desk(c, dk.x * 32, dk.y * 32, theme, P, true, index);
  }
  /* plants by the right hand wall, or by the glass wall in front of the rooms */
  const edge = (floor.wall ?? W) - 58;
  plant(c, edge, 3 * 32 + 4, P);
  plant(c, edge, 19 * 32 + 4, P);
  if (floor.lounge) drawLounge(c, floor, theme, P);
  const door = doorOf(floor).x;
  R(c, door - 32, H - 8, 64, 8, P.base);
  R(c, door - 28, H - 20, 56, 12, P.wallLow);
  return cv;
}

/** The rooms along the right wall that are in use, each behind its stretch of glass wall. */
function drawRooms(c: Ctx, floor: Floor, theme: 'dark' | 'light', P: Palette) {
  const H = floor.height;
  const has = (room: Room) => floor.rooms.includes(room);
  c.save();
  c.translate(floor.shift, 0);
  /* glass partition between the work floor and each room in use, with a gap to walk through */
  for (const room of floor.rooms) {
    const top = ROOM_ROWS[room].top;
    const bottom = Math.min(H, ROOM_ROWS[room].bottom);
    R(c, 29 * 32 + 12, top, 8, bottom - top, P.glass);
    R(c, 29 * 32 + 12, top, 1, bottom - top, P.wallLow);
    R(c, 29 * 32 + 19, top, 1, bottom - top, P.wallLow);
    [5, 10, 15, 19].forEach(function (gy) {
      const y = gy * 32 - 10;
      if (y > top && y + 58 < bottom) R(c, 29 * 32 + 10, y, 12, 58, P.floorA);
    });
  }
  const divider = (Y: number, gap: string) => {
    R(c, 30 * 32, Y, 8 * 32, 4, P.wallTop);
    R(c, 30 * 32, Y + 4, 8 * 32, 10, P.wallLow);
    R(c, 30 * 32, Y + 14, 8 * 32, 2, 'rgba(0,0,0,.12)');
    R(c, 32 * 32, Y, 48, 16, gap);
  };
  /* a wall closes each room in use at the top and the bottom */
  if (has('server') || has('meeting')) divider(7 * 32 + 6, has('meeting') ? P.carpet : P.floorA);
  if (has('meeting') || has('pantry')) divider(12 * 32 + 6, has('pantry') ? P.pantA : P.floorA);
  if (has('server')) {
    /* server racks: six, in two groups of three, inside the walls */
    for (const x2 of RACKS) {
      blk(
        c,
        x2,
        70,
        26,
        6,
        52,
        theme === 'dark' ? '#202024' : '#2A2A2D',
        theme === 'dark' ? '#0C0C0E' : '#141416',
        P,
      );
      for (let s2 = 0; s2 < 5; s2++)
        R(c, x2 + 3, 80 + s2 * 8, 20, 5, theme === 'dark' ? '#18181B' : '#1E1E21');
    }
  }
  if (has('meeting')) {
    for (let mx = 0; mx < 4; mx++)
      blk(c, 32 * 32 + mx * 32 - 6, 8 * 32 + 10, 20, 8, 8, P.chairTop, P.chair, P);
    blk(c, 31 * 32 + 12, 9 * 32 + 2, 4 * 32 + 8, 34, 10, P.desk, P.deskFront, P, P.deskEdge);
    R(c, 31 * 32 + 40, 9 * 32 + 10, 22, 14, P.paper);
    R(c, 31 * 32 + 40, 9 * 32 + 10, 22, 1, P.wallLow);
    R(c, 33 * 32 + 24, 9 * 32 + 12, 14, 10, P.paper);
    R(c, 34 * 32 + 20, 9 * 32 + 14, 10, 6, P.ink);
    for (let mx2 = 0; mx2 < 4; mx2++)
      blk(c, 32 * 32 + mx2 * 32 - 6, 10 * 32 + 20, 20, 8, 8, P.chairTop, P.chair, P);
  }
  if (has('pantry')) {
    blk(c, 30 * 32, 13 * 32 + 4, 8 * 32, 14, 20, P.desk, P.deskFront, P, P.deskEdge);
    blk(
      c,
      31 * 32,
      13 * 32 - 18,
      24,
      10,
      22,
      theme === 'dark' ? '#2A2A2F' : '#1E1E21',
      theme === 'dark' ? '#151518' : '#0E0E10',
      P,
    );
    R(c, 31 * 32 + 7, 13 * 32 - 4, 10, 6, '#E8894A');
    blk(c, 36 * 32 + 4, 12 * 32 + 10, 26, 10, 46, P.paper, P.deskFront, P);
    R(c, 36 * 32 + 26, 12 * 32 + 30, 2, 10, P.metal);
    blk(c, 33 * 32, 15 * 32, 40, 18, 10, P.wood, P.woodD, P);
    blk(c, 33 * 32, 18 * 32, 40, 18, 10, P.wood, P.woodD, P);
  }
  c.restore();
}
