// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { hashParam, hashWith, ROUTES, resolveRoute, routeOf } from './routes.ts';

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
    expect(resolveRoute('', false)).toBe('home');
    expect(resolveRoute('#nope', false)).toBe('home');
  });

  it('reads the page from a hash that has a query', () => {
    expect(resolveRoute('#office?agent=a1', false)).toBe('office');
    expect(resolveRoute('#projects?chat=shop', true)).toBe('projects');
    expect(resolveRoute('#nope?agent=a1', false)).toBe('home');
  });
});

describe('the hash query', () => {
  it('names the page with or without a query', () => {
    expect(routeOf('#office')).toBe('office');
    expect(routeOf('#office?agent=a1')).toBe('office');
    expect(routeOf('')).toBe('');
  });

  it('reads and writes one value, escaping what needs it', () => {
    expect(hashParam('#office?agent=a1', 'agent')).toBe('a1');
    expect(hashParam('#office', 'agent')).toBeNull();
    expect(hashParam('#office?agent=', 'agent')).toBeNull();
    expect(hashParam('#office?other=1', 'agent')).toBeNull();
    expect(hashWith('office', 'agent', 'def:my reader')).toBe('#office?agent=def%3Amy%20reader');
    expect(hashParam(hashWith('office', 'agent', 'def:my reader'), 'agent')).toBe('def:my reader');
    expect(hashWith('office', 'agent', null)).toBe('#office');
  });
});
