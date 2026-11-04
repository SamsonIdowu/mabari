// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { useOfficeSync } from '../data/useOfficeSync.ts';
import type { Route } from '../routes.ts';
import { Accounts } from '../screens/Accounts.tsx';
import { Activity } from '../screens/Activity.tsx';
import { ComponentSheet } from '../screens/ComponentSheet.tsx';
import { Conversations } from '../screens/Conversations.tsx';
import { Home } from '../screens/Home.tsx';
import { NewAgentDialog } from '../screens/NewAgentDialog.tsx';
import { NewProjectDialog } from '../screens/NewProjectDialog.tsx';
import { Office } from '../screens/Office.tsx';
import { Projects } from '../screens/Projects.tsx';
import { Settings } from '../screens/Settings.tsx';
import { StatusScreens } from '../screens/StatusScreens.tsx';
import { Welcome } from '../screens/Welcome.tsx';
import { listenForCompletions } from '../office/ding.ts';
import { useHashRoute } from '../useHashRoute.ts';
import { Rail } from './Rail.tsx';
import { useRailStore } from './railStore.ts';
import { Toasts } from './Toasts.tsx';
import { Topbar } from './Topbar.tsx';

function Screen({ route }: { route: Route }) {
  switch (route) {
    case 'home':
      return <Home />;
    case 'welcome':
      return <Welcome />;
    case 'projects':
      return <Projects />;
    case 'conversations':
      return <Conversations />;
    case 'accounts':
      return <Accounts />;
    case 'activity':
      return <Activity />;
    case 'preferences':
      return <Settings />;
    case 'components':
      return <ComponentSheet />;
    case 'states':
      return <StatusScreens />;
    case 'office':
      return <Office />;
  }
}

export function Shell() {
  useOfficeSync();
  const firstRun = useOfficeStore((state) => state.office?.firstRun ?? null);
  const route = useHashRoute(firstRun);
  const collapsed = useRailStore((state) => state.collapsed);
  const screenRef = useRef<HTMLElement>(null);

  useEffect(() => {
    screenRef.current?.scrollTo({ top: 0 });
  }, [route]);

  useEffect(listenForCompletions, []);

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      <Topbar />
      <Rail current={route} />
      <main className="screen" id="screen" ref={screenRef}>
        {route ? <Screen route={route} /> : null}
      </main>
      <NewAgentDialog />
      <NewProjectDialog />
      <Toasts />
    </div>
  );
}
