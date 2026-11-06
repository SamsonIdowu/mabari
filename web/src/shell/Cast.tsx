// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { paintCast, sizeOf, type Act } from '../office/cast.ts';
import { useThemeStore } from '../theme/themeStore.ts';

/** How often a cast member is drawn again, which is plenty for a bob, a blink and some steam. */
const FRAME_MS = 160;

/**
 * One of the floor's characters, standing in an empty state. It is decoration: the words beside
 * it say what it says, so a screen reader skips it. It moves a little, except with reduced
 * motion, when it holds still, and it stops while the page is hidden.
 */
export function Cast({ who, act }: { who: number; act: Act }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useThemeStore((state) => state.theme);
  const { width, height } = sizeOf(act);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return undefined;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    paintCast(context, who, act, calm ? 0 : performance.now(), theme, calm);
    if (calm) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) paintCast(context, who, act, performance.now(), theme, false);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [who, act, theme]);
  return (
    <canvas
      ref={canvas}
      className="cast"
      width={width}
      height={height}
      style={{ width: width * 2, height: height * 2 }}
      aria-hidden="true"
    />
  );
}
