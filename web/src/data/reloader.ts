// SPDX-License-Identifier: Apache-2.0
import type { ServerMessage, Snapshot } from '../gen/models.ts';

/** What a reloader needs from the page. */
export interface ReloaderParts {
  snapshot: () => Promise<Snapshot>;
  setSnapshot: (snapshot: Snapshot) => void;
  applyAll: (messages: ServerMessage[]) => void;
  /** Hands on what came before the snapshot was asked for, in order. */
  flush: () => void;
  /** True once the page has gone, so a snapshot that lands late is dropped. */
  stopped: () => boolean;
}

/**
 * Loads the office's snapshot and keeps the changes that stream in meanwhile, so nothing is lost
 * or applied twice: those newer than the snapshot go in after it.
 *
 * Reloads can overlap, as when a resync arrives while one is in flight. Each takes a number, and
 * only the newest applies its snapshot and the held changes: an older one that lands later is
 * dropped, because the newest asked for the office after it and will have more. Without that they
 * shared the held list, the first to land emptied it, and the second applied nothing and threw,
 * which made the page load the snapshot yet again (REV-7).
 */
export function reloader(parts: ReloaderParts) {
  // Changes that arrive while a snapshot is loading wait here.
  let waiting: ServerMessage[] | null = null;
  let generation = 0;
  return {
    /** Keeps a change for after the snapshot, if one is loading. False means apply it now. */
    hold(message: ServerMessage): boolean {
      if (!waiting) return false;
      waiting.push(message);
      return true;
    },
    async reload(): Promise<void> {
      const mine = ++generation;
      parts.flush();
      waiting ??= [];
      try {
        const snapshot = await parts.snapshot();
        // Gone, or a newer reload is on its way and will apply its own snapshot.
        if (parts.stopped() || mine !== generation) return;
        parts.setSnapshot(snapshot);
        parts.applyAll(waiting ?? []);
      } finally {
        if (mine === generation) waiting = null;
      }
    },
  };
}
