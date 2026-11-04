// SPDX-License-Identifier: Apache-2.0
// Converted mechanically from design/mabari-prototype.html, so the pixels match exactly.
import { DESKS, H, W } from './layout.ts';

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

function blk(
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
export function buildBg(theme: 'dark' | 'light'): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  const P: Palette = PAL[theme];
  /* floor: large calm tiles, darker server room, soft carpet in meeting room, pale pantry */
  for (let ty = 2; ty < 18; ty++)
    for (let tx = 0; tx < 30; tx++) {
      const n = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const v = (n % 4) / 250;
      let col: string = P.floorA;
      if (tx >= 22 && ty >= 2 && ty <= 6) col = P.server;
      else if (tx >= 22 && ty >= 8 && ty <= 11) col = P.carpet;
      else if (tx >= 22 && ty >= 13) col = (tx + ty) % 2 ? P.pantA : P.pantB;
      R(c, tx * 32, ty * 32, 32, 32, col);
      c.fillStyle = 'rgba(0,0,0,' + v + ')';
      c.fillRect(tx * 32, ty * 32, 32, 32);
      if (tx < 21) {
        if (ty % 2 === 0) R(c, tx * 32, ty * 32, 32, 1, P.plank);
        if (tx % 2 === 0) R(c, tx * 32, ty * 32, 1, 32, P.plank);
      }
    }
  /* back wall: clean, thin dark skirting */
  R(c, 0, 0, W, 64, P.wall);
  R(c, 0, 0, W, 4, P.wallTop);
  R(c, 0, 60, W, 4, P.base);
  c.fillStyle = 'rgba(0,0,0,.14)';
  c.fillRect(0, 64, W, 5);
  c.fillStyle = 'rgba(0,0,0,.06)';
  c.fillRect(0, 69, W, 6);
  for (let wx = 15; wx < 20; wx += 2) {
    const X = wx * 32;
    R(c, X + 2, 8, 60, 46, P.frame);
    R(c, X + 4, 10, 56, 42, P.win);
    R(c, X + 4, 10, 56, 12, P.winLite);
    R(c, X + 31, 10, 2, 42, P.frame);
    if (theme === 'dark') {
      R(c, X + 12, 18, 2, 2, P.star);
      R(c, X + 46, 15, 2, 2, P.star);
      R(c, X + 38, 40, 2, 2, P.star);
    }
    c.fillStyle = P.shaft;
    c.beginPath();
    c.moveTo(X + 5, 64);
    c.lineTo(X + 59, 64);
    c.lineTo(X + 100, 250);
    c.lineTo(X + 22, 250);
    c.closePath();
    c.fill();
  }
  /* whiteboard behind the notice board overlay */
  R(c, 8 * 32 - 4, 6, 6 * 32 + 8, 48, P.frame);
  R(c, 8 * 32 - 1, 9, 6 * 32 + 2, 42, P.paper);
  /* clock */
  c.fillStyle = P.frame;
  ell(c, 21 * 32 - 20, 28, 11, 11);
  c.fillStyle = P.paper;
  ell(c, 21 * 32 - 20, 28, 9, 9);
  R(c, 21 * 32 - 21, 21, 2, 8, P.ink);
  R(c, 21 * 32 - 21, 27, 7, 2, P.ink);
  /* framed monochrome prints and the wordmark */
  [
    [6 * 32 + 6, 14],
    [7 * 32 + 2, 20],
  ].forEach(function (f, i) {
    R(c, f[0]! - 2, f[1]! - 2, i ? 18 : 22, i ? 22 : 28, P.frame);
    R(c, f[0]!, f[1]!, i ? 14 : 18, i ? 18 : 24, P.art);
    c.fillStyle = P.ink;
    if (i) ell(c, f[0]! + 7, f[1]! + 9, 4, 4);
    else {
      c.beginPath();
      c.moveTo(f[0]! + 2, f[1]! + 20);
      c.lineTo(f[0]! + 9, f[1]! + 8);
      c.lineTo(f[0]! + 16, f[1]! + 20);
      c.closePath();
      c.fill();
    }
  });
  c.font = '900 20px Nunito, sans-serif';
  c.fillStyle = P.ink;
  c.fillText('mabari', 22 * 32 + 14, 36);
  R(c, 22 * 32 + 14, 42, 44, 2, P.ink);
  /* storage cabinets */
  for (let fx = 1; fx < 6; fx++) {
    const x = fx * 32;
    blk(c, x + 2, 58, 28, 8, 44, P.cab, P.cabD, P);
    for (let d = 0; d < 3; d++) {
      R(c, x + 4, 70 + d * 14, 24, 1, 'rgba(0,0,0,.18)');
      R(c, x + 12, 74 + d * 14, 8, 2, P.metal);
    }
  }
  plant(c, 6, 104, P);
  /* glass partition between the work floor and the rooms */
  R(c, 21 * 32 + 12, 64, 8, H - 64, P.glass);
  R(c, 21 * 32 + 12, 64, 1, H - 64, P.wallLow);
  R(c, 21 * 32 + 19, 64, 1, H - 64, P.wallLow);
  [5, 10, 15].forEach(function (gy) {
    R(c, 21 * 32 + 10, gy * 32 - 10, 12, 58, P.floorA);
  });
  [7, 12].forEach(function (ry) {
    const Y = ry * 32 + 6;
    R(c, 22 * 32, Y, 8 * 32, 4, P.wallTop);
    R(c, 22 * 32, Y + 4, 8 * 32, 10, P.wallLow);
    R(c, 22 * 32, Y + 14, 8 * 32, 2, 'rgba(0,0,0,.12)');
    R(c, 24 * 32, Y, 48, 16, ry === 7 ? P.carpet : P.pantA);
  });
  /* server racks */
  for (let sx = 22; sx < 30; sx++) {
    if (sx === 25) continue;
    const x2 = sx * 32;
    blk(
      c,
      x2 + 3,
      54,
      26,
      6,
      58,
      theme === 'dark' ? '#202024' : '#2A2A2D',
      theme === 'dark' ? '#0C0C0E' : '#141416',
      P,
    );
    for (let s2 = 0; s2 < 6; s2++)
      R(c, x2 + 6, 64 + s2 * 8, 20, 5, theme === 'dark' ? '#18181B' : '#1E1E21');
  }
  /* meeting room */
  for (let mx = 0; mx < 4; mx++)
    blk(c, 24 * 32 + mx * 32 - 6, 8 * 32 + 10, 20, 8, 8, P.chairTop, P.chair, P);
  blk(c, 23 * 32 + 12, 9 * 32 + 2, 4 * 32 + 8, 34, 10, P.desk, P.deskFront, P, P.deskEdge);
  R(c, 23 * 32 + 40, 9 * 32 + 10, 22, 14, P.paper);
  R(c, 23 * 32 + 40, 9 * 32 + 10, 22, 1, P.wallLow);
  R(c, 25 * 32 + 24, 9 * 32 + 12, 14, 10, P.paper);
  R(c, 26 * 32 + 20, 9 * 32 + 14, 10, 6, P.ink);
  for (let mx2 = 0; mx2 < 4; mx2++)
    blk(c, 24 * 32 + mx2 * 32 - 6, 10 * 32 + 20, 20, 8, 8, P.chairTop, P.chair, P);
  /* pantry */
  blk(c, 22 * 32, 13 * 32 + 4, 8 * 32, 14, 20, P.desk, P.deskFront, P, P.deskEdge);
  blk(
    c,
    23 * 32,
    13 * 32 - 18,
    24,
    10,
    22,
    theme === 'dark' ? '#2A2A2F' : '#1E1E21',
    theme === 'dark' ? '#151518' : '#0E0E10',
    P,
  );
  R(c, 23 * 32 + 7, 13 * 32 - 4, 10, 6, '#E8894A');
  blk(c, 28 * 32 + 4, 12 * 32 + 10, 26, 10, 46, P.paper, P.deskFront, P);
  R(c, 28 * 32 + 26, 12 * 32 + 30, 2, 10, P.metal);
  blk(c, 25 * 32, 15 * 32, 40, 18, 10, P.wood, P.woodD, P);
  /* library corner: soft rug, shelves with muted spines, sofa */
  R(c, 1 * 32, 12 * 32 + 14, 6 * 32, 4 * 32, P.rug);
  R(c, 1 * 32 + 6, 12 * 32 + 20, 6 * 32 - 12, 4 * 32 - 12, P.rugB);
  const spines =
    theme === 'dark'
      ? ['#3A3A40', '#5B5B63', '#2A2A2F', '#E8E8EA', '#7A7A82', '#4A4A52']
      : ['#1A1A1A', '#9A9A9E', '#E4E4E1', '#4A4A4E', '#C9C9C6', '#2B2B2D'];
  for (let bx = 1; bx < 7; bx++) {
    const x3 = bx * 32;
    blk(c, x3, 11 * 32 - 16, 32, 6, 40, P.wood, P.woodD, P);
    for (let bk = 0; bk < 6; bk++) {
      R(c, x3 + 3 + bk * 5, 11 * 32 - 6, 4, 13, spines[(bk + bx) % 6]!);
      R(c, x3 + 3 + bk * 5, 11 * 32 + 10, 4, 12, spines[(bk + bx + 3) % 6]!);
    }
  }
  R(c, 0, 13 * 32 + 6, 10, 48, P.frame);
  blk(
    c,
    5 * 32 + 8,
    14 * 32 + 6,
    36,
    14,
    16,
    theme === 'dark' ? '#2E2E33' : '#2B2B2D',
    theme === 'dark' ? '#1A1A1D' : '#141414',
    P,
  );
  plant(c, 24, 15 * 32 + 6, P);
  /* desks: white tops, black chairs, dark monitors */
  DESKS.forEach(function (dk) {
    const x = dk.x * 32,
      y = dk.y * 32;
    blk(c, x + 4, y + 2, 60, 20, 12, P.desk, P.deskFront, P, P.deskEdge);
    R(c, x + 8, y + 34, 2, 6, P.chair);
    R(c, x + 58, y + 34, 2, 6, P.chair);
    R(c, x + 29, y + 4, 6, 5, '#111113');
    R(c, x + 18, y - 12, 28, 18, '#111113');
    R(c, x + 20, y - 10, 24, 14, theme === 'dark' ? '#1C2430' : '#26303D');
    R(c, x + 20, y + 12, 22, 4, theme === 'dark' ? '#0E0E10' : '#1A1A1C');
    R(c, x + 48, y + 8, 8, 8, P.paper);
    R(c, x + 49, y + 9, 6, 6, theme === 'dark' ? '#3A3A40' : '#E7E6E3');
    blk(c, x + 22, y + 42, 20, 8, 6, P.chairTop, P.chair, P);
  });
  [
    [20, 3],
    [20, 16],
    [7, 16],
  ].forEach(function (p) {
    plant(c, p[0]! * 32 + 6, p[1]! * 32 + 4, P);
  });
  R(c, 14 * 32, H - 8, 64, 8, P.base);
  R(c, 14 * 32 + 4, H - 20, 56, 12, P.wallLow);
  return cv;
}
