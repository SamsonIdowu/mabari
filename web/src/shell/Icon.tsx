// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}
