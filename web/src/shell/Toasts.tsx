// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';

export function Toasts() {
  const toasts = useOfficeStore((state) => state.toasts);
  return (
    <div className="toasts" role="status">
      {toasts.slice(-3).map((toast) => (
        <div className="toast" key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
