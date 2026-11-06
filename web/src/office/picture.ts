// SPDX-License-Identifier: Apache-2.0
import { localDay } from '../data/catchUp.ts';

/**
 * A picture of the office to keep or show: the floor as it is now, pixels and all, under a strip
 * that says whose it is and what it holds. It is made here from the canvas on screen and saved
 * from the page, so nothing is sent anywhere. The strip carries only counts, and the floor is the
 * pixel office, with no name tags, tasks or folders: only a team's office is labelled with its
 * lead's name, as it is on screen.
 */

export interface PictureFacts {
  agents: number;
  working: number;
  /** Projects shipped, which is what the trophy display holds. */
  shipped: number;
  at: Date;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The line under the picture: "My Mabari office · 22 agents · 16 working · 3 shipped · 6 Nov 2026". */
export function captionOf(facts: PictureFacts): string {
  const parts = ['My Mabari office', plural(facts.agents, 'agent')];
  if (facts.agents) parts.push(`${facts.working} working`);
  if (facts.shipped) parts.push(`${facts.shipped} shipped`);
  parts.push(
    facts.at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  );
  return parts.join(' · ');
}

/** The file's name, dated the way the log's exports are: `mabari-office-2026-11-06.png`. */
export function pictureName(at: Date): string {
  return `mabari-office-${localDay(at)}.png`;
}

/** The strip's height under the floor, in pixels. */
export const STRIP = 44;

/**
 * The floor with the strip under it, on a new canvas. Flat colour: the floor's own picture, then a
 * dark strip with the caption in white. The theme only changes the strip's ink to suit the floor
 * above it.
 */
export function composePicture(
  source: HTMLCanvasElement,
  facts: PictureFacts,
  theme: 'dark' | 'light',
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height + STRIP;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingEnabled = false;
  c.drawImage(source, 0, 0);
  c.fillStyle = theme === 'dark' ? '#0E0E10' : '#141416';
  c.fillRect(0, source.height, canvas.width, STRIP);
  c.fillStyle = '#F5F5F5';
  c.font = '800 16px Nunito, sans-serif';
  c.textBaseline = 'middle';
  c.fillText(captionOf(facts), 18, source.height + STRIP / 2 + 1);
  return canvas;
}

/** Saves the picture as a file from the page, with the date in its name. */
export function savePicture(
  source: HTMLCanvasElement,
  facts: PictureFacts,
  theme: 'dark' | 'light',
): Promise<string> {
  const picture = composePicture(source, facts, theme);
  return new Promise((resolve, reject) => {
    picture.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The picture could not be made'));
        return;
      }
      const name = pictureName(facts.at);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // The download has started by the time the browser returns from the click.
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      resolve(name);
    }, 'image/png');
  });
}
