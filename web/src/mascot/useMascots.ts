// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { drawMascot, type MascotPose } from './drawMascot.ts';

function paint(canvas: HTMLCanvasElement, t: number) {
  const scale = Number(canvas.dataset.scale) || 4;
  const width = 32 * scale;
  const height = 36 * scale;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, width, height);
  g.imageSmoothingEnabled = false;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  drawMascot(g, t, {
    pose: canvas.dataset.mascot as MascotPose,
    ...(canvas.dataset.scarf ? { scarf: canvas.dataset.scarf } : {}),
    ...(canvas.dataset.laptop ? { laptop: canvas.dataset.laptop } : {}),
  });
}

/**
 * Paints every visible `canvas[data-mascot]`, as the prototype does, so mascots work in static
 * HTML too. With reduced motion they are drawn once, standing still.
 */
export function useMascots(): void {
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const loop = (t: number) => {
      document.querySelectorAll<HTMLCanvasElement>('canvas[data-mascot]').forEach((canvas) => {
        if (canvas.offsetParent !== null) paint(canvas, still ? 0 : t);
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);
}
