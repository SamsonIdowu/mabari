// SPDX-License-Identifier: Apache-2.0
/** Vee, the Mabari mascot: an original pixel owl on a 32x36 grid, ported from the prototype. */

export type MascotPose = 'idle' | 'wave' | 'ask' | 'error' | 'done' | 'think' | 'work';

const C = {
  body: '#A99CFF',
  dark: '#7B6BE6',
  lite: '#C9C0FF',
  belly: '#EEEAFF',
  rim: '#2B2550',
  eye: '#FFFFFF',
  pupil: '#1A1530',
  beak: '#FF9F6B',
  feet: '#F2895A',
};

const CONFETTI = ['#F2B33D', '#5B9BF0', '#E8894A', '#3FB97A', '#FF6B9A'];
const BELLY_MARKS: [number, number][] = [
  [13, 21],
  [18, 21],
  [15, 24],
  [12, 25],
  [19, 25],
];
const EYES: [number, number][] = [
  [8, 8],
  [17, 8],
];

export interface MascotOptions {
  pose?: MascotPose;
  /** The scarf takes an agent's identity colour. */
  scarf?: string;
  /** The laptop takes an agent's provider colour. */
  laptop?: string;
  seed?: number;
}

function rect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function drawMascot(g: CanvasRenderingContext2D, t: number, options: MascotOptions = {}) {
  const pose = options.pose ?? 'idle';
  const bob =
    pose === 'done'
      ? -Math.round(Math.abs(Math.sin(t / 180)) * 3)
      : Math.round(Math.sin(t / 650) * 0.8);
  const r = (x: number, y: number, w: number, h: number, c: string) => rect(g, x, y + bob, w, h, c);

  g.fillStyle = 'rgba(0,0,0,.22)';
  g.beginPath();
  g.ellipse(16, 34.5, 10 - (bob < -1 ? 2 : 0), 1.6, 0, 0, Math.PI * 2);
  g.fill();

  // Feet stay on the ground while the body bobs.
  rect(g, 11, 31, 3, 2, C.feet);
  rect(g, 18, 31, 3, 2, C.feet);

  // Ear tufts.
  r(7, 1, 3, 2, C.dark);
  r(8, 3, 3, 2, C.body);
  r(22, 1, 3, 2, C.dark);
  r(21, 3, 3, 2, C.body);

  // Body.
  r(9, 4, 14, 1, C.body);
  r(7, 5, 18, 1, C.body);
  r(6, 6, 20, 2, C.body);
  r(5, 8, 22, 20, C.body);
  r(6, 28, 20, 1, C.body);
  r(8, 29, 16, 2, C.body);
  r(5, 8, 1, 20, C.dark);
  r(26, 8, 1, 20, C.dark);
  r(8, 30, 16, 1, C.dark);
  r(9, 4, 14, 1, C.lite);

  // Belly with little v marks.
  r(10, 18, 12, 9, C.belly);
  r(11, 27, 10, 2, C.belly);
  for (const [x, y] of BELLY_MARKS) {
    r(x, y, 1, 1, C.lite);
    r(x + 1, y + 1, 1, 1, C.lite);
    r(x + 2, y, 1, 1, C.lite);
  }

  if (options.scarf) {
    r(6, 16, 20, 2, options.scarf);
    r(6, 17, 20, 1, 'rgba(0,0,0,.18)');
    r(20, 18, 3, 4, options.scarf);
    r(20, 21, 3, 1, 'rgba(0,0,0,.18)');
  }

  // Big round "viewing" eyes with rims.
  const blink = pose !== 'error' && (t + (options.seed ?? 0) * 937) % 3400 < 130;
  const gx = pose === 'think' ? 1 : pose === 'work' ? 0 : Math.round(Math.sin(t / 2300));
  const gy = pose === 'think' ? -1 : pose === 'work' ? 1 : 0;
  for (const [x, y] of EYES) {
    r(x + 1, y, 5, 1, C.rim);
    r(x, y + 1, 7, 5, C.rim);
    r(x + 1, y + 6, 5, 1, C.rim);
    if (blink) {
      r(x + 1, y + 3, 5, 1, C.eye);
      continue;
    }
    r(x + 2, y + 1, 3, 1, C.eye);
    r(x + 1, y + 2, 5, 3, C.eye);
    r(x + 2, y + 5, 3, 1, C.eye);
    if (pose === 'error') {
      r(x + 2, y + 2, 1, 1, C.pupil);
      r(x + 4, y + 2, 1, 1, C.pupil);
      r(x + 3, y + 3, 1, 1, C.pupil);
      r(x + 2, y + 4, 1, 1, C.pupil);
      r(x + 4, y + 4, 1, 1, C.pupil);
    } else if (pose === 'done') {
      r(x + 2, y + 3, 1, 1, C.pupil);
      r(x + 3, y + 2, 1, 1, C.pupil);
      r(x + 4, y + 3, 1, 1, C.pupil);
    } else {
      r(x + 2 + gx, y + 2 + gy, 2, 2, C.pupil);
      r(x + 2 + gx, y + 2 + gy, 1, 1, '#FFFFFF');
    }
  }
  r(15, 7, 2, 1, C.rim);

  // Beak.
  r(15, 14, 2, 2, C.beak);
  r(15, 16, 2, 1, '#E0733F');

  // Wings by pose.
  const flap = Math.sin(t / 120) > 0;
  if (pose === 'ask') {
    r(2, 12, 3, 9, C.dark);
    const wiggle = Math.sin(t / 160) > 0 ? 1 : 0;
    r(27 + wiggle, 3, 3, 10, C.dark);
    r(27 + wiggle, 2, 3, 1, C.body);
  } else if (pose === 'done' || pose === 'wave') {
    r(2, flap ? 9 : 12, 3, 9, C.dark);
    r(27, flap ? 9 : 12, 3, 9, C.dark);
  } else {
    r(3, 14, 3, 10, C.dark);
    r(26, 14, 3, 10, C.dark);
  }

  // Props.
  if (pose === 'work') {
    const tap = Math.floor(t / 90) % 2;
    r(8, 19, 16, 10, '#4A4E61');
    r(9, 20, 14, 8, options.laptop || '#5B9BF0');
    r(9, 20, 14, 2, 'rgba(255,255,255,.28)');
    r(15, 23, 2, 2, 'rgba(255,255,255,.7)');
    r(6, 29, 20, 2, '#3A3D4D');
    r(4, 27 - tap, 3, 2, C.dark);
    r(25, 27 - (1 - tap), 3, 2, C.dark);
  }
  if (pose === 'think') {
    const phase = Math.floor(t / 350) % 3;
    for (let dot = 0; dot < 3; dot++) {
      g.globalAlpha = dot <= phase ? 1 : 0.25;
      rect(g, 25 + dot * 3, -1 - dot * 2 + bob, 2, 2, '#C8C4D6');
    }
    g.globalAlpha = 1;
  }
  if (pose === 'done') {
    CONFETTI.concat(CONFETTI.slice(0, 3)).forEach((colour, index) => {
      const fall = (t / 1400 + index * 0.125) % 1;
      const angle = index * 0.8;
      rect(
        g,
        16 + Math.cos(angle) * (6 + fall * 14),
        4 - Math.sin(angle) * 8 * (1 - fall) + fall * fall * 18,
        1,
        1,
        colour,
      );
    });
  }
  if (pose === 'error') {
    r(24, 2, 2, 4, '#F0585B');
    r(24, 7, 2, 1, '#F0585B');
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
