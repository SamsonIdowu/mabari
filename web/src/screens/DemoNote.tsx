// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { api } from '../data/api.ts';
import { useOfficeStore } from '../data/officeStore.ts';
import type { Snapshot } from '../gen/models.ts';
import { Icon } from '../shell/Icon.tsx';

/** Turns the demo off, as the banner on the Agents page does. */
function turnOffDemo() {
  const toast = useOfficeStore.getState().toast;
  void api
    .stopDemo()
    .then(() => toast('The demo has stopped. Only real agents show now.'))
    .catch((error: unknown) => toast(error instanceof Error ? error.message : 'Try again'));
}

/**
 * Marks a screen that shows the demo's pretend state, such as accounts that look connected. The
 * Agents page has its own banner; this is the same marker for the pages that don't.
 */
export function DemoNote({ office, children }: { office: Snapshot; children: ReactNode }) {
  if (!office.demo) return null;
  return (
    <div className="banner" id="demoNote" role="note" style={{ marginBottom: 16 }}>
      <Icon>
        <path d="M12 8v5M12 16h.01" />
        <circle cx="12" cy="12" r="9" />
      </Icon>
      <span className="grow">
        <b>Demo.</b> {children}
      </span>
      <button type="button" className="btn sm" onClick={turnOffDemo}>
        Turn off the demo
      </button>
    </div>
  );
}
