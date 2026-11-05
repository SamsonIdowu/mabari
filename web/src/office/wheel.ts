// SPDX-License-Identifier: Apache-2.0
// What a turn of the wheel over the floor means. The floor zooms with the wheel, but where the page
// is taller than the window, as at 200% zoom or on a narrow screen, the floor fills most of the
// view, and a wheel that always zoomed it left nowhere to scroll the page from (RT-8).

/** What the floor does with a wheel event. */
export type WheelUse = 'pan' | 'zoom' | 'scroll';

/** The parts of a wheel event that decide what it means. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** How far a wheel event moves sideways: along the x axis, or the y axis with Shift held. */
export function sidewaysOf(event: Pick<WheelLike, 'deltaX' | 'deltaY' | 'shiftKey'>): number {
  return event.shiftKey ? event.deltaY || event.deltaX : event.deltaX;
}

/**
 * Sideways moves along a wide office. Up and down zooms, with Ctrl or Command held, which is also
 * how a pinch on a trackpad arrives, or when the page has nothing to scroll. Otherwise it is the
 * page's: the floor leaves it alone so the page scrolls.
 */
export function wheelUse(event: WheelLike, pageScrolls: boolean): WheelUse {
  if (Math.abs(sidewaysOf(event)) > Math.abs(event.shiftKey ? 0 : event.deltaY)) return 'pan';
  if (pageScrolls && !event.ctrlKey && !event.metaKey) return 'scroll';
  return 'zoom';
}

/** Whether the page the floor sits in can scroll up or down: an ancestor that overflows and scrolls. */
export function pageScrolls(from: Element): boolean {
  for (let element = from.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    const scrolls =
      element === document.documentElement
        ? overflowY !== 'hidden'
        : overflowY === 'auto' || overflowY === 'scroll';
    if (scrolls && element.scrollHeight > element.clientHeight + 1) return true;
  }
  return false;
}
