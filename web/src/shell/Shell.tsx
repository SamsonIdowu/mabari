// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { useOfficeSync } from '../data/useOfficeSync.ts';
import type { Route } from '../routes.ts';
import { Accounts } from '../screens/Accounts.tsx';
import { Activity } from '../screens/Activity.tsx';
import { Conversations } from '../screens/Conversations.tsx';
import { Home } from '../screens/Home.tsx';
import { DeskDialog } from '../screens/DeskDialog.tsx';
import { NewAgentDialog } from '../screens/NewAgentDialog.tsx';
import { NewProjectDialog } from '../screens/NewProjectDialog.tsx';
import { Office } from '../screens/Office.tsx';
import { Builder } from '../screens/Builder.tsx';
import { Projects } from '../screens/Projects.tsx';
import { Settings } from '../screens/Settings.tsx';
import { Library } from '../screens/Library.tsx';
import { Welcome } from '../screens/Welcome.tsx';
import { listenForApprovals } from '../office/ding.ts';
import { useHashRoute } from '../useHashRoute.ts';
import { ApprovalAnnouncer } from './ApprovalAnnouncer.tsx';
import { QuickSwitcher } from './QuickSwitcher.tsx';
import { Rail } from './Rail.tsx';
import { useRailStore } from './railStore.ts';
import { Toasts } from './Toasts.tsx';
import { TrustDialog } from './TrustDialog.tsx';
import { Topbar } from './Topbar.tsx';
import { useTabAlerts } from './useTabAlerts.ts';

function Screen({ route }: { route: Route }) {
  switch (route) {
    case 'home':
      return <Home />;
    case 'welcome':
      return <Welcome />;
    case 'projects':
      return <Projects />;
    case 'builder':
      return <Builder />;
    case 'conversations':
      return <Conversations />;
    case 'accounts':
      return <Accounts />;
    case 'activity':
      return <Activity />;
    case 'preferences':
      return <Settings />;
    case 'components':
    case 'states':
      return <Library />;
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

  // The tab's title and icon, which also say how many need you while the page is behind another.
  useTabAlerts(route);

  useEffect(listenForApprovals, []);

  return (
    <div className={collapsed ? 'app collapsed' : 'app'}>
      <Topbar />
      <Rail current={route} />
      <main className="screen" id="screen" ref={screenRef} tabIndex={-1}>
        {route ? <Screen route={route} /> : null}
      </main>
      <NewAgentDialog />
      <DeskDialog />
      <NewProjectDialog />
      <TrustDialog />
      <QuickSwitcher />
      <ApprovalAnnouncer />
      <Toasts />
    </div>
  );
}
