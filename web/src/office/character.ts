// SPDX-License-Identifier: Apache-2.0
// Converted mechanically from design/mabari-prototype.html, so the pixels match exactly.
import { providers, type ProviderName } from '../shared/tokens.ts';
import { ell, R, rrect } from './background.ts';
import { STATE_LOCATIONS } from './layout.ts';
import { finishing, glancing, idleDoing, stretching, waving } from './moments.ts';
import type { Walker } from './scene.ts';

type Ctx = CanvasRenderingContext2D;

/** The tick that floats beside an agent whose task just finished: a green badge with a white tick. */
function drawTick(c: Ctx, x: number, y: number, alpha: number) {
  c.globalAlpha = alpha;
  R(c, x, y, 12, 12, '#1F8F5A');
  R(c, x + 1, y + 1, 10, 10, '#3FB97A');
  for (const [dx, dy] of [
    [2, 6],
    [4, 8],
    [6, 6],
    [8, 4],
  ] as const) {
    R(c, x + dx, y + dy, 2, 2, '#FFFFFF');
  }
  c.globalAlpha = 1;
}

/**
 * Draws one agent. `calm` is reduced motion: nothing hops, waves, glances or changes what it is
 * doing, though what the agent is working on still shows.
 */
export function drawChar(
  c: Ctx,
  a: Walker,
  t: number,
  dim: boolean,
  selected: boolean,
  calm = false,
) {
  const now = Date.now();
  const x = Math.round(a.x),
    y = Math.round(a.y),
    u = 2,
    moving = !!(a.path && a.path.length),
    st = a.state,
    P = providers[a.provider as ProviderName] ?? providers.custom,
    hue = a.hue || '#8E8E93';
  const back =
    !a.front &&
    !moving &&
    (STATE_LOCATIONS[st] === 'desk' || st === 'reading' || st === 'running' || st === 'browsing');
  const dir = moving ? a.dir || 0 : 0,
    wf = moving ? Math.floor((a.walk || 0) / 90) % 4 : 0,
    leg = [0, 1, 0, -1][wf]!;
  let bob = moving
    ? wf % 2
      ? -1
      : 0
    : st === 'idle' || st === 'thinking'
      ? Math.round(Math.sin(t / 700 + a.n) * 0.7)
      : 0;
  // A finished task: one small hop, a tick beside the head and a little confetti, then still.
  const fin = st === 'done' ? finishing(a.doneAt, now, calm) : null;
  if (fin && !moving) bob -= fin.lift;
  const waves = waving(a.waveUntil, now, calm);
  // An agent waiting on you, or stopped by an error, now and then looks round at you.
  const needsYou = st === 'approval' || st === 'error' || !!a.question;
  const glance = !moving && glancing(a.n, t, needsYou, calm);
  const idle = st === 'idle' && !moving ? idleDoing(a.n, t, calm) : null;
  const stretch = idle !== null && stretching(idle, t);
  let alpha = dim ? 0.2 : 1;
  if (a.popUntil > now) {
    const k = 1 - (a.popUntil - now) / 1600;
    alpha *= Math.min(1, k * 1.6);
  }
  c.fillStyle = '#000';
  c.globalAlpha = alpha * 0.14;
  ell(c, x, y, 15, 6);
  c.globalAlpha = alpha * 0.28;
  ell(c, x, y, bob < -2 ? 8 : 10, 4);
  c.globalAlpha = alpha * (st === 'error' ? 0.8 : 1);
  const ox = x - 12,
    oy = y - 40 + bob;
  const p = (cx: number, cy: number, w: number, h: number, col: string) =>
    R(c, ox + cx * u, oy + cy * u, w * u, h * u, col);
  const shirt = st === 'error' ? '#7E8290' : P.color,
    shirtD = st === 'error' ? '#5F6370' : P.dark,
    pants = '#2D3047',
    shoe = '#14141B',
    skin = a.skin || '#E8B98F',
    hair = a.hair || '#2A1B12';
  p(3, 14, 2, 4 - (leg === 1 ? 1 : 0), pants);
  p(7, 14, 2, 4 - (leg === -1 ? 1 : 0), pants);
  p(3 + dir * 0.5, 18 - (leg === 1 ? 1 : 0), 2.5, 1, shoe);
  p(6.5 + dir * 0.5, 18 - (leg === -1 ? 1 : 0), 2.5, 1, shoe);
  p(2, 8, 8, 6, shirt);
  p(2, 8, 1, 6, shirtD);
  p(9, 8, 1, 6, shirtD);
  p(2, 13, 8, 1, shirtD);
  if (!back) {
    p(4.5, 8, 3, 1, '#F4F2EE');
    p(5.5, 9, 1, 2.5, hue);
    p(5, 11.5, 2, 1.5, hue);
  } else p(4, 8, 4, 1, shirtD);
  const typing = (st === 'editing' || st === 'running') && !moving,
    tf = Math.floor(t / (st === 'editing' ? 70 : 180)) % 2;
  if (st === 'approval' && !moving) {
    const wv = Math.sin(t / 160) > 0 ? 0.5 : 0;
    p(1, 8, 1, 4, shirt);
    p(1, 12, 1, 1, skin);
    p(10 + wv, 2, 1, 6, shirt);
    p(10 + wv, 1, 1.2, 1.2, skin);
  } else if (typing) {
    p(1, 8, 1, 3, shirt);
    p(10, 8, 1, 3, shirt);
    p(1, 11 - tf, 1, 1, skin);
    p(10, 10 + tf, 1, 1, skin);
  } else if (stretch) {
    // Both arms up over the head.
    p(0, 1, 1, 7, shirt);
    p(11, 1, 1, 7, shirt);
    p(0, 0, 1.2, 1.2, skin);
    p(11, 0, 1.2, 1.2, skin);
  } else {
    const sw = moving ? leg * 0.5 : 0;
    p(1, 8 + sw, 1, 4, shirt);
    p(1, 12 + sw, 1, 1, skin);
    if (waves) {
      // A new agent waving hello as it walks in.
      const wv = Math.sin(t / 130) > 0 ? 0.5 : 0;
      p(10 + wv, 2, 1, 6, shirt);
      p(10 + wv, 1, 1.2, 1.2, skin);
    } else {
      p(10, 8 - sw, 1, 4, shirt);
      p(10, 12 - sw, 1, 1, skin);
    }
  }
  p(3, 1, 6, 7, skin);
  p(3, 7, 6, 1, 'rgba(0,0,0,.12)');
  if (back && !glance) {
    p(2, 0, 8, 6, hair);
    p(2, 6, 1, 1, hair);
    p(9, 6, 1, 1, hair);
  } else {
    p(2, 0, 8, 2, hair);
    p(2, 2, 1, 3, hair);
    p(9, 2, 1, 3, hair);
    if (dir) p(dir > 0 ? 2 : 9, 2, 1, 4, hair);
    const blink = Math.floor((t + a.n * 700) / 2800) % 14 === 0,
      // Looking round the room, or down at a book or a phone, when resting.
      ex = dir * 0.6 + (idle === 'look' ? Math.sin(t / 900) * 0.9 : 0),
      ey = idle === 'book' || idle === 'phone' ? 0.8 : 0;
    p(4 + ex, 4 + ey, 1, blink ? 0.4 : 1.2, '#1A1410');
    p(7 + ex, 4 + ey, 1, blink ? 0.4 : 1.2, '#1A1410');
    if (glance) {
      p(3.8, 3, 1.6, 0.5, hair);
      p(6.8, 3, 1.6, 0.5, hair);
    }
    p(3.5 + ex, 5.7, 1, 0.6, 'rgba(240,120,120,.45)');
    p(7.5 + ex, 5.7, 1, 0.6, 'rgba(240,120,120,.45)');
    if (st === 'done') p(5 + ex, 6, 2, 0.8, '#8A3B2B');
    if (st === 'error') p(5 + ex, 6.5, 2, 0.5, '#4A3B3B');
  }
  if (idle === 'book') {
    // An open book held in both hands, a page turning now and then.
    p(3.5, 9, 5, 3, '#E9D8A6');
    p(5.9, 9, 0.3, 3, '#C9B27A');
    p(3, 11.6, 1, 1, skin);
    p(8, 11.6, 1, 1, skin);
    if (Math.floor(t / 700) % 4 === 0) p(6.2, 9, 2.3, 3, '#F4F2EE');
  } else if (idle === 'phone') {
    p(10, 8.6, 1.4, 2.4, '#16161C');
    p(10.2, 8.9, 1, 1.6, Math.floor(t / 900) % 2 ? '#9FD0FF' : '#5E7FA6');
  } else if (idle !== null && !stretch) {
    p(10, 9, 2, 2, '#F4F2EE');
    p(10, 9, 2, 0.5, '#6B4128');
    const sf = (t / 90) % 30;
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fillRect(ox + 21 + Math.sin(t / 300) * 2, oy + 14 - sf / 2, 2, 2);
    c.fillRect(ox + 23 + Math.sin(t / 240) * 2, oy + 8 - sf / 3, 2, 2);
  }
  if (st === 'reading' && !moving) {
    p(4, 9, 4, 3, '#E9D8A6');
    p(4, 9, 4, 0.6, '#C9B27A');
  }
  c.globalAlpha = dim ? 0.2 : 1;
  const hx = x,
    hy = oy - 6;
  if (!dim && !moving) {
    if (st === 'thinking') {
      const w2 = Math.sin(t / 400) * 1.5;
      c.fillStyle = '#FFFDF7';
      ell(c, hx + 9, hy + 4, 2, 2);
      ell(c, hx + 13, hy - 2, 3, 3);
      rrect(c, hx + 6, hy - 26 + w2, 34, 18, 8);
      c.fill();
      const dd = Math.floor(t / 350) % 4;
      for (let i = 0; i < 3; i++) {
        c.fillStyle = i < dd ? '#1F1B16' : '#C9C2B5';
        ell(c, hx + 15 + i * 8, hy - 17 + w2, 2.2, 2.2);
      }
    }
    if (st === 'error') {
      c.fillStyle = '#8A8F99';
      ell(c, hx - 6, hy - 16, 10, 6);
      ell(c, hx + 6, hy - 18, 9, 7);
      ell(c, hx, hy - 12, 14, 5);
      for (let j = 0; j < 4; j++)
        R(c, hx - 10 + j * 7, hy - 6 + ((t / 60 + j * 5) % 10), 1.5, 4, '#7CA6D9');
      if (Math.floor(t / 1700) % 5 === 0 && Math.floor(t / 90) % 2)
        R(c, hx + 2, hy - 10, 2, 8, '#FFE066');
    }
    if (fin?.confetti) {
      for (let k2 = 0; k2 < 12; k2++) {
        const ph = (t / 1500 + k2 * 0.083) % 1,
          ang = k2 * 0.52;
        R(
          c,
          hx + Math.cos(ang) * (6 + ph * 24),
          hy - 12 - Math.sin(ang) * 16 * (1 - ph) + ph * ph * 34,
          3,
          3,
          ['#F2B33D', '#5B9BF0', '#E8894A', '#3FB97A', '#8E8E93', '#FF6B9A'][k2 % 6]!,
        );
      }
    }
    if (fin?.tick) {
      drawTick(c, hx + 14, oy + 4 - Math.round(fin.tick.rise * 10), fin.tick.alpha);
    }
    if (st === 'spawning') {
      for (let k3 = 0; k3 < 6; k3++) {
        const aa = k3 * 1.05 + t / 700,
          rr = 18 + Math.sin(t / 300 + k3) * 4;
        R(c, hx + Math.cos(aa) * rr, y - 20 + Math.sin(aa) * rr * 0.6, 2, 2, '#FFF3B0');
        R(
          c,
          hx + Math.cos(aa) * rr - 2,
          y - 19.5 + Math.sin(aa) * rr * 0.6,
          6,
          1,
          'rgba(255,243,176,.6)',
        );
      }
      c.strokeStyle = 'rgba(255,243,176,' + (0.6 - ((t / 900) % 1) * 0.6) + ')';
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(hx, y, 8 + ((t / 900) % 1) * 26, 3 + ((t / 900) % 1) * 10, 0, 0, Math.PI * 2);
      c.stroke();
    }
  }
  if (a.popUntil > now) {
    const kk = (a.popUntil - now) / 1600;
    c.globalAlpha = 0.35 * kk;
    R(c, x - 9, y - 150, 18, 150, '#FFF3B0');
    c.globalAlpha = 1;
    for (let k4 = 0; k4 < 8; k4++)
      R(c, x + Math.cos(k4 + t / 90) * 20, y - 22 + Math.sin(k4 + t / 90) * 16, 3, 3, '#FFF3B0');
  }
  if (selected && !dim && !a.front) {
    c.globalAlpha = 1;
    c.strokeStyle = hue;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(x, y, 17 + Math.sin(t / 250), 7, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.globalAlpha = 1;
}
