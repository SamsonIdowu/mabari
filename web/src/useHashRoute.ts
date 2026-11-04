import { useSyncExternalStore } from 'react';
import { resolveRoute, type Route } from './routes.ts';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useHashRoute(firstRun: boolean): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return resolveRoute(hash, firstRun);
}
