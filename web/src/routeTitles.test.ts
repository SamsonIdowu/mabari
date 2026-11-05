// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { routeTitle } from './routeTitles.ts';
import { ROUTES } from './routes.ts';

describe('routeTitle', () => {
  it('names the page before the product', () => {
    expect(routeTitle('office')).toBe('Agents · Mabari');
    expect(routeTitle('preferences')).toBe('Settings · Mabari');
  });

  it('gives every page its own title, and the product name while it loads', () => {
    for (const route of ROUTES) expect(routeTitle(route)).toMatch(/ · Mabari$/);
    const titles = new Set(ROUTES.filter((route) => route !== 'states').map(routeTitle));
    expect(titles.size).toBe(ROUTES.length - 1);
    expect(routeTitle(null)).toBe('Mabari');
  });
});
