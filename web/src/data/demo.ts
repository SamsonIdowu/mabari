// SPDX-License-Identifier: Apache-2.0
import { api } from './api.ts';
import { useOfficeStore } from './officeStore.ts';

/** Loads the demo office and goes there. */
export async function exploreDemo() {
  await api.loadDemo();
  window.location.hash = '#office';
  useOfficeStore
    .getState()
    .toast(
      'Demo office loaded. Every agent state is on the floor. It turns itself off in 10 minutes.',
    );
}
