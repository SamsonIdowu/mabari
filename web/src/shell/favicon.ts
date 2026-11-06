// SPDX-License-Identifier: Apache-2.0
import { themes } from '../shared/tokens.ts';

/** The static icon, which web/public/favicon.svg holds and a test keeps in step with the drawing. */
export const FAVICON_URL = '/favicon.svg';

/** Mabari's head, as in MabariHead, with a fixed rim: an icon can't read the page's colours. */
const HEAD =
  '<circle cx="16" cy="16.5" r="13.6" fill="#1E1E20" stroke="#8E8E93" stroke-width="1.4"/>' +
  '<path d="M4.2 15.2A11.8 11.8 0 0 1 27.8 15.2" fill="none" stroke="#F4F4F4" stroke-width="2.2" stroke-linecap="round"/>' +
  '<ellipse cx="16" cy="18" rx="9.6" ry="7.6" fill="#FFFFFF"/>' +
  '<ellipse cx="12.4" cy="17" rx="1.7" ry="2.1" fill="#0C0C0C"/>' +
  '<ellipse cx="19.6" cy="17" rx="1.7" ry="2.1" fill="#0C0C0C"/>' +
  '<circle cx="11.9" cy="16.3" r=".6" fill="#fff"/>' +
  '<circle cx="19.1" cy="16.3" r=".6" fill="#fff"/>' +
  '<path d="M12.6 21.3Q15.8 23.6 19.2 21" fill="none" stroke="#0C0C0C" stroke-width="1.3" stroke-linecap="round"/>' +
  '<path d="M27.6 19.6Q27 23.4 21.6 22.6" fill="none" stroke="#0C0C0C" stroke-width="1.1" stroke-linecap="round"/>' +
  '<circle cx="21.2" cy="22.5" r="1.1" fill="#0C0C0C"/>' +
  '<ellipse cx="28.2" cy="17.2" rx="2.5" ry="3.4" fill="#F4F4F4" stroke="#0C0C0C" stroke-width="1.1"/>';

/**
 * The same red as the badges that count approvals and errors. A dot, so it reads at 16 px, and
 * only ever for those two: a question waits quietly and gets none (only red and amber ask).
 */
const DOT =
  `<circle id="alert-dot" cx="24.5" cy="7.5" r="6.5" fill="${themes.dark['red-fill']}"` +
  ' stroke="#FFFFFF" stroke-width="1.6"/>';

/** The icon as SVG text: Mabari's head, with the red dot while an approval or an error waits. */
export function faviconSvg(dot: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${HEAD}${dot ? DOT : ''}</svg>`;
}

/** Where the tab icon is loaded from: the file, or with the dot an image made on the spot. */
export function faviconHref(dot: boolean): string {
  return dot ? `data:image/svg+xml,${encodeURIComponent(faviconSvg(true))}` : FAVICON_URL;
}

/**
 * Puts the icon in the tab. The link is replaced rather than changed, because some browsers keep
 * showing the old icon when only its address changes.
 */
export function setFavicon(dot: boolean): void {
  const href = faviconHref(dot);
  const current = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (current?.getAttribute('href') === href) return;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.setAttribute('href', href);
  link.dataset.alert = String(dot);
  current?.remove();
  document.head.append(link);
}
