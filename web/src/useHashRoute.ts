// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { useLibrary } from './office/libraryStore.ts';
import { isRoute, resolveRoute, routeOf, type Route } from './routes.ts';

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
  // Status screens became the Library's first tab, so old #states links open it there.
  if (routeOf(hash) === 'states') {
    useLibrary.getState().set('states');
    window.history.replaceState(null, '', '#components');
    return 'components';
  }
  if (firstRun === null && !isRoute(routeOf(hash))) return null;
  return resolveRoute(hash, firstRun ?? false);
}
