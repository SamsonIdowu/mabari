// SPDX-License-Identifier: Apache-2.0
// Converted from design/mabari-prototype.html, so Vee moves exactly as designed.

type Ctx = CanvasRenderingContext2D;
type Pt = [x: number, y: number];
type Arm = [shoulder: Pt, elbow: Pt, hand: Pt];

export type VeePose = 'idle' | 'work' | 'think' | 'ask' | 'wave' | 'done' | 'spread' | 'error';
type Eyes = 'happy' | 'lid' | 'wide' | 'wink' | 'closed' | null;

export interface VeeRig {
  spread?: number;
  turn?: number;
  flip?: number;
  jump?: number;
  squash?: number;
  lean?: number;
  tilt?: number;
  headY?: number;
  brows?: number;
  talk?: number;
  light?: number;
  eyes?: Eyes;
  mouth?: 'flat' | 'o';
  look?: { x: number; y: number };
  legs?: { lx?: number; ly?: number; rx?: number; ry?: number };
  arms?: Arm[];
  dots?: boolean;
  confetti?: boolean;
}

export interface VeeFrame {
  pose: VeePose;
  rig: VeeRig;
}

interface Palette {
  body: string;
  shade: string;
  dark: string;
  lite: string;
  rim: string;
  ink: string;
  plate: string;
  plateRim: string;
  gear: string;
  gear2: string;
  cheek: string;
  sole: string;
}

const VEE_L: Palette = {
  body: '#1E1E20',
  shade: '#121214',
  dark: '#000000',
  lite: '#3C3C40',
  rim: '#0C0C0C',
  ink: '#0C0C0C',
  plate: '#FFFFFF',
  plateRim: '#D6D6D9',
  gear: '#F4F4F4',
  gear2: '#CFCFD3',
  cheek: '#D2D2D6',
  sole: '#FFFFFF',
};
const VEE_D: Palette = {
  ...VEE_L,
  rim: '#EDEDEE',
  plateRim: '#BDBDC2',
  gear2: '#BDBDC2',
};

function veeSpread(pose: VeePose, t: number): number {
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
  const [first, second, third] = pts as [Pt, Pt, Pt?];
  g.strokeStyle = col;
  g.lineWidth = w;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(first[0], first[1]);
  if (third) g.quadraticCurveTo(second[0], second[1], third[0], third[1]);
  else for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.stroke();
}

