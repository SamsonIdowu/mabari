// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { currentOpener, returnFocus } from './modalStack.ts';

/**
 * For a panel that opens beside the page rather than over it: when it closes and takes focus with
 * it, focus goes back to the control that opened it. Focus that moved somewhere real is left alone.
 */
export function useReturnFocus() {
  const [opener] = useState(currentOpener);
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body) returnFocus(opener);
    },
    [opener],
  );
}
