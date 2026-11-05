// SPDX-License-Identifier: Apache-2.0
import { api } from './api.ts';
import { useOfficeStore } from './officeStore.ts';

/** How long until the demo turns itself off, as the toast says it: from the server's own timer. */
export function demoLength(endsAt: number | undefined, now: number): string {
  if (!endsAt || endsAt <= now) return 'It turns itself off soon.';
  const minutes = Math.max(1, Math.round((endsAt - now) / 60_000));
  return `It turns itself off in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** Loads the demo office and goes there. */
export async function exploreDemo() {
  const { endsAt } = await api.loadDemo();
  window.location.hash = '#office';
  useOfficeStore
    .getState()
    .toast(
      `Demo office loaded. Every agent state is on the floor. ${demoLength(endsAt, Date.now())}`,
    );
}
