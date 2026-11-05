// SPDX-License-Identifier: Apache-2.0
// Converted mechanically from design/mabari-prototype.html, so the pixels match exactly.
import { BenchColumns, BenchPitchX, BenchPitchY } from '../gen/models.ts';
import { BASE_FLOOR, BENCH_WIDTH, deskTile, LOUNGE_PITCH, type Floor } from './layout.ts';

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

/** The fabric of the lounge's armchairs: the library sofa's, so the rooms match. */
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

/** A desk: white top, dark monitor, a mug and a chair. x and y are its corner. */
function desk(c: Ctx, x: number, y: number, theme: 'dark' | 'light', P: Palette, top = true) {
  if (top) blk(c, x + 4, y + 2, 60, 20, 12, P.desk, P.deskFront, P, P.deskEdge);
  R(c, x + 8, y + 34, 2, 6, P.chair);
  R(c, x + 58, y + 34, 2, 6, P.chair);
  R(c, x + 29, y + 4, 6, 5, '#111113');
  R(c, x + 18, y - 12, 28, 18, '#111113');
  R(c, x + 20, y - 10, 24, 14, theme === 'dark' ? '#1C2430' : '#26303D');
  R(c, x + 20, y + 12, 22, 4, theme === 'dark' ? '#0E0E10' : '#1A1A1C');
  R(c, x + 48, y + 8, 8, 8, P.paper);
  R(c, x + 49, y + 9, 6, 6, theme === 'dark' ? '#3A3A40' : '#E7E6E3');
  blk(c, x + 22, y + 42, 20, 8, 6, P.chairTop, P.chair, P);
}

/** The workflow sub-agents' hot desks: long benches, four seats a row, each with a monitor. */
function drawBenches(c: Ctx, floor: Floor, theme: 'dark' | 'light', P: Palette) {
  const bench = floor.bench!;
  const lower = floor.lower!;
  const bottom = bench.y + (bench.rows - 1) * BenchPitchY + 74;
  R(c, bench.x - 24, lower + 32, BENCH_WIDTH + 48, bottom - lower - 32, P.carpet);
  R(c, bench.x - 18, lower + 38, BENCH_WIDTH + 36, bottom - lower - 44, P.carpetB);
  floorLabel(c, 'Workflow sub-agents', bench.x - 16, lower + 24, P);
  for (let row = 0; row < bench.rows; row++) {
    const y = bench.y + row * BenchPitchY;
    blk(c, bench.x + 4, y + 2, BENCH_WIDTH - 8, 20, 12, P.desk, P.deskFront, P, P.deskEdge);
    for (let seat = 0; seat < BenchColumns; seat++) {
      desk(c, bench.x + seat * BenchPitchX, y, theme, P, false);
    }
  }
}

/** One armchair's back and arms. The seat front is drawn over the sitter, in the scene. */
function armchair(c: Ctx, x: number, y: number, theme: 'dark' | 'light', P: Palette) {
  const sofa = sofaColours(theme);
  blk(c, x - 20, y - 38, 40, 12, 14, sofa.top, sofa.front, P);
  blk(c, x - 25, y - 24, 7, 10, 12, sofa.top, sofa.front, P);
  blk(c, x + 18, y - 24, 7, 10, 12, sofa.top, sofa.front, P);
  R(c, x - 18, y - 14, 36, 8, sofa.cushion);
}

