// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ROUTES, resolveRoute } from './routes.ts';

describe('resolveRoute', () => {
  it.each(ROUTES)('keeps the known route %s', (route) => {
    expect(resolveRoute(`#${route}`, true)).toBe(route);
    expect(resolveRoute(`#${route}`, false)).toBe(route);
  });

  it('falls back to welcome on first run', () => {
    expect(resolveRoute('', true)).toBe('welcome');
    expect(resolveRoute('#nope', true)).toBe('welcome');
  });

  it('falls back to the office after first run', () => {
    expect(resolveRoute('', false)).toBe('office');
    expect(resolveRoute('#nope', false)).toBe('office');
  });
});
