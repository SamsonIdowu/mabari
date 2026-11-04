// SPDX-License-Identifier: Apache-2.0
// Vee, the Mabari mascot: an original octopus dispatcher, cel shaded, on a 32x40 grid.
// Converted mechanically from design/mabari-prototype.html, so the drawing matches exactly.

export type MascotPose = 'idle' | 'wave' | 'ask' | 'error' | 'done' | 'think' | 'work' | 'spread';

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];
type Arm = [Pt, Pt, Pt];
type Arms = Arm[];

/** Overrides that the gestures on Home use to move Vee. */
export interface Rig {
  spread?: number;
  turn?: number;
  flip?: number;
  jump?: number;
  squash?: number;
  lean?: number;
  tilt?: number;
  headY?: number;
  brows?: number;
  light?: number;
  talk?: number;
  eyes?: string | null;
  mouth?: string;
  look?: { x: number; y: number };
  arms?: Arms;
  dots?: boolean;
  confetti?: boolean;
}

export interface MascotOptions {
  pose?: MascotPose;
  rig?: Rig;
  /** The scarf takes an agent's identity colour. */
  scarf?: string;
  /** The laptop takes an agent's provider colour. */
  laptop?: string;
  seed?: number;
  x?: number;
  y?: number;
}

const VEE = {
  body: '#A99CFF',
  shade: '#8A7BF0',
  dark: '#6E5ED8',
  lite: '#D4CCFF',
  rim: '#2A2158',
  eye: '#FFFFFF',
  iris: '#2FB3A8',
  pupil: '#120F26',
  gear: '#23233A',
  gear2: '#3A3A5C',
};
function veeSpread(pose: MascotPose, t: number): number {
  if (pose === 'spread') return 1;
  if (pose === 'done') return 0.75 + 0.25 * Math.sin(t / 200);
  if (pose === 'ask') return 0.3;
  if (pose === 'error' || pose === 'work') return 0;
  const c = (t % 7000) / 7000;
  return c < 0.2 ? Math.sin((c / 0.2) * Math.PI) : 0;
}
function vq(p0: Pt, p1: Pt, p2: Pt, u: number): Pt {
  const a = (1 - u) * (1 - u),
    b = 2 * (1 - u) * u,
    c = u * u;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
}
function vTube(g: Ctx, p0: Pt, p1: Pt, p2: Pt, r0: number, r1: number, col: string, grow: number) {
  g.fillStyle = col;
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const u = i / n,
      p = vq(p0, p1, p2, u),
      r = r0 + (r1 - r0) * u + grow;
    g.beginPath();
    g.arc(p[0], p[1], Math.max(0.1, r), 0, Math.PI * 2);
    g.fill();
  }
}
function vEll(g: Ctx, x: number, y: number, rx: number, ry: number, col: string) {
  g.fillStyle = col;
  g.beginPath();
  g.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
  g.fill();
}
function vLine(g: Ctx, pts: Pt[], col: string, w: number) {
  g.strokeStyle = col;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  if (pts.length === 3) g.quadraticCurveTo(pts[1]![0], pts[1]![1], pts[2]![0], pts[2]![1]);
  else for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
  g.stroke();
}
function veeArms(pose: MascotPose, t: number, k: number): Arms | 'cross' {
  const wv = Math.sin(t / 150) * 1.4,
    fl = Math.sin(t / 120) * 1.2,
    tf = Math.floor(t / 90) % 2;
  if (pose === 'work')
    return [
      [
        [7, 20.5],
        [4, 28],
        [10.4, 31.2 - tf * 0.8],
      ],
      [
        [25, 20.5],
        [28, 28],
        [21.6, 31.2 - (1 - tf) * 0.8],
      ],
    ];
  if (pose === 'think')
    return [
      [
        [7, 20.5],
        [2.4, 26],
        [8.6, 28.2],
      ],
      [
        [25, 20.5],
        [29.6, 22],
        [21, 19.6],
      ],
    ];
  if (pose === 'ask' || pose === 'wave')
    return [
      [
        [7, 20.5],
        [2.4, 26],
        [8.6, 28.2],
      ],
      [
        [25, 20.5],
        [30.4, 15],
        [28.6 + wv, 6.4],
      ],
    ];
  if (pose === 'done' || pose === 'spread')
    return [
      [
        [7, 20],
        [0.8, 15],
        [2 - k, 6.4 + fl],
      ],
      [
        [25, 20],
        [31.2, 15],
        [30 + k, 6.4 - fl],
      ],
    ];
  if (pose === 'error')
    return [
      [
        [7, 20.5],
        [4.8, 27],
        [6, 32],
      ],
      [
        [25, 20.5],
        [27.2, 27],
        [26, 32],
      ],
    ];
  return 'cross';
}
export function drawMascot(g: Ctx, t: number, o: MascotOptions = {}) {
  const Rg: Rig = o.rig ?? {};
  const pose: MascotPose = o.pose || 'idle',
    C = VEE,
    k = Rg.spread != null ? Rg.spread : veeSpread(pose, t),
    accent = o.scarf || '#7CCFE0';
  const turn = Math.max(-1, Math.min(1, Rg.turn || 0)),
    fs = Rg.flip != null ? Rg.flip : 1,
    back = fs < 0,
    sx = Math.max(0.06, Math.abs(fs));
  const bob =
      (pose === 'done' ? -Math.abs(Math.sin(t / 180)) * 2.6 : Math.sin(t / 700) * 0.5) -
      k * 1.6 -
      (Rg.jump || 0),
    sq = Rg.squash || 0;
  g.save();
  g.translate(o.x || 0, o.y || 0);
  vEll(g, 16, 38.6, (9 + k * 5) * (1 - Math.min(0.5, (Rg.jump || 0) / 14)), 1.3, 'rgba(0,0,0,.22)');
  g.translate(16, 38);
  g.rotate(Rg.lean || 0);
  g.scale(sx * (1 + sq * 0.45), 1 - sq);
  g.translate(-16, -38);
  g.translate(0, bob);
  const happy =
    Rg.eyes === 'happy' || (!Rg.eyes && (pose === 'done' || pose === 'spread' || pose === 'wave'));
  /* tentacles */
  const roots = [9, 11.8, 14.6, 17.4, 20.2, 23],
    T = roots.map(function (rx, i): { p0: Pt; p1: Pt; p2: Pt; d: number } {
      const d = (rx - 16) / 6.5,
        wig = Math.sin(t / 420 + i * 1.7) * 0.5 + turn * 0.6;
      return {
        p0: [rx + turn * 0.8, 21],
        p1: [rx + d * (0.6 + k * 3), 30 - k * 2],
        p2: [
          rx + d * (3.6 + k * 9) + wig,
          37.4 - k * (2 + Math.abs(d) * 7) - bob * (Rg.jump ? 0 : 1) + (Rg.jump ? -k * 0 : 0),
        ],
        d: d,
      };
    });
  [0, 5, 1, 4, 2, 3].forEach(function (i) {
    const tt = T[i]!,
      bk = i === 0 || i === 5,
      col = bk ? C.shade : C.body;
    vTube(g, tt.p0, tt.p1, tt.p2, 1.75, 0.85, C.rim, 0.55);
    vTube(g, tt.p0, tt.p1, tt.p2, 1.75, 0.85, col, 0);
    const cx = tt.p2[0] + (tt.d >= 0 ? 1 : -1) * 0.9,
      cy = tt.p2[1] - 0.6;
    vEll(g, cx, cy, 1.25, 1.25, C.rim);
    vEll(g, cx, cy, 0.75, 0.75, col);
    if (!back) {
      let s = vq(tt.p0, tt.p1, tt.p2, 0.62);
      vEll(g, s[0] + (tt.d >= 0 ? 0.6 : -0.6), s[1], 0.35, 0.35, C.dark);
      s = vq(tt.p0, tt.p1, tt.p2, 0.82);
      vEll(g, s[0] + (tt.d >= 0 ? 0.5 : -0.5), s[1], 0.3, 0.3, C.dark);
    }
  });
  const armSet = Rg.arms || veeArms(pose, t, k),
    cross = armSet === 'cross';
  const A: Arms =
    armSet === 'cross'
      ? [
          [
            [6.6, 20.4],
            [9, 27.6],
            [22.4, 24.6],
          ],
          [
            [25.4, 20.4],
            [23, 27.2],
            [9.6, 24],
          ],
        ]
      : armSet;
  const drawArm = (a: Arm, col: string) => {
    vTube(g, a[0], a[1], a[2], 1.55, 1.2, C.rim, 0.55);
    vTube(g, a[0], a[1], a[2], 1.55, 1.2, col, 0);
    vEll(g, a[2][0], a[2][1], 1.75, 1.75, C.rim);
    vEll(g, a[2][0], a[2][1], 1.25, 1.25, col);
  };
  if (back)
    A.forEach(function (a) {
      drawArm(a, C.shade);
    });
  /* head group: tilt around the neck, turn moves the face across the dome */
  g.save();
  g.translate(16, 21);
  g.rotate(Rg.tilt || 0);
  g.translate(-16, -21 + (Rg.headY || 0));
  const hx = 16,
    hrx = 11 * (1 - Math.abs(turn) * 0.05),
    fx = turn * 2.6;
  vEll(g, hx, 12.6, hrx + 0.6, 11.1, C.rim);
  vEll(g, hx, 12.6, hrx, 10.5, C.shade);
  vEll(g, hx - 0.8 - turn * 0.6, 11.8, hrx - 0.9, 9.6, C.body);
  vEll(g, 11 - turn * 1.6, 6.4, 3.2, 1.6, C.lite);
  vEll(g, 8.2 - turn * 1.2, 9.6, 1, 1.8, C.lite);
  if (back) {
    vEll(g, 14, 7, 1.2, 1.1, C.dark);
    vEll(g, 18.4, 9, 0.9, 0.8, C.dark);
    vEll(g, 16, 12.5, 0.6, 0.55, C.dark);
    vLine(
      g,
      [
        [5.2, 13],
        [16, -6.6],
        [26.8, 13],
      ],
      C.rim,
      1.9,
    );
    vLine(
      g,
      [
        [5.2, 13],
        [16, -6.6],
        [26.8, 13],
      ],
      C.gear2,
      1,
    );
    g.restore();
    g.restore();
    return;
  }
  vEll(g, 21.3 + fx * 0.6, 5.2, 1.1, 1, C.dark);
  vEll(g, 23.3 + fx * 0.4, 7.6, 0.7, 0.65, C.dark);
  vEll(g, 19.6 + fx * 0.6, 7.7, 0.55, 0.5, C.dark);
  if (o.scarf) {
    g.fillStyle = C.rim;
    g.beginPath();
    g.moveTo(8.2, 20.3);
    g.quadraticCurveTo(16 + fx * 0.4, 24.4, 23.8, 20.3);
    g.lineTo(23.2, 22.4);
    g.quadraticCurveTo(16 + fx * 0.4, 26.2, 8.8, 22.4);
    g.closePath();
    g.fill();
    g.fillStyle = o.scarf;
    g.beginPath();
    g.moveTo(8.8, 20.8);
    g.quadraticCurveTo(16 + fx * 0.4, 24.6, 23.2, 20.8);
    g.lineTo(22.7, 22);
    g.quadraticCurveTo(16 + fx * 0.4, 25.6, 9.3, 22);
    g.closePath();
    g.fill();
  }
  /* headset: earcup slides round the head as Vee turns */
  const ex = 26.6 + turn * -1.2,
    cupVis = turn > -0.55;
  vLine(
    g,
    [
      [5.2 - turn * 0.8, 13],
      [16 + fx * 0.3, -6.6],
      [26.8 - turn * 0.8, 13],
    ],
    C.rim,
    1.9,
  );
  vLine(
    g,
    [
      [5.2 - turn * 0.8, 13],
      [16 + fx * 0.3, -6.6],
      [26.8 - turn * 0.8, 13],
    ],
    C.gear2,
    1,
  );
  if (cupVis) {
    const cw = 2.5 * (1 - Math.max(0, turn) * 0.35);
    g.fillStyle = C.rim;
    g.beginPath();
    g.ellipse(ex, 13.4, cw, 3.3, 0, 0, Math.PI * 2);
    g.fill();
    vEll(g, ex, 13.4, cw - 0.6, 2.7, C.gear);
    vEll(g, ex + 0.5, 12.6, 0.7 * (cw / 2.5), 1, C.gear2);
    const live =
      Rg.light != null
        ? Rg.light
        : pose === 'work' || pose === 'think'
          ? Math.sin(t / 260) > 0
            ? 1
            : 0.35
          : 1;
    g.globalAlpha = live;
    vEll(g, ex, 15.2, 0.55, 0.55, accent);
    g.globalAlpha = 1;
  }
  if (turn < 0.55) {
    vEll(g, 5.4 - turn * 1.6, 13.4, 1.1 * (1 - Math.max(0, -turn) * -1), 2.4, C.rim);
    vEll(g, 5.4 - turn * 1.6, 13.4, 0.6, 1.9, C.gear);
  }
  /* face */
  const blinkT = (t + (o.seed || 0) * 937) % 4200 < 120,
    wink = Rg.eyes === 'wink' || (pose === 'idle' && !Rg.eyes && t % 5200 > 4300);
  const lk = Rg.look || {
      x: pose === 'think' ? 0.4 : pose === 'work' ? 0 : Math.sin(t / 2600) * 0.5,
      y: pose === 'think' ? -0.6 : pose === 'work' ? 0.6 : 0,
    },
    gx = lk.x,
    gy = lk.y;
  const br = Rg.brows || 0;
  const brow = (x: number, y: number, tilt: number) => {
    vLine(
      g,
      [
        [x - 2.2 + fx, y + tilt - br],
        [x + fx, y - 0.6 - br],
        [x + 2.2 + fx, y - tilt - br],
      ],
      C.rim,
      1.15,
    );
  };
  if (pose === 'error') {
    brow(11.4, 8.6, -1);
    brow(19.6, 8.6, -1);
  } else if (happy || pose === 'ask') {
    brow(11.4, 6.9, 0.2);
    brow(19.6, 6.9, 0.2);
  } else if (pose === 'think') {
    brow(11.4, 8, 0.4);
    brow(19.6, 7, -0.4);
  } else {
    brow(11.4, 8.3, 0.5);
    brow(19.6, 7.7, -0.2);
  }
  const esz = 1 - Math.abs(turn) * 0.12;
  const eye = (eyeX: number, y: number, closed: boolean, lid: boolean, side: number) => {
    const x = eyeX + fx;
    const w = esz * (side * turn > 0 ? 1.06 : 0.92);
    if (closed || happy) {
      vLine(
        g,
        [
          [x - 1.6 * w, y + 0.3],
          [x, y - 1],
          [x + 1.6 * w, y + 0.3],
        ],
        C.rim,
        0.9,
      );
      return;
    }
    const wide = Rg.eyes === 'wide' ? 1.12 : 1;
    vEll(g, x, y, 2.3 * w * wide, 2.5 * wide, C.rim);
    vEll(g, x, y, 1.8 * w * wide, 2 * wide, C.eye);
    vEll(g, x + gx * 0.9, y + 0.3 + gy, 1.15 * w, 1.25, C.iris);
    vEll(g, x + gx * 0.9, y + 0.4 + gy, 0.6 * w, 0.65, C.pupil);
    vEll(g, x + gx * 0.9 - 0.4, y - 0.1 + gy, 0.32, 0.32, '#fff');
    if (lid && Rg.eyes !== 'wide') {
      vEll(g, x, y - 1.9, 2.4 * w, 1.6, C.body);
      vLine(
        g,
        [
          [x - 2 * w, y - 0.6],
          [x, y - 0.95],
          [x + 2 * w, y - 0.6],
        ],
        C.rim,
        0.8,
      );
    }
  };
  const lidded = Rg.eyes === 'lid' || (!Rg.eyes && (pose === 'idle' || pose === 'work'));
  eye(11.4, 11.4, blinkT || wink || Rg.eyes === 'closed', lidded, -1);
  eye(19.6, 11.4, blinkT || Rg.eyes === 'closed', lidded, 1);
  const mx = 15.8 + fx,
    talk = Rg.talk || 0;
  if (talk > 0.05) {
    vEll(g, mx, 16.6, 1.5 + talk * 0.5, 0.4 + talk * 1.4, C.rim);
    vEll(g, mx, 16.9 + talk * 0.5, 1 + talk * 0.3, talk * 0.6, '#E86A8A');
  } else if (happy) {
    g.fillStyle = C.rim;
    g.beginPath();
    g.moveTo(mx - 3, 15.6);
    g.quadraticCurveTo(mx, 19.6, mx + 3, 15.6);
    g.closePath();
    g.fill();
    vEll(g, mx, 17.3, 1.3, 0.7, '#E86A8A');
  } else if (pose === 'error' || Rg.mouth === 'flat') {
    vLine(
      g,
      [
        [mx - 2.4, 17.2],
        [mx, 16.4],
        [mx + 2.4, 17.2],
      ],
      C.rim,
      0.9,
    );
  } else if (pose === 'ask' || Rg.mouth === 'o') {
    vEll(g, mx, 16.6, 1, 1.2, C.rim);
  } else {
    vLine(
      g,
      [
        [mx - 3.2, 16],
        [mx - 0.2, 17.3],
        [mx + 3, 15.4],
      ],
      C.rim,
      0.9,
    );
  }
  if (cupVis) {
    const bx = ex - 0.6;
    vLine(
      g,
      [
        [bx, 16.2],
        [bx - 1, 19.8],
        [mx + 4.4, 18.4],
      ],
      C.rim,
      1.3,
    );
    vLine(
      g,
      [
        [bx, 16.2],
        [bx - 1, 19.8],
        [mx + 4.4, 18.4],
      ],
      C.gear2,
      0.6,
    );
    vEll(g, mx + 4.2, 18.3, 1.05, 1.05, C.rim);
    vEll(g, mx + 4.2, 18.3, 0.6, 0.6, accent);
  }
  g.restore();
  if (pose === 'work' && !Rg.arms) {
    const lc = o.laptop || '#5B9BF0';
    g.fillStyle = C.rim;
    g.fillRect(8.4, 22.4, 15.2, 9.4);
    g.fillStyle = lc;
    g.fillRect(9.4, 23.4, 13.2, 7.4);
    g.fillStyle = 'rgba(255,255,255,.3)';
    g.fillRect(9.4, 23.4, 13.2, 1.6);
    vEll(g, 16, 27.1, 1, 1, 'rgba(255,255,255,.75)');
    g.fillStyle = '#3A3D4D';
    g.fillRect(6.6, 31.6, 18.8, 1.6);
  }
  A.forEach(function (a, i) {
    drawArm(a, i === 0 && cross ? C.shade : C.body);
  });
  if (cross) {
    const m = vq(A[1]![0], A[1]![1], A[1]![2], 0.55);
    vEll(g, m[0], m[1] - 0.7, 1.6, 0.45, C.lite);
  }
  if (pose === 'think' || Rg.dots) {
    const ph = Math.floor(t / 350) % 3;
    for (let d = 0; d < 3; d++) {
      g.globalAlpha = d <= ph ? 1 : 0.25;
      vEll(g, 26 + d * 2.6, 2.8 - d * 1.8, 0.7 + d * 0.25, 0.7 + d * 0.25, '#C8C4D6');
    }
    g.globalAlpha = 1;
  }
  g.restore();
  if (pose === 'done' || Rg.confetti) {
    for (let q = 0; q < 12; q++) {
      const ph2 = (t / 1400 + q * 0.083) % 1,
        ang = q * 0.6;
      g.fillStyle = ['#F2B33D', '#5B9BF0', '#E8894A', '#3FB97A', '#FF6B9A'][q % 5]!;
      g.fillRect(
        (o.x || 0) + 16 + Math.cos(ang) * (8 + ph2 * 14),
        (o.y || 0) + 4 - Math.sin(ang) * 8 * (1 - ph2) + ph2 * ph2 * 18,
        0.9,
        0.9,
      );
    }
  }
  if (pose === 'error') {
    g.fillStyle = '#F0585B';
    g.fillRect((o.x || 0) + 28.6, (o.y || 0) + 1.5, 1.6, 5);
    g.fillRect((o.x || 0) + 28.6, (o.y || 0) + 7.6, 1.6, 1.6);
  }
}

/** The pose that shows what an agent is doing. */
export function mascotPose(state: string | undefined): MascotPose {
  switch (state) {
    case 'approval':
      return 'ask';
    case 'error':
      return 'error';
    case 'done':
      return 'done';
    case 'thinking':
    case 'spawning':
      return 'think';
    case undefined:
    case 'idle':
    case 'paused':
      return 'idle';
    default:
      return 'work';
  }
}
