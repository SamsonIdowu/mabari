// SPDX-License-Identifier: Apache-2.0
import { providers, type ProviderName } from '../shared/tokens.ts';
import { R } from './background.ts';

/** The size of a portrait in canvas pixels. The page scales it up, keeping the pixels square. */
export const PORTRAIT = { width: 24, height: 28 } as const;

/** What a portrait needs from an agent: the look it has on the floor. */
export interface Look {
  skin: string;
  hair: string;
  hue: string;
  provider: string;
}

/**
 * An agent's head and shoulders, facing you, drawn from the same pieces as the character on the
 * floor so it is the same person: the shirt in its AI's colour, the tie in its own, its own skin
 * and hair. Cells are 2 pixels, as the floor's are.
 */
export function drawPortrait(c: CanvasRenderingContext2D, look: Look): void {
  const provider = providers[look.provider as ProviderName] ?? providers.custom;
  const p = (x: number, y: number, w: number, h: number, colour: string) =>
    R(c, x * 2, y * 2, w * 2, h * 2, colour);
  c.clearRect(0, 0, PORTRAIT.width, PORTRAIT.height);
  p(1, 8, 1, 5, provider.color);
  p(10, 8, 1, 5, provider.color);
  p(2, 8, 8, 6, provider.color);
  p(2, 8, 1, 6, provider.dark);
  p(9, 8, 1, 6, provider.dark);
  p(4.5, 8, 3, 1, '#F4F2EE');
  p(5.5, 9, 1, 2.5, look.hue);
  p(5, 11.5, 2, 1.5, look.hue);
  p(3, 1, 6, 7, look.skin);
  p(3, 7, 6, 1, 'rgba(0,0,0,.12)');
  p(2, 0, 8, 2, look.hair);
  p(2, 2, 1, 3, look.hair);
  p(9, 2, 1, 3, look.hair);
  p(4, 4, 1, 1.2, '#1A1410');
  p(7, 4, 1, 1.2, '#1A1410');
  p(3.5, 5.7, 1, 0.6, 'rgba(240,120,120,.45)');
  p(7.5, 5.7, 1, 0.6, 'rgba(240,120,120,.45)');
  p(5, 6, 2, 0.5, '#8A3B2B');
}
