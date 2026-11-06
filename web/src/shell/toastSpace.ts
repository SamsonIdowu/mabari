// SPDX-License-Identifier: Apache-2.0
// Where toasts go while a side panel is open, and which toasts it makes pointless.
import type { LiveAgent } from '../gen/models.ts';

/** The widest a toast is, plus the space either side of it. */
const TOAST_ROOM = 340 + 2 * 16;
const GAP = 16;

/** Where the open side panel is, and where the box to type into starts, in window pixels. */
export interface PanelSpace {
  panelLeft: number;
  panelTop: number;
  /** The top of the panel's message box, or null when it has none. */
  composerTop: number | null;
}

/**
 * Toasts sit at the bottom right, which is where a side panel keeps its message box and Send
 * button. With a panel open they move to the panel's left, and in a window too narrow for that,
 * where the panel fills it, they lift to sit above the message box.
 */
export function clearOfPanel(
  panel: PanelSpace | null,
  view: { width: number; height: number },
): { right?: number; bottom?: number } {
  if (!panel) return {};
  if (panel.panelLeft >= TOAST_ROOM) return { right: view.width - panel.panelLeft + GAP };
  return { bottom: view.height - (panel.composerTop ?? panel.panelTop) + GAP };
}

/**
 * True for the server's "Ledger replied. Open Ledger to read it." while Ledger's own panel is
 * open, since the reply is already there to read. The one toast "Sent to Ledger" is enough.
 */
export function repeatsOpenPanel(text: string, openAgent: string | null): boolean {
  return openAgent !== null && text.startsWith(`${openAgent} replied.`);
}

/** The same for a chat on screen: the agent's own thread, or the project's it works in. */
export function repeatsOpenChat(
  text: string,
  place: { agent: string | null; project: string | null },
  agents: readonly Pick<LiveAgent, 'id' | 'name' | 'projectId'>[],
): boolean {
  return agents.some(
    (agent) =>
      (agent.id === place.agent || (place.project !== null && agent.projectId === place.project)) &&
      repeatsOpenPanel(text, agent.name),
  );
}
