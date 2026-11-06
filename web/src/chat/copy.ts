// SPDX-License-Identifier: Apache-2.0
import { useOfficeStore } from '../data/officeStore.ts';

/** Copies text, and says so, or says to copy it by hand when the browser refuses. */
export function copyText(text: string, done: string) {
  const toast = useOfficeStore.getState().toast;
  void Promise.resolve(navigator.clipboard?.writeText(text))
    .then(() => toast(done))
    .catch(() => toast('Copy it by hand: the browser refused the clipboard.'));
}
