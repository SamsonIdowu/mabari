// SPDX-License-Identifier: Apache-2.0
export const ROUTES = [
  'welcome',
  'projects',
  'conversations',
  'accounts',
  'office',
  'activity',
  'preferences',
  'components',
  'states',
] as const;

export type Route = (typeof ROUTES)[number];

/** An unknown hash lands on the welcome page on first run and on the office after that. */
export function resolveRoute(hash: string, firstRun: boolean): Route {
  const name = hash.replace('#', '');
  const route = ROUTES.find((candidate) => candidate === name);
  return route ?? (firstRun ? 'welcome' : 'office');
}
