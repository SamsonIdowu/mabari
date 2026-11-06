// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { useOfficeStore } from '../data/officeStore.ts';
import { listenForNotifications } from '../office/notifications.ts';
import { urgent, whoNeedsYou } from '../office/uiStore.ts';
import type { Route } from '../routes.ts';
import { tabTitle } from '../routeTitles.ts';
import { setFavicon } from './favicon.ts';

/**
 * What the browser tab shows when the page isn't in front. The title leads with how many need
 * you, by the one definition every count uses (decision 1 of the first UX round), and the icon
 * gets a red dot while an approval or an error waits. A question waits quietly, so it adds to the
 * title's count and not to the dot: only approvals and errors are red.
 */
export function useTabAlerts(route: Route | null): void {
  const needs = useOfficeStore((state) => whoNeedsYou(state.office?.agents ?? []).length);
  const redWaiting = useOfficeStore((state) =>
    whoNeedsYou(state.office?.agents ?? []).some(urgent),
  );
  // The title is also what a screen reader reads when the page changes.
  useEffect(() => {
    document.title = tabTitle(route, needs);
  }, [route, needs]);
  useEffect(() => {
    setFavicon(redWaiting);
  }, [redWaiting]);
  // Desktop notifications, when they are on and the page is hidden.
  useEffect(listenForNotifications, []);
}
