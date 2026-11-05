// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { escapeIsFor, openDialogList } from './modalStack.ts';

/**
 * Calls `close` when the Escape key is pressed, for as long as the caller is on screen. Escape
 * belongs to the layer on top: while a dialog opened after the caller is open, the key is that
 * dialog's, and the caller closes on the next press. A dialog counts itself, since it is open by
 * the time this runs. Which dialogs were open then is remembered, not how many, so a dialog under
 * the caller closing never lets the key through to a layer with another over it (REV-5).
 */
export function useEscape(close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    const shownOver = new Set(openDialogList());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escapeIsFor(shownOver, openDialogList())) latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
