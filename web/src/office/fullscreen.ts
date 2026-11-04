// SPDX-License-Identifier: Apache-2.0
import { useOfficeUi } from './uiStore.ts';

/** Keeps the floor, command bar, agent panel and dialogs, and hides the rest of the app. */
export function toggleFullscreen() {
  const { fullscreen, set } = useOfficeUi.getState();
  if (fullscreen) {
    set({ fullscreen: false });
    if (document.fullscreenElement) void document.exitFullscreen();
    return;
  }
  set({ fullscreen: true });
  document.documentElement.requestFullscreen?.().catch(() => undefined);
}
