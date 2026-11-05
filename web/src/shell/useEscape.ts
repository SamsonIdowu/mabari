// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { openDialogs } from './modalStack.ts';

/**
 * Calls `close` when the Escape key is pressed, for as long as the caller is on screen. Escape
 * belongs to the layer on top: while a dialog opened after the caller is open, the key is that
 * dialog's, and the caller closes on the next press. A dialog counts itself, since it is open by
 * the time this runs.
 */
export function useEscape(close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    const openWhenShown = openDialogs();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openDialogs() <= openWhenShown) latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
