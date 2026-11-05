// SPDX-License-Identifier: Apache-2.0
import type { Route } from './routes.ts';

const NAME = 'Mabari';

/** The name of each page, as its heading and the menu say it. */
const PAGES: Record<Route, string> = {
  home: 'Home',
  welcome: 'Welcome',
  projects: 'Projects',
  builder: 'Agent builder',
  conversations: 'Conversations',
  accounts: 'Accounts',
  office: 'Agents',
  activity: 'Activity log',
  preferences: 'Settings',
  components: 'Library',
  states: 'Library',
};

/** The browser tab and window title for a page, so a screen reader hears where you are. */
export function routeTitle(route: Route | null): string {
  return route ? `${PAGES[route]} · ${NAME}` : NAME;
}