/** The lounge: soft rugs with a row of armchairs each, side tables and plants. */
function drawLounge(c: Ctx, floor: Floor, theme: 'dark' | 'light', P: Palette) {
  const lounge = floor.lounge!;
  const lower = floor.lower!;
  const width = lounge.columns * LOUNGE_PITCH.x;
  floorLabel(c, 'Lounge', lounge.x, lower + 24, P);
  for (let row = 0; row < lounge.rows; row++) {
    const y = lounge.first.y + row * LOUNGE_PITCH.y;
    R(c, lounge.x - 4, y - 50, width + 8, 64, P.rug);
    R(c, lounge.x + 2, y - 44, width - 4, 52, P.rugB);
    for (let column = 0; column < lounge.columns; column++) {
      const x = lounge.first.x + column * LOUNGE_PITCH.x;
      armchair(c, x, y, theme, P);
      if (column < lounge.columns - 1) {
        blk(c, x + LOUNGE_PITCH.x / 2 - 9, y - 22, 18, 10, 8, P.wood, P.woodD, P);
        if ((row + column) % 3 === 0) R(c, x + LOUNGE_PITCH.x / 2 - 3, y - 26, 6, 5, P.paper);
      }
    }
  }
  plant(c, lounge.x + width - 4, lower + 6, P);
}

