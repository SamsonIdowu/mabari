// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useHashRoute } from '../useHashRoute.ts';
import { PlaceholderPage } from './PlaceholderPage.tsx';
import { Rail } from './Rail.tsx';
import { useRailStore } from './railStore.ts';
import { Topbar } from './Topbar.tsx';

/** Stage 1 replaces this with whether any account or agent exists. */
const FIRST_RUN = true;

export function Shell() {
  const route = useHashRoute(FIRST_RUN);
  const collapsed = useRailStore((state) => state.collapsed);
  const screenRef = useRef<HTMLElement>(null);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      <Topbar />
      <Rail current={route} />
      <main className="screen" id="screen" ref={screenRef}>
        <PlaceholderPage route={route} />
      </main>
    </div>
  );
}
