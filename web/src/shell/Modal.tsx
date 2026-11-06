// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { currentOpener, holdModal, modalHost } from './modalStack.ts';

/**
 * The shell of every modal dialog. It draws the dark scrim and the dialog in its own place on the
 * page, outside #root, so the page behind can be made inert. While it is open focus moves in and
 * Tab goes round it, and closing puts focus back on the control that opened it.
 */
export function Modal({
  children,
  onBackdrop,
}: {
  children: ReactNode;
  /** Called for a click on the dimmed page around the dialog, not on the dialog itself. */
  onBackdrop?: () => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  // Read while the dialog first renders, before it or anything in it takes focus.
  const [opener] = useState(currentOpener);
  useLayoutEffect(() => (scrim.current ? holdModal(scrim.current, opener) : undefined), [opener]);
  return createPortal(
    <div
      className="scrim"
      ref={scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onBackdrop?.();
      }}
    >
      {children}
    </div>,
    modalHost(),
  );
}