export function buildBg(theme: 'dark' | 'light', floor: Floor = BASE_FLOOR): HTMLCanvasElement {
  const W = floor.width;
  const H = floor.height;
  const shift = floor.shift;
  const cs = shift / 32;
  const lowerTile = floor.lower === null ? Infinity : floor.lower / 32;
  /* the rooms end where the lower floor starts, behind a wall like the ones between them */
  const roomsEnd = floor.lower === null ? H : floor.lower - 16;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  const P: Palette = PAL[theme];
  /* floor: large calm tiles, darker server room, soft carpet in meeting room, pale pantry. The
     floor starts under the back wall, so it shows from the wall's foot at y 44. */
  for (let ty = 1; ty < Math.ceil(H / 32); ty++)
    for (let tx = 0; tx < Math.ceil(W / 32); tx++) {
      const n = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const v = (n % 4) / 250;
      const rx = tx - cs;
      const rooms = rx >= 30 && ty < lowerTile;
      let col: string = P.floorA;
      if (rooms && ty >= 1 && ty <= 6) col = P.server;
      else if (rooms && ty >= 8 && ty <= 11) col = P.carpet;
      else if (rooms && ty >= 13) col = (tx + ty) % 2 ? P.pantA : P.pantB;
      R(c, tx * 32, ty * 32, 32, 32, col);
      c.fillStyle = 'rgba(0,0,0,' + v + ')';
      c.fillRect(tx * 32, ty * 32, 32, 32);
      if (rx < 29 || ty >= lowerTile) {
        if (ty % 2 === 0) R(c, tx * 32, ty * 32, 32, 1, P.plank);
        if (tx % 2 === 0) R(c, tx * 32, ty * 32, 1, 32, P.plank);
      }
    }
  /* back wall: 44 px, clean, with no windows, prints or clock: the wall bar above the floor holds
     the projects and the clock now */
  R(c, 0, 0, W, WALL, P.wall);
  R(c, 0, 0, W, 4, P.wallTop);
  /* storage cabinets, standing below the wall */
  for (let fx = 1; fx < 6; fx++) {
    const x = fx * 32;
    blk(c, x + 2, 68, 28, 8, 40, P.cab, P.cabD, P);
    for (let d = 0; d < 3; d++) {
      R(c, x + 4, 78 + d * 13, 24, 1, 'rgba(0,0,0,.18)');
      R(c, x + 12, 82 + d * 13, 8, 2, P.metal);
    }
  }
  plant(c, 6, 104, P);
  /* the rooms on the right, moved along by the grid's extra columns */
  c.save();
  c.translate(shift, 0);
  /* glass partition between the work floor and the rooms */
  R(c, 29 * 32 + 12, WALL, 8, roomsEnd - WALL, P.glass);
  R(c, 29 * 32 + 12, WALL, 1, roomsEnd - WALL, P.wallLow);
  R(c, 29 * 32 + 19, WALL, 1, roomsEnd - WALL, P.wallLow);
  [5, 10, 15, 19].forEach(function (gy) {
    if (gy * 32 + 48 < roomsEnd) R(c, 29 * 32 + 10, gy * 32 - 10, 12, 58, P.floorA);
  });
  const divider = (Y: number, gap: string) => {
    R(c, 30 * 32, Y, 8 * 32, 4, P.wallTop);
    R(c, 30 * 32, Y + 4, 8 * 32, 10, P.wallLow);
    R(c, 30 * 32, Y + 14, 8 * 32, 2, 'rgba(0,0,0,.12)');
    R(c, 32 * 32, Y, 48, 16, gap);
  };
  [7, 12].forEach(function (ry) {
    divider(ry * 32 + 6, ry === 7 ? P.carpet : P.pantA);
  });
  if (floor.lower !== null) divider(roomsEnd, P.floorA);
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
  /* meeting room */
  for (let mx = 0; mx < 4; mx++)
    blk(c, 32 * 32 + mx * 32 - 6, 8 * 32 + 10, 20, 8, 8, P.chairTop, P.chair, P);
  blk(c, 31 * 32 + 12, 9 * 32 + 2, 4 * 32 + 8, 34, 10, P.desk, P.deskFront, P, P.deskEdge);
  R(c, 31 * 32 + 40, 9 * 32 + 10, 22, 14, P.paper);
  R(c, 31 * 32 + 40, 9 * 32 + 10, 22, 1, P.wallLow);
  R(c, 33 * 32 + 24, 9 * 32 + 12, 14, 10, P.paper);
  R(c, 34 * 32 + 20, 9 * 32 + 14, 10, 6, P.ink);
  for (let mx2 = 0; mx2 < 4; mx2++)
    blk(c, 32 * 32 + mx2 * 32 - 6, 10 * 32 + 20, 20, 8, 8, P.chairTop, P.chair, P);
  /* pantry */
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
  c.restore();
  /* library corner: soft rug, shelves with muted spines, sofa */
  R(c, 1 * 32, 16 * 32 + 14, 5 * 32, 4 * 32, P.rug);
  R(c, 1 * 32 + 6, 16 * 32 + 20, 5 * 32 - 12, 4 * 32 - 12, P.rugB);
  const spines =
    theme === 'dark'
      ? ['#3A3A40', '#5B5B63', '#2A2A2F', '#E8E8EA', '#7A7A82', '#4A4A52']
      : ['#1A1A1A', '#9A9A9E', '#E4E4E1', '#4A4A4E', '#C9C9C6', '#2B2B2D'];
  for (let bx = 1; bx < 6; bx++) {
    const x3 = bx * 32;
    blk(c, x3, 15 * 32 - 16, 32, 6, 40, P.wood, P.woodD, P);
    for (let bk = 0; bk < 6; bk++) {
      R(c, x3 + 3 + bk * 5, 15 * 32 - 6, 4, 13, spines[(bk + bx) % 6]!);
      R(c, x3 + 3 + bk * 5, 15 * 32 + 10, 4, 12, spines[(bk + bx + 3) % 6]!);
    }
  }
  R(c, 0, 17 * 32 + 6, 10, 48, P.frame);
  const sofa = sofaColours(theme);
  blk(c, 4 * 32 + 8, 18 * 32 + 6, 36, 14, 16, sofa.top, sofa.front, P);
  plant(c, 24, 19 * 32 + 6, P);
  /* desks: white tops, black chairs, dark monitors, as many as the grid has */
  for (let index = 0; index < floor.side * floor.side; index++) {
    const dk = deskTile(index);
    desk(c, dk.x * 32, dk.y * 32, theme, P);
  }
  [
    [27 + cs, 3],
    [27 + cs, 19],
    [5, 9],
    [5, 12],
  ].forEach(function (p) {
    if (floor.lower === null || p[1]! * 32 + 30 < floor.lower)
      plant(c, p[0]! * 32 + 6, p[1]! * 32 + 4, P);
  });
  if (floor.bench) drawBenches(c, floor, theme, P);
  if (floor.lounge) drawLounge(c, floor, theme, P);
  R(c, W / 2 - 32, H - 8, 64, 8, P.base);
  R(c, W / 2 - 28, H - 20, 56, 12, P.wallLow);
  return cv;
}
