// SPDX-License-Identifier: Apache-2.0
// What every modal dialog promises with aria-modal="true": focus moves in and stays in, the page
// behind cannot be reached, and closing puts focus back where it was. This file does the DOM work;
// Modal.tsx is the component every dialog sits in.

const MODAL_HOST = 'modal-root';
const LIVE_HOST = 'live-root';

/** An element on <body>, next to #root, that dialogs and live announcements are drawn into. */
function bodyHost(id: string, exempt: boolean): HTMLElement {
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    if (exempt) host.dataset.modalExempt = '';
    document.body.append(host);
  }
  return host;
}

/** Where open dialogs live. The page behind them is #root and everything else on <body>. */
export const modalHost = () => bodyHost(MODAL_HOST, false);

/**
 * Where toasts and spoken announcements live. It is outside #root so it stays out of the inert
 * page behind a dialog: a message that arrives while a dialog is open must still be heard.
 */
export const liveHost = () => bodyHost(LIVE_HOST, true);

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]';

function reachable(element: HTMLElement): boolean {
  if (element.matches(':disabled') || element.tabIndex < 0) return false;
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  if (element.closest('[inert],[hidden]')) return false;
  const style = getComputedStyle(element);
  return (
    style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
  );
}

/** What Tab stops on inside `root`, in order. A group of radio buttons is one stop. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
  return found.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) {
      return true;
    }
    const group = found.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement &&
        other.type === 'radio' &&
        other.name === element.name &&
        other.form === element.form,
    );
    return element === (group.find((radio) => radio.checked) ?? group[0]);
  });
}

/**
 * Which stop Tab or Shift+Tab should jump to so focus stays in a dialog with `count` stops, or null
 * when the browser's own move already stays inside. `at` is the focused stop, or -1 for none.
 */
export function wrapTarget(at: number, count: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (backwards) return at <= 0 ? count - 1 : null;
  return at === count - 1 ? 0 : null;
}

/** The control that has focus now, if it is a real one, so focus can go back to it later. */
export function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

// Open dialogs, the newest last. Only the newest takes Tab and is not inert.
const stack: HTMLElement[] = [];
// What this file made inert, so it never undoes an inert it did not set.
const made = new Set<Element>();

const NOT_RENDERED = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE']);

/** Makes everything but the newest dialog inert, or lifts it all when none is open. */
function syncInert() {
  const top = stack.at(-1);
  const want = new Set<Element>();
  if (top) {
    const dialogs = modalHost();
    for (const child of document.body.children) {
      if (child === dialogs || NOT_RENDERED.has(child.tagName)) continue;
      if (child instanceof HTMLElement && child.dataset.modalExempt !== undefined) continue;
      want.add(child);
    }
    for (const child of dialogs.children) if (child !== top) want.add(child);
  }
  for (const element of made) {
    if (want.has(element)) continue;
    element.removeAttribute('inert');
    made.delete(element);
  }
  for (const element of want) {
    if (made.has(element) || element.hasAttribute('inert')) continue;
    element.setAttribute('inert', '');
    made.add(element);
  }
}

/** Tab and Shift+Tab go round the open dialog, and back into it if focus got out. */
function trapTab(event: KeyboardEvent) {
  const top = stack.at(-1);
  if (event.key !== 'Tab' || !top || event.defaultPrevented) return;
  const stops = tabbables(top);
  const last = stops.at(-1);
  if (!last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  let target: HTMLElement | undefined;
  if (!(active instanceof HTMLElement) || !top.contains(active)) {
    target = event.shiftKey ? last : stops[0];
  } else {
    const at = stops.indexOf(active);
    // Past the last stop, on something Tab does not stop on, counts as being on the last stop.
    const past =
      at < 0 && !!(last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
    const to = wrapTarget(past ? stops.length - 1 : at, stops.length, event.shiftKey);
    target = to === null ? undefined : stops[to];
  }
  if (!target) return;
  event.preventDefault();
  target.focus();
}

/** Moves focus into the dialog, unless something inside it already took it. */
function focusInto(scrim: HTMLElement) {
  if (scrim.contains(document.activeElement)) return;
  const dialog = scrim.querySelector<HTMLElement>('[role="dialog"]') ?? scrim;
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  dialog.focus({ preventScroll: true });
}

function focusMain() {
  const main = document.getElementById('screen');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
}

/** How long to wait to see whether the control focus went back to is taken away by what was decided. */
const SETTLE_MS = 500;

/**
 * Puts focus back on the control that opened a dialog or panel. If that control is gone, it goes
 * to the page's main area, so the next Tab does not start again from the top of the page. The
 * same if the control goes a moment later, as an approval's Review does once it is answered.
 */
export function returnFocus(opener: HTMLElement | null) {
  if (!opener) return;
  if (opener.isConnected) opener.focus();
  if (document.activeElement !== opener) {
    focusMain();
    return;
  }
  window.setTimeout(() => {
    const active = document.activeElement;
    if (!opener.isConnected && (!active || active === document.body)) focusMain();
  }, SETTLE_MS);
}

/** Opens a dialog. Returns the function that closes it. */
export function holdModal(scrim: HTMLElement, opener: HTMLElement | null): () => void {
  if (!stack.length) document.addEventListener('keydown', trapTab);
  stack.push(scrim);
  syncInert();
  focusInto(scrim);
  return () => {
    const at = stack.indexOf(scrim);
    if (at >= 0) stack.splice(at, 1);
    if (!stack.length) document.removeEventListener('keydown', trapTab);
    syncInert();
    returnFocus(opener);
  };
}
