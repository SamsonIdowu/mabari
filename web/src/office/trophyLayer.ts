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
const MIN_PX = 24;

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
  for (const button of [...layer.querySelectorAll<HTMLElement>(':scope > .trophy')]) {
    if (!seen.has(button.dataset.project ?? '')) button.remove();
  }
  placeMore(layer, scene);
}

/**
 * The "+N" tile in the display's last place, when there are more trophies than it holds. It is a
 * link to the Projects page, where every completed project is, and it names how many are not
 * shown. Like the trophy buttons it is in the page so the keyboard and a screen reader reach it.
 */
function placeMore(layer: HTMLElement, scene: OfficeScene): void {
  const more = scene.trophies.more;
  let button = layer.querySelector<HTMLAnchorElement>(':scope > .trophymore');
  if (!more) {
    button?.remove();
    return;
  }
  if (!button) {
    button = document.createElement('a');
    button.className = 'trophymore';
    button.href = '#projects';
    layer.appendChild(button);
  }
  const from = scene.screenOf({ x: more.x, y: more.y });
  const to = scene.screenOf({ x: more.x + TROPHY.width, y: more.y + TROPHY.height });
  const width = Math.max(MIN_PX, to.x - from.x);
  const height = Math.max(MIN_PX, to.y - from.y);
  const left = Math.round((from.x + to.x) / 2 - width / 2);
  const top = Math.round((from.y + to.y) / 2 - height / 2);
  const place = `${left}|${top}|${Math.round(width)}|${Math.round(height)}|${more.hidden}`;
  if (button.dataset.place === place) return;
  button.dataset.place = place;
  button.style.left = `${left}px`;
  button.style.top = `${top}px`;
  button.style.width = `${Math.round(width)}px`;
  button.style.height = `${Math.round(height)}px`;
  button.textContent = `+${more.hidden}`;
  const label = `${more.hidden} more shipped project${more.hidden === 1 ? '' : 's'}`;
  button.title = `${label}. Open the Projects page.`;
  button.setAttribute('aria-label', `${label}. Open the Projects page.`);
}
