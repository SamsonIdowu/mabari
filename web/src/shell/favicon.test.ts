// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { themes } from '../shared/tokens.ts';
import { FAVICON_URL, faviconHref, faviconSvg, setFavicon } from './favicon.ts';

describe('the tab icon', () => {
  it('is the file in public, so the page and the browser draw the same head', () => {
    expect(readFileSync('public/favicon.svg', 'utf8').trim()).toBe(faviconSvg(false));
  });

  it('has no dot until an approval or an error waits, and then a red one', () => {
    expect(faviconSvg(false)).not.toContain('alert-dot');
    expect(faviconHref(false)).toBe(FAVICON_URL);
    const withDot = decodeURIComponent(faviconHref(true).replace('data:image/svg+xml,', ''));
    expect(withDot).toBe(faviconSvg(true));
    expect(withDot).toContain('id="alert-dot"');
    // The same red as the badges.
    expect(withDot).toContain(`fill="${themes.dark['red-fill']}"`);
  });
});

describe('setFavicon', () => {
  const links: Record<string, string>[] = [];

  beforeEach(() => {
    links.length = 0;
    const head = {
      querySelector: () => {
        const last = links.at(-1);
        return last
          ? {
              getAttribute: () => last['href'],
              remove: () => links.pop(),
            }
          : null;
      },
      append: (link: Record<string, string>) => links.push(link),
    };
    vi.stubGlobal('document', {
      head,
      createElement: () => ({
        dataset: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          (this as unknown as Record<string, string>)[name] = value;
        },
      }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('puts the icon in the page once, and replaces it when the dot comes and goes', () => {
    setFavicon(false);
    setFavicon(false);
    expect(links).toHaveLength(1);
    expect(links[0]?.['href']).toBe(FAVICON_URL);
    setFavicon(true);
    expect(links).toHaveLength(1);
    expect(links[0]?.['href']).toContain('data:image/svg+xml');
    setFavicon(false);
    expect(links).toHaveLength(1);
    expect(links[0]?.['href']).toBe(FAVICON_URL);
  });
});
