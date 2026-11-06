// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { agoText } from '../format.ts';
import type { OfficeScene } from './scene.ts';
import { TROPHY } from './trophies.ts';

/** Which completed project's summary is open, from a click on its trophy. */
export const useTrophy = create<{ open: string | null; show: (id: string | null) => void }>(
  (set) => ({ open: null, show: (open) => set({ open }) }),
);

/** The smallest a trophy's button gets, whatever the zoom, so a fingertip can hit it. */
const MIN_PX = 22;

/**
 * Puts a button over each trophy on the shelf, in the page, so they can be reached by keyboard,
 * read by a screen reader and hovered for a name, which the canvas alone can't give. The picture
 * is the canvas's; the button is invisible but for its focus ring. It runs every frame, so it
 * only writes to the page when something moved.
 */
export function placeTrophies(overlay: HTMLElement, scene: OfficeScene): void {
  let layer = overlay.querySelector<HTMLElement>(':scope > .trophylayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'trophylayer';
    layer.setAttribute('role', 'group');
    layer.setAttribute('aria-label', 'Trophy shelf: projects you have shipped');
    overlay.appendChild(layer);
  }
  const now = Date.now();
  const seen = new Set<string>();
  for (const spot of scene.trophies.spots) {
    seen.add(spot.id);
    let button = layer.querySelector<HTMLButtonElement>(`[data-project="${CSS.escape(spot.id)}"]`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'trophy';
      button.dataset.project = spot.id;
      const id = spot.id;
      button.addEventListener('click', () => useTrophy.getState().show(id));
      layer.appendChild(button);
    }
    const from = scene.screenOf({ x: spot.x, y: spot.y });
    const to = scene.screenOf({ x: spot.x + TROPHY.width, y: spot.y + TROPHY.height });
    const width = Math.max(MIN_PX, to.x - from.x);
    const height = Math.max(MIN_PX, to.y - from.y);
    const left = Math.round((from.x + to.x) / 2 - width / 2);
    const top = Math.round((from.y + to.y) / 2 - height / 2);
    const place = `${left}|${top}|${Math.round(width)}|${Math.round(height)}`;
    if (button.dataset.place !== place) {
      button.dataset.place = place;
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      button.style.width = `${Math.round(width)}px`;
      button.style.height = `${Math.round(height)}px`;
    }
    const label = `${spot.name}, shipped ${agoText(spot.at, now)}`;
    if (button.dataset.label !== label) {
      button.dataset.label = label;
      button.title = label;
      button.setAttribute('aria-label', `${label}. Open its summary.`);
    }
  }
  for (const button of [...layer.children]) {
    if (!seen.has((button as HTMLElement).dataset.project ?? '')) button.remove();
  }
}