function veeArms(pose: VeePose, t: number, k: number): Arm[] | 'cross' {
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

export interface MascotOptions {
  pose?: VeePose;
  rig?: VeeRig;
  scarf?: string;
  laptop?: string;
  dark?: boolean;
}

export function drawMascot(g: Ctx, t: number, o: MascotOptions) {
  const C = o.dark ? VEE_D : VEE_L,
    Rg = o.rig ?? {},
    pose = o.pose ?? 'idle',
    k = Rg.spread ?? veeSpread(pose, t),
    accent = o.scarf || C.sole;
  const turn = Math.max(-1, Math.min(1, Rg.turn ?? 0)),
    fs = Rg.flip ?? 1,
    back = fs < 0,
    sx = Math.max(0.06, Math.abs(fs));
  const jumpBy = Rg.jump ?? 0;
  const bob =
      (pose === 'done' ? -Math.abs(Math.sin(t / 180)) * 2.6 : Math.sin(t / 700) * 0.5) -
      k * 1.6 -
      jumpBy,
    sq = Rg.squash ?? 0;
  g.save();
  vEll(g, 16, 38.9, (7 + k * 4) * (1 - Math.min(0.5, jumpBy / 14)), 1.2, 'rgba(0,0,0,.22)');
  g.translate(16, 38);
  g.rotate(Rg.lean ?? 0);
  g.scale(sx * (1 + sq * 0.45), 1 - sq);
  g.translate(-16, -38);
  g.translate(0, bob);
  const happy =
    Rg.eyes === 'happy' || (!Rg.eyes && (pose === 'done' || pose === 'spread' || pose === 'wave'));
  /* legs and body: two short legs with sneakers, a small rounded torso */
  const L = Rg.legs ?? {},
    sw = Math.sin(t / 650) * 0.25,
    fly = jumpBy ? Math.min(1, jumpBy / 5) : 0;
  const hipL: Pt = [13.2 + turn * 0.5, 29.5],
    hipR: Pt = [18.8 + turn * 0.5, 29.5];
  const ftL: Pt = [
      12.4 - k * 4.2 + (L.lx ?? 0) + sw,
      37.2 - k * 1.4 - (L.ly ?? 0) - fly * 2.4 + bob * -0,
    ],
    ftR: Pt = [19.6 + k * 4.2 + (L.rx ?? 0) + sw, 37.2 - k * 1.4 - (L.ry ?? 0) - fly * 2.4];
  if (!jumpBy) {
    ftL[1] -= bob;
    ftR[1] -= bob;
  }
  for (const [h, f, side] of [
    [hipL, ftL, -1],
    [hipR, ftR, 1],
  ] as [Pt, Pt, number][]) {
    const c: Pt = [(h[0] + f[0]) / 2 + side * 0.4, (h[1] + f[1]) / 2];
    vTube(g, h, c, [f[0], f[1] - 1], 1.75, 1.55, C.rim, 0.55);
    vTube(g, h, c, [f[0], f[1] - 1], 1.75, 1.55, C.shade, 0);
  }
  for (const [f, d] of [
    [ftL, -1],
    [ftR, 1],
  ] as [Pt, number][]) {
    vEll(g, f[0] + d * 0.6, f[1], 2.9, 1.75, C.rim);
    vEll(g, f[0] + d * 0.6, f[1] - 0.2, 2.3, 1.2, C.gear2);
    g.fillStyle = accent;
    g.fillRect(f[0] + d * 0.6 - 2.3, f[1] + 0.45, 4.6, 0.55);
    vEll(g, f[0] + d * 0.6 - 0.8 * d, f[1] - 0.7, 0.8, 0.35, 'rgba(255,255,255,.35)');
  }
  vEll(g, 16 + turn * 0.5, 26.4, 7.6, 6.9, C.rim);
  vEll(g, 16 + turn * 0.5, 26.4, 7, 6.3, C.shade);
  vEll(g, 15.4 + turn * 0.2, 25.8, 6.2, 5.6, C.body);
  if (!back) vEll(g, 16 + turn * 1.2, 27.8, 3.4, 2.8, C.lite);
  const raised = Rg.arms ?? veeArms(pose, t, k),
    cross = raised === 'cross';
  const sourceArms: Arm[] =
    raised === 'cross'
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
      : raised;
  const A = sourceArms.map((a): Arm => {
    const sh: Pt = a[0][0] < 16 ? [10.2 + turn * 0.4, 22.6] : [21.8 + turn * 0.4, 22.6];
    return [sh, a[1], a[2]];
  });
  const drawArm = (a: Arm, col: string) => {
    vTube(g, a[0], a[1], a[2], 1.55, 1.2, C.rim, 0.55);
    vTube(g, a[0], a[1], a[2], 1.55, 1.2, col, 0);
    vEll(g, a[2][0], a[2][1], 1.75, 1.75, C.rim);
    vEll(g, a[2][0], a[2][1], 1.25, 1.25, col);
  };
  if (back) A.forEach((a) => drawArm(a, C.shade));
  /* head group: tilt around the neck, turn moves the face across the dome */
  g.save();
  g.translate(16, 21);
  g.rotate(Rg.tilt ?? 0);
  g.translate(-16, -21 + (Rg.headY ?? 0));
  const hx = 16,
    hrx = 11 * (1 - Math.abs(turn) * 0.05),
    fx = turn * 2.6;
  vEll(g, hx, 12.6, hrx + 0.6, 11.1, C.rim);
  vEll(g, hx, 12.6, hrx, 10.5, C.shade);
  vEll(g, hx - 0.8 - turn * 0.6, 11.8, hrx - 0.9, 9.6, C.body);
  vEll(g, 11 - turn * 1.6, 6.4, 3.2, 1.6, C.lite);
  vEll(g, 8.2 - turn * 1.2, 9.6, 1, 1.8, C.lite);
  if (!back) {
    const prx = 8.6 * (1 - Math.abs(turn) * 0.1);
    vEll(g, 16 + fx, 12.9, prx + 0.5, 8.1, C.plateRim);
    vEll(g, 16 + fx, 12.9, prx, 7.6, C.plate);
    vEll(g, 13.6 + fx - turn * 0.4, 8.2, 3, 1, 'rgba(0,0,0,.04)');
  }
  if (back) {
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
  const band: Pt[] = [
    [5.2 - turn * 0.8, 13],
    [16 + fx * 0.3, -6.6],
    [26.8 - turn * 0.8, 13],
  ];
  vLine(g, band, C.rim, 1.9);
  vLine(g, band, C.gear2, 1);
  if (cupVis) {
    const cw = 2.5 * (1 - Math.max(0, turn) * 0.35);
    g.fillStyle = C.rim;
    g.beginPath();
    g.ellipse(ex, 13.4, cw, 3.3, 0, 0, Math.PI * 2);
    g.fill();
    vEll(g, ex, 13.4, cw - 0.6, 2.7, C.gear);
    vEll(g, ex + 0.5, 12.6, 0.7 * (cw / 2.5), 1, C.gear2);
    const live =
      Rg.light ?? (pose === 'work' || pose === 'think' ? (Math.sin(t / 260) > 0 ? 1 : 0.35) : 1);
    g.globalAlpha = live;
    vEll(g, ex, 15.2, 0.55, 0.55, accent);
    g.globalAlpha = 1;
  }
  if (turn < 0.55) {
    vEll(g, 5.4 - turn * 1.6, 13.4, 1.1 * (1 - Math.max(0, -turn) * -1), 2.4, C.rim);
    vEll(g, 5.4 - turn * 1.6, 13.4, 0.6, 1.9, C.gear);
  }
  /* face */
  const blinkT = t % 4200 < 120,
    wink = Rg.eyes === 'wink' || (pose === 'idle' && !Rg.eyes && t % 5200 > 4300);
  const lk = Rg.look ?? {
      x: pose === 'think' ? 0.4 : pose === 'work' ? 0 : Math.sin(t / 2600) * 0.5,
      y: pose === 'think' ? -0.6 : pose === 'work' ? 0.6 : 0,
    },
    gx = lk.x,
    gy = lk.y;
  const br = Rg.brows ?? 0;
  const brow = (x: number, y: number, tilt: number) =>
    vLine(
      g,
      [
        [x - 2.2 + fx, y + tilt - br],
        [x + fx, y - 0.6 - br],
        [x + 2.2 + fx, y - tilt - br],
      ],
      C.ink,
      1.15,
    );
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
  const eye = (baseX: number, y: number, closed: boolean, lid: boolean, side: number) => {
    const x = baseX + fx,
      w = esz * (side * turn > 0 ? 1.06 : 0.92);
    if (closed || happy) {
      vLine(
        g,
        [
          [x - 1.6 * w, y + 0.3],
          [x, y - 1],
          [x + 1.6 * w, y + 0.3],
        ],
        C.ink,
        0.95,
      );
      return;
    }
    const wide = Rg.eyes === 'wide' ? 1.18 : 1;
    vEll(g, x + gx * 0.7, y + 0.2 + gy * 0.7, 1.45 * w * wide, 1.85 * wide, C.ink);
    vEll(g, x + gx * 0.7 - 0.45, y - 0.45 + gy * 0.7, 0.5 * wide, 0.55 * wide, '#FFFFFF');
    vEll(g, x + gx * 0.7 + 0.5, y + 0.8 + gy * 0.7, 0.22, 0.22, '#FFFFFF');
    if (lid && Rg.eyes !== 'wide') {
      vEll(g, x, y - 1.75, 2.2 * w, 1.25, C.plate);
      vLine(
        g,
        [
          [x - 1.8 * w, y - 0.55],
          [x, y - 0.8],
          [x + 1.8 * w, y - 0.55],
        ],
        C.ink,
        0.8,
      );
    }
  };
  const lidded = Rg.eyes === 'lid' || (!Rg.eyes && (pose === 'idle' || pose === 'work'));
  eye(11.4, 11.4, blinkT || wink || Rg.eyes === 'closed', lidded, -1);
  eye(19.6, 11.4, blinkT || Rg.eyes === 'closed', lidded, 1);
  vEll(g, 9.4 + fx, 15.2, 1.3, 0.65, C.cheek);
  vEll(g, 22.4 + fx, 15.2, 1.3, 0.65, C.cheek);
  const mx = 15.8 + fx,
    talk = Rg.talk ?? 0;
  if (talk > 0.05) {
    vEll(g, mx, 16.6, 1.5 + talk * 0.5, 0.4 + talk * 1.4, C.ink);
    vEll(g, mx, 16.9 + talk * 0.5, 1 + talk * 0.3, talk * 0.6, '#FF7A7A');
  } else if (happy) {
    g.fillStyle = C.ink;
    g.beginPath();
    g.moveTo(mx - 3, 15.6);
    g.quadraticCurveTo(mx, 19.6, mx + 3, 15.6);
    g.closePath();
    g.fill();
    vEll(g, mx, 17.3, 1.3, 0.7, '#FF7A7A');
  } else if (pose === 'error' || Rg.mouth === 'flat') {
    vLine(
      g,
      [
        [mx - 2.4, 17.2],
        [mx, 16.4],
        [mx + 2.4, 17.2],
      ],
      C.ink,
      0.9,
    );
  } else if (pose === 'ask' || Rg.mouth === 'o') {
    vEll(g, mx, 16.6, 1, 1.2, C.ink);
  } else {
    vLine(
      g,
      [
        [mx - 3.2, 16],
        [mx - 0.2, 17.3],
        [mx + 3, 15.4],
      ],
      C.ink,
      0.9,
    );
  }
  if (cupVis) {
    const bx = ex - 0.6;
    const boom: Pt[] = [
      [bx, 16.2],
      [bx - 1, 19.8],
      [mx + 4.4, 18.4],
    ];
    vLine(g, boom, C.ink, 1.3);
    vLine(g, boom, C.gear2, 0.6);
    vEll(g, mx + 4.2, 18.3, 1.05, 1.05, C.ink);
    vEll(g, mx + 4.2, 18.3, 0.6, 0.6, C.gear2);
  }
  g.restore();
  if (pose === 'work' && !Rg.arms) {
    g.fillStyle = C.rim;
    g.fillRect(8.4, 22.4, 15.2, 9.4);
    g.fillStyle = o.laptop || '#5B9BF0';
    g.fillRect(9.4, 23.4, 13.2, 7.4);
    g.fillStyle = 'rgba(255,255,255,.3)';
    g.fillRect(9.4, 23.4, 13.2, 1.6);
    vEll(g, 16, 27.1, 1, 1, 'rgba(255,255,255,.75)');
    g.fillStyle = '#3A3D4D';
    g.fillRect(6.6, 31.6, 18.8, 1.6);
  }
  A.forEach((a, i) => drawArm(a, i === 0 && cross ? C.shade : C.body));
  if (cross) {
    const [, second] = A as [Arm, Arm];
    const m = vq(second[0], second[1], second[2], 0.55);
    vEll(g, m[0], m[1] - 0.7, 1.6, 0.45, C.lite);
  }
  if (pose === 'think' || Rg.dots) {
    const ph = Math.floor(t / 350) % 3;
    for (let d = 0; d < 3; d++) {
      g.globalAlpha = d <= ph ? 1 : 0.25;
      vEll(g, 26 + d * 2.6, 2.8 - d * 1.8, 0.7 + d * 0.25, 0.7 + d * 0.25, '#C9C9CE');
    }
    g.globalAlpha = 1;
  }
  g.restore();
  if (pose === 'done' || Rg.confetti) {
    const colours = ['#F2B33D', '#5B9BF0', '#E8894A', '#3FB97A', '#FF6B9A'];
    for (let q = 0; q < 12; q++) {
      const ph2 = (t / 1400 + q * 0.083) % 1,
        ang = q * 0.6;
      g.fillStyle = colours[q % 5]!;
      g.fillRect(
        16 + Math.cos(ang) * (8 + ph2 * 14),
        4 - Math.sin(ang) * 8 * (1 - ph2) + ph2 * ph2 * 18,
        0.9,
        0.9,
      );
    }
  }
  if (pose === 'error') {
    g.fillStyle = '#F0585B';
    g.fillRect(28.6, 1.5, 1.6, 5);
    g.fillRect(28.6, 7.6, 1.6, 1.6);
  }
}

/* gesture library: each returns rig overrides for progress p (0..1) */
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

interface Gesture {
  dur: number;
  f: (p: number) => VeeFrame;
}

export const VEE_GESTURES: Record<string, Gesture> = {
  wave: {
    dur: 1700,
    f: (p) => ({
      pose: 'wave',
      rig: { eyes: 'happy', tilt: Math.sin(p * Math.PI * 3) * 0.08, turn: 0.15 },
    }),
  },
  nod: {
    dur: 1100,
    f: (p) => ({
      pose: 'idle',
      rig: {
        headY: Math.abs(Math.sin(p * Math.PI * 3)) * 1.4,
        eyes: 'lid',
        look: { x: 0, y: 0.6 },
      },
    }),
  },
  shake: {
    dur: 1200,
    f: (p) => ({
      pose: 'idle',
      rig: { turn: Math.sin(p * Math.PI * 6) * 0.7 * (1 - p * 0.6), mouth: 'flat' },
    }),
  },
  shrug: {
    dur: 1400,
    f: (p) => {
      const e = Math.sin(p * Math.PI);
      return {
        pose: 'idle',
        rig: {
          arms: [
            [
              [7, 20.5],
              [3, 25],
              [2.4, 22 - e * 4],
            ],
            [
              [25, 20.5],
              [29, 25],
              [29.6, 22 - e * 4],
            ],
          ],
          brows: e * 1.2,
          tilt: e * 0.14,
          mouth: 'flat',
          headY: -e * 0.8,
        },
      };
    },
  },
  point: {
    dur: 1500,
    f: (p) => {
      const e = Math.min(1, p * 4) * (p > 0.85 ? (1 - p) / 0.15 : 1);
      return {
        pose: 'idle',
        rig: {
          arms: [
            [
              [7, 20.5],
              [2.4, 26],
              [8.6, 28.2],
            ],
            [
              [25, 20.5],
              [29, 21 - e * 2],
              [26 + e * 7, 20 - e * 4],
            ],
          ],
          turn: 0.45 * e,
          look: { x: 1, y: -0.2 },
          eyes: 'wide',
        },
      };
    },
  },
  clap: {
    dur: 1600,
    f: (p) => {
      const c = Math.abs(Math.sin(p * Math.PI * 7)) * 4;
      return {
        pose: 'idle',
        rig: {
          arms: [
            [
              [7, 20.5],
              [6, 27],
              [15.3 - c, 24],
            ],
            [
              [25, 20.5],
              [26, 27],
              [16.7 + c, 24],
            ],
          ],
          eyes: 'happy',
          jump: Math.abs(Math.sin(p * Math.PI * 7)) * 0.6,
        },
      };
    },
  },
  jump: {
    dur: 1200,
    f: (p) => {
      const air = p > 0.18 && p < 0.82 ? Math.sin(((p - 0.18) / 0.64) * Math.PI) : 0,
        sq =
          p < 0.18
            ? Math.sin((p / 0.18) * Math.PI) * 0.18
            : p > 0.82
              ? Math.sin(((p - 0.82) / 0.18) * Math.PI) * 0.15
              : -air * 0.08;
      return {
        pose: air > 0.2 ? 'spread' : 'idle',
        rig: { jump: air * 7, squash: sq, spread: air, eyes: air > 0.3 ? 'happy' : null },
      };
    },
  },
  spin: {
    dur: 1300,
    f: (p) => {
      const a = ease(p) * Math.PI * 2;
      return {
        pose: 'idle',
        rig: {
          flip: Math.cos(a),
          turn: Math.sin(a) * 0.9,
          jump: Math.sin(p * Math.PI) * 2,
          spread: Math.sin(p * Math.PI) * 0.6,
        },
      };
    },
  },
  dance: {
    dur: 2800,
    f: (p) => {
      const b = Math.sin(p * Math.PI * 8),
        u = Math.sin(p * Math.PI * 4);
      return {
        pose: 'idle',
        rig: {
          lean: u * 0.14,
          jump: Math.abs(b) * 1.4,
          turn: u * 0.35,
          eyes: 'happy',
          spread: 0,
          legs: {
            ly: Math.max(0, b) * 2,
            ry: Math.max(0, -b) * 2,
            lx: u * 0.8,
            rx: u * 0.8,
          },
          arms: [
            [
              [7, 20.5],
              [2, 18],
              [3 + u * 2, 9 + (u > 0 ? 0 : 6)],
            ],
            [
              [25, 20.5],
              [30, 18],
              [29 + u * 2, 9 + (u > 0 ? 6 : 0)],
            ],
          ],
        },
      };
    },
  },
  stretch: {
    dur: 1600,
    f: (p) => {
      const e = Math.sin(p * Math.PI);
      return { pose: 'spread', rig: { spread: e, eyes: 'happy', squash: -e * 0.05 } };
    },
  },
  celebrate: {
    dur: 2200,
    f: (p) => {
      const b = Math.sin(p * Math.PI * 8);
      return {
        pose: 'done',
        rig: {
          confetti: true,
          spread: 0.2,
          jump: Math.abs(Math.sin(p * Math.PI * 4)) * 3,
          legs: { ly: Math.max(0, b) * 1.5, ry: Math.max(0, -b) * 1.5 },
        },
      };
    },
  },
  bow: {
    dur: 1500,
    f: (p) => {
      const e = Math.sin(p * Math.PI);
      return {
        pose: 'idle',
        rig: {
          headY: e * 2.6,
          squash: e * 0.12,
          eyes: 'closed',
          arms: [
            [
              [7, 20.5],
              [6, 27],
              [12, 27],
            ],
            [
              [25, 20.5],
              [26, 27],
              [20, 27],
            ],
          ],
        },
      };
    },
  },
  wink: {
    dur: 1000,
    f: (p) => ({
      pose: 'idle',
      rig: { eyes: 'wink', tilt: Math.sin(p * Math.PI) * 0.12, turn: 0.2 },
    }),
  },
  lookaround: {
    dur: 2400,
    f: (p) => {
      const a = Math.sin(p * Math.PI * 2);
      return { pose: 'idle', rig: { turn: a * 0.6, look: { x: a, y: -0.2 } } };
    },
  },
};

export const GESTURE_LABELS: [name: string, label: string][] = [
  ['wave', 'Wave'],
  ['nod', 'Nod'],
  ['shake', 'Shake head'],
  ['shrug', 'Shrug'],
  ['point', 'Point'],
  ['clap', 'Clap'],
  ['jump', 'Jump'],
  ['spin', 'Spin'],
  ['dance', 'Dance'],
  ['stretch', 'Star jump'],
  ['celebrate', 'Celebrate'],
  ['bow', 'Bow'],
  ['wink', 'Wink'],
];

export const IDLE_GESTURES = ['stretch', 'wink', 'lookaround', 'stretch', 'wave'];
export const POKE_GESTURES = ['wave', 'wink', 'spin', 'jump', 'dance', 'clap', 'stretch'];

export type VeeState = 'idle' | 'think' | 'talk';

export interface PlayingGesture {
  name: string;
  start: number;
  dur: number;
}

/** Picks Vee's pose for this moment. A gesture plays over the state, and talking keeps the mouth moving. */
export function veeFrame(
  state: VeeState,
  look: { x: number; y: number },
  gesture: PlayingGesture | null,
  t: number,
): VeeFrame {
  let out: VeeFrame;
  if (state === 'think') {
    out = { pose: 'think', rig: { look: { x: 0.4, y: -0.7 } } };
  } else if (state === 'talk') {
    const a = Math.sin(t / 260);
    out = {
      pose: 'idle',
      rig: {
        talk: Math.abs(Math.sin(t / 85)) * (0.5 + 0.5 * Math.abs(Math.sin(t / 410))),
        arms: [
          [
            [7, 20.5],
            [2 + a, 24],
            [5 + a * 1.5, 26 - Math.max(0, a) * 3],
          ],
          [
            [25, 20.5],
            [30 - a, 24],
            [27 - a * 1.5, 26 - Math.max(0, -a) * 3],
          ],
        ],
        tilt: a * 0.05,
        turn: look.x * 0.3,
        look: { x: look.x * 0.6, y: look.y * 0.4 },
      },
    };
  } else {
    out = {
      pose: 'idle',
      rig: { turn: look.x * 0.55, tilt: look.x * 0.05, look: { x: look.x, y: look.y } },
    };
  }
  if (gesture) {
    const p = (t - gesture.start) / gesture.dur,
      library = VEE_GESTURES[gesture.name];
    if (p < 1 && library) {
      const played = library.f(p);
      const talking = state === 'talk' ? { talk: out.rig.talk ?? 0 } : {};
      return { pose: played.pose, rig: { ...talking, ...played.rig } };
    }
  }
  return out;
}
