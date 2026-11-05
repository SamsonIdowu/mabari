// SPDX-License-Identifier: Apache-2.0
import { createPortal } from 'react-dom';
import { useOfficeStore } from '../data/officeStore.ts';
import { approvalAnnouncement } from '../office/approvalText.ts';
import { liveHost } from './modalStack.ts';

/**
 * Says aloud, for a screen reader, that an approval is waiting and for what, on any page. It is
 * the one thing the product lets interrupt, and an agent sits blocked until someone answers.
 */
export function ApprovalAnnouncer() {
  const text = useOfficeStore((state) => approvalAnnouncement(state.office?.agents ?? []));
  return createPortal(
    <div className="sr" id="approvalLive" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>,
    liveHost(),
  );
}
