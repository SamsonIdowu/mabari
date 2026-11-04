// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { isRoute, resolveRoute, type Route } from './routes.ts';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * The page to show. With no known page in the hash the choice depends on first run, so it is null
 * until the office has loaded, rather than a guess that flashes Welcome at a returning user.
 */
export function useHashRoute(firstRun: boolean | null): Route | null {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  if (firstRun === null && !isRoute(hash.replace('#', ''))) return null;
  return resolveRoute(hash, firstRun ?? false);
}
