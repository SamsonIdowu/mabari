// SPDX-License-Identifier: Apache-2.0
export const ROUTES = [
  'home',
  'welcome',
  'projects',
  'builder',
  'conversations',
  'accounts',
  'office',
  'activity',
  'preferences',
  'components',
  'states',
] as const;

export type Route = (typeof ROUTES)[number];

/** An unknown hash lands on the welcome page on first run and on Home after that. */
export function isRoute(name: string): name is Route {
  return ROUTES.some((candidate) => candidate === name);
}

/** The page a hash names: `#office?agent=a1` is `office`, as a bare `#office` is. */
export function routeOf(hash: string): string {
  return (hash.replace(/^#/, '').split('?')[0] ?? '').trim();
}

/** One value from the hash's query, such as the agent in `#office?agent=a1`. */
export function hashParam(hash: string, name: string): string | null {
  const query = hash.split('?')[1];
  if (query === undefined) return null;
  return new URLSearchParams(query).get(name) || null;
}

/** A hash for a page, with one value in its query when there is one. */
export function hashWith(route: string, name: string, value: string | null): string {
  return value ? `#${route}?${name}=${encodeURIComponent(value)}` : `#${route}`;
}

export function resolveRoute(hash: string, firstRun: boolean): Route {
  const name = routeOf(hash);
  const route = ROUTES.find((candidate) => candidate === name);
  return route ?? (firstRun ? 'welcome' : 'home');
}
