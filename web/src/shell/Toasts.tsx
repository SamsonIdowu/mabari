// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef } from 'react';
import { addToastFilter, useOfficeStore } from '../data/officeStore.ts';
import { useOfficeUi } from '../office/uiStore.ts';
import { clearOfPanel, repeatsOpenPanel } from './toastSpace.ts';

// An agent's panel shows its reply as it lands, so the toast that points to it would repeat it.
addToastFilter((text) => {
  const { selected } = useOfficeUi.getState();
  const open = useOfficeStore.getState().office?.agents.find((agent) => agent.id === selected);
  return repeatsOpenPanel(text, open?.name ?? null);
});

/** The panel and its message box, as they are on the page now. */
function panelSpace() {
  const panel = document.querySelector('.panel')?.getBoundingClientRect();
  if (!panel) return null;
  const composer = document
    .querySelector('.panel .cmdbar, .panel .pcbox, .panel .restform')
    ?.getBoundingClientRect();
  return { panelLeft: panel.left, panelTop: panel.top, composerTop: composer?.top ?? null };
}

export function Toasts() {
  const toasts = useOfficeStore((state) => state.toasts);
  const showing = toasts.length > 0;
  const box = useRef<HTMLDivElement>(null);
  // While toasts show, keep them out of the way of an open panel, which may open or close.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !showing) return undefined;
    const place = () => {
      const away = clearOfPanel(panelSpace(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      node.style.right = away.right === undefined ? '' : `${away.right}px`;
      node.style.bottom = away.bottom === undefined ? '' : `${away.bottom}px`;
    };
    place();
    const timer = window.setInterval(place, 150);
    return () => window.clearInterval(timer);
  }, [showing]);
  return (
    <div className="toasts" role="status" ref={box}>
      {toasts.slice(-3).map((toast) => (
        <div className="toast" key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
