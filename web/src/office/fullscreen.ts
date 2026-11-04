// SPDX-License-Identifier: Apache-2.0
import { useOfficeUi } from './uiStore.ts';

/** Fills the screen with the office, or fills the window if the browser refuses. */
export function toggleFullscreen() {
  const { maximised, set } = useOfficeUi.getState();
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  if (maximised) {
    set({ maximised: false });
    return;
  }
  const stage = document.getElementById('stage');
  if (stage?.requestFullscreen) {
    stage.requestFullscreen().catch(() => set({ maximised: true }));
  } else {
    set({ maximised: true });
  }
}

/** Only the office shows in real full screen, so anything outside it needs full screen closed. */
export function leaveFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  useOfficeUi.getState().set({ maximised: false });
}
