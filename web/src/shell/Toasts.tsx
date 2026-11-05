// SPDX-License-Identifier: Apache-2.0
import { createPortal } from 'react-dom';
import { useOfficeStore } from '../data/officeStore.ts';
import { liveHost } from './modalStack.ts';

export function Toasts() {
  const toasts = useOfficeStore((state) => state.toasts);
  // Outside #root, so a toast that appears while a dialog is open is still announced.
  return createPortal(
    <div className="toasts" role="status">
      {toasts.slice(-3).map((toast) => (
        <div className="toast" key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>,
    liveHost(),
  );
}
