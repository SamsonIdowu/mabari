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

/**
 * The tab's title while someone needs you: the count leads, as in `(2) Agents · Mabari`, so it is
 * seen in a row of tabs and in the window list. The count is the one "needs you" every other
 * count uses, and it is left off when nobody does.
 */
export function tabTitle(route: Route | null, needs: number): string {
  const title = routeTitle(route);
  return needs > 0 ? `(${needs}) ${title}` : title;
}
