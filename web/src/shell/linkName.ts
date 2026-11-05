// SPDX-License-Identifier: Apache-2.0
import type { NavItem } from './navItems.tsx';

/**
 * The words a rail badge stands for, which the digits alone don't say: "2 need you" for the Agents
 * link, "1 new reply" for Home. Empty when the item's badge shows nothing.
 */
export function badgeWords(
  item: Pick<NavItem, 'badge'>,
  counts: { needs: number; unread: number },
): string {
  if (item.badge === 'needs' && counts.needs) {
    return `${counts.needs} ${counts.needs === 1 ? 'needs' : 'need'} you`;
  }
  if (item.badge === 'unread' && counts.unread) {
    return `${counts.unread} new ${counts.unread === 1 ? 'reply' : 'replies'}`;
  }
  return '';
}

/**
 * The rail link's accessible name, or undefined to let its text name it. The visible label must be
 * part of the name, for people who speak to their computer, and any count is said in words after
 * it: "Agents, 2 need you". The whole name is given here, not built from the badge's hidden text,
 * because a browser puts a space before each part it joins, which read "Agents , 2 need you"
 * (RT-7). While the "live" badge shows, the link's own text names it, so the badge is part of the
 * name too.
 */
export function linkName(
  item: Pick<NavItem, 'label' | 'name' | 'badge'>,
  live: boolean,
  counts: { needs: number; unread: number },
): string | undefined {
  const words = badgeWords(item, counts);
  if (words) return `${item.label}, ${words}`;
  if (live || !item.name) return undefined;
  return item.name.toLowerCase().includes(item.label.toLowerCase())
    ? item.name
    : `${item.label}, ${item.name.toLowerCase()}`;
}
