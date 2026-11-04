// SPDX-License-Identifier: Apache-2.0
// Converted mechanically from design/mabari-prototype.html, so the pixels match exactly.
import { DESKS, H, W } from './layout.ts';

export const PAL = {
  dark: {
    floorA: '#3A2F2C',
    floorB: '#3F332E',
    plank: '#30272A',
    wallTop: '#4A4268',
    wall: '#332D4C',
    wallLow: '#2A2540',
    wainscot: '#3A3352',
    base: '#1C1829',
    win: '#1B2B4D',
    winLite: '#2D4678',
    star: '#E8E3FF',
    shaft: 'rgba(140,170,255,.07)',
    server: '#2A2C33',
    serverB: '#2E3038',
    carpet: '#2C3C3F',
    carpetB: '#304346',
    pantA: '#4A4652',
    pantB: '#504C59',
    rug: '#5B2F3A',
    rugB: '#6A3A45',
    desk: '#8E623F',
    deskFront: '#6A4529',
    deskEdge: '#A57650',
    chair: '#3F3A58',
    chairTop: '#4E4870',
    metal: '#9AA0AE',
    cab: '#8A8F9C',
    cabD: '#666B78',
    shadow: 'rgba(0,0,0,.32)',
    night: 'rgba(12,10,40,.22)',
    vig: 'rgba(0,0,0,.38)',
  },
  light: {
    floorA: '#D9BE98',
    floorB: '#DDC4A0',
    plank: '#C9AC85',
    wallTop: '#D8D2EA',
    wall: '#C3BBD9',
    wallLow: '#B3AACD',
    wainscot: '#BDB4D4',
    base: '#8E85AD',
    win: '#9FD3F2',
    winLite: '#D2EEFC',
    star: '#FFFFFF',
    shaft: 'rgba(255,250,220,.24)',
    server: '#8F94A0',
    serverB: '#979CA8',
    carpet: '#8FB9B4',
    carpetB: '#97C1BC',
    pantA: '#ECE8F0',
    pantB: '#E2DDE8',
    rug: '#B65A62',
    rugB: '#C2666E',
    desk: '#B57E52',
    deskFront: '#8E5E38',
    deskEdge: '#C9946A',
    chair: '#6E6790',
    chairTop: '#857DA8',
    metal: '#B5BAC6',
    cab: '#A7ACB8',
    cabD: '#848A97',
    shadow: 'rgba(60,30,0,.2)',
    night: '',
    vig: 'rgba(60,40,20,.14)',
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
  c.fillRect(x + 4, y + h + d, w, 5);
  c.fillRect(x + w, y + 5, 4, h + d);
  R(c, x, y + h, w, d, front);
  R(c, x, y, w, h, top);
  R(c, x, y, w, 1, edge || 'rgba(255,255,255,.2)');
  R(c, x, y + h, w, 1, 'rgba(0,0,0,.2)');
}
function plant(c: Ctx, x: number, y: number, P: Palette) {
  blk(c, x + 4, y + 20, 16, 4, 10, '#B5653F', '#8A4A2C', P);
  c.fillStyle = '#3E8A55';
  ell(c, x + 12, y + 12, 11, 10);
  c.fillStyle = '#4FA868';
  ell(c, x + 9, y + 8, 6, 6);
  ell(c, x + 16, y + 11, 5, 5);
}
export function buildBg(theme: 'dark' | 'light'): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  const P: Palette = PAL[theme];
  for (let ty = 2; ty < 18; ty++)
    for (let tx = 0; tx < 30; tx++) {
      const n = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const v = (n % 6) / 100;
      let col = (tx + ty) % 2 ? P.floorA : P.floorB;
      if (tx >= 22 && ty >= 2 && ty <= 6) col = (tx + ty) % 2 ? P.server : P.serverB;
      else if (tx >= 22 && ty >= 8 && ty <= 11) col = (tx + ty) % 2 ? P.carpet : P.carpetB;
      else if (tx >= 22 && ty >= 13) col = (tx + ty) % 2 ? P.pantA : P.pantB;
      R(c, tx * 32, ty * 32, 32, 32, col);
      c.fillStyle = 'rgba(0,0,0,' + v + ')';
      c.fillRect(tx * 32, ty * 32, 32, 32);
      if (tx < 21) {
        R(c, tx * 32, ty * 32 + 31, 32, 1, P.plank);
        if ((tx + ty) % 3 === 0) R(c, tx * 32 + 15, ty * 32, 1, 32, P.plank);
      }
    }
  R(c, 0, 0, W, 64, P.wall);
  R(c, 0, 0, W, 8, P.wallTop);
  R(c, 0, 36, W, 22, P.wainscot);
  for (let wx0 = 0; wx0 < W; wx0 += 48) R(c, wx0, 38, 1, 18, P.wallLow);
  R(c, 0, 36, W, 2, P.wallTop);
  R(c, 0, 58, W, 6, P.base);
  c.fillStyle = 'rgba(0,0,0,.24)';
  c.fillRect(0, 64, W, 8);
  c.fillStyle = 'rgba(0,0,0,.1)';
  c.fillRect(0, 72, W, 8);
  for (let wx = 15; wx < 20; wx += 2) {
    const X = wx * 32;
    R(c, X + 2, 8, 60, 46, P.base);
    R(c, X + 5, 11, 54, 40, P.win);
    R(c, X + 5, 11, 54, 14, P.winLite);
    R(c, X + 31, 11, 2, 40, P.base);
    R(c, X + 5, 30, 54, 2, P.base);
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
  R(c, 8 * 32 - 4, 4, 6 * 32 + 8, 52, '#6B4A2C');
  R(c, 8 * 32, 8, 6 * 32, 44, '#C49A64');
  c.fillStyle = '#E8E3D6';
  ell(c, 21 * 32 - 20, 28, 10, 10);
  R(c, 21 * 32 - 21, 20, 2, 9, '#333');
  R(c, 21 * 32 - 21, 27, 7, 2, '#333');
  for (let fx = 1; fx < 6; fx++) {
    const x = fx * 32;
    blk(c, x + 2, 58, 28, 8, 44, P.cab, P.cabD, P);
    for (let d = 0; d < 3; d++) {
      R(c, x + 4, 70 + d * 14, 24, 1, 'rgba(0,0,0,.25)');
      R(c, x + 12, 74 + d * 14, 8, 3, P.metal);
    }
  }
  plant(c, 6, 104, P);
  R(c, 21 * 32 + 10, 64, 12, H - 64, P.wallLow);
  R(c, 21 * 32 + 10, 64, 12, 4, P.wallTop);
  [5, 10, 15].forEach(function (gy) {
    R(c, 21 * 32 + 10, gy * 32 - 10, 12, 58, gy % 2 ? P.floorA : P.floorB);
  });
  [7, 12].forEach(function (ry) {
    const Y = ry * 32 + 6;
    R(c, 22 * 32, Y, 8 * 32, 6, P.wallTop);
    R(c, 22 * 32, Y + 6, 8 * 32, 14, P.wallLow);
    R(c, 24 * 32, Y, 48, 20, ry === 7 ? P.carpet : P.pantA);
  });
  for (let sx = 22; sx < 30; sx++) {
    if (sx === 25) continue;
    const x2 = sx * 32;
    blk(c, x2 + 3, 54, 26, 6, 58, '#3A3C45', '#1C1D22', P);
    for (let s2 = 0; s2 < 6; s2++) R(c, x2 + 6, 64 + s2 * 8, 20, 5, '#2B2D35');
  }
  for (let mx = 0; mx < 4; mx++)
    blk(c, 24 * 32 + mx * 32 - 6, 8 * 32 + 10, 20, 8, 8, P.chairTop, P.chair, P);
  blk(c, 23 * 32 + 12, 9 * 32 + 2, 4 * 32 + 8, 34, 10, '#8A6447', '#5E422E', P);
  R(c, 23 * 32 + 40, 9 * 32 + 10, 22, 14, '#EFEBE0');
  R(c, 25 * 32 + 24, 9 * 32 + 12, 14, 10, '#EFEBE0');
  R(c, 26 * 32 + 20, 9 * 32 + 14, 10, 6, '#7CCFE0');
  for (let mx2 = 0; mx2 < 4; mx2++)
    blk(c, 24 * 32 + mx2 * 32 - 6, 10 * 32 + 20, 20, 8, 8, P.chairTop, P.chair, P);
  blk(c, 22 * 32, 13 * 32 + 4, 8 * 32, 14, 20, '#D3D6DE', '#9EA2AD', P);
  blk(c, 23 * 32, 13 * 32 - 18, 24, 10, 22, '#4A4A55', '#2E2E36', P);
  R(c, 23 * 32 + 7, 13 * 32 - 4, 10, 6, '#E8894A');
  blk(c, 28 * 32 + 4, 12 * 32 + 10, 26, 10, 46, '#F4F5F8', '#D7DAE1', P);
  R(c, 28 * 32 + 26, 12 * 32 + 30, 2, 10, '#9EA2AD');
  blk(c, 25 * 32, 15 * 32, 40, 18, 10, '#A87A52', '#7A5536', P);
  R(c, 1 * 32, 12 * 32 + 14, 6 * 32, 4 * 32, P.rug);
  R(c, 1 * 32 + 8, 12 * 32 + 22, 6 * 32 - 16, 4 * 32 - 16, P.rugB);
  for (let bx = 1; bx < 7; bx++) {
    const x3 = bx * 32;
    blk(c, x3, 11 * 32 - 16, 32, 6, 40, '#6B4A32', '#4A3020', P);
    for (let bk = 0; bk < 6; bk++) {
      R(
        c,
        x3 + 3 + bk * 5,
        11 * 32 - 6,
        4,
        13,
        ['#C0504D', '#4F81BD', '#9BBB59', '#F2B233', '#8064A2', '#4BACC6'][(bk + bx) % 6]!,
      );
      R(
        c,
        x3 + 3 + bk * 5,
        11 * 32 + 10,
        4,
        12,
        ['#4BACC6', '#C0504D', '#F2B233', '#4F81BD', '#9BBB59', '#8064A2'][(bk + bx) % 6]!,
      );
    }
  }
  R(c, 0, 13 * 32 + 6, 10, 48, '#2A2C33');
  blk(c, 5 * 32 + 8, 14 * 32 + 6, 36, 14, 16, '#9A6474', '#6E4250', P);
  plant(c, 24, 15 * 32 + 6, P);
  DESKS.forEach(function (dk) {
    const x = dk.x * 32,
      y = dk.y * 32;
    blk(c, x + 4, y + 2, 60, 20, 12, P.desk, P.deskFront, P, P.deskEdge);
    R(c, x + 8, y + 34, 3, 6, P.deskFront);
    R(c, x + 57, y + 34, 3, 6, P.deskFront);
    R(c, x + 29, y + 4, 6, 6, '#24232B');
    R(c, x + 18, y - 12, 28, 18, '#1C1B22');
    R(c, x + 20, y - 10, 24, 14, '#2E3A4F');
    R(c, x + 20, y + 12, 22, 5, '#2A2930');
    R(c, x + 48, y + 8, 10, 7, '#EFEBE0');
    blk(c, x + 22, y + 42, 20, 8, 6, P.chairTop, P.chair, P);
  });
  [
    [20, 3],
    [20, 16],
    [7, 16],
  ].forEach(function (p) {
    plant(c, p[0]! * 32 + 6, p[1]! * 32 + 4, P);
  });
  R(c, 14 * 32, H - 8, 64, 8, '#1C1829');
  R(c, 14 * 32 + 4, H - 22, 56, 14, '#6E5039');
  const g = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, P.vig);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  if (P.night) {
    c.fillStyle = P.night;
    c.fillRect(0, 0, W, H);
  }
  return cv;
}
