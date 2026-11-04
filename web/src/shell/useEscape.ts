// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';

/** Calls `close` when the Escape key is pressed, for as long as the caller is on screen. */
export function useEscape(close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
