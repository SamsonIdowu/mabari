import { useEffect, useRef } from 'react';
import { useHashRoute } from '../useHashRoute.ts';
import { PlaceholderPage } from './PlaceholderPage.tsx';
import { Rail } from './Rail.tsx';

/** Stage 1 replaces this with whether any account or agent exists. */
const FIRST_RUN = true;

export function Shell() {
  const route = useHashRoute(FIRST_RUN);
  const screenRef = useRef<HTMLElement>(null);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className="app">
      <Rail current={route} />
      <main className="screen" id="screen" ref={screenRef}>
        <PlaceholderPage route={route} />
      </main>
    </div>
  );
}
