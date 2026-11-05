// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { badgeWords, linkName } from './linkName.ts';

const agents = { label: 'Agents', badge: 'needs' as const };
const home = { label: 'Home', badge: 'unread' as const };
const chats = { label: 'Chats', name: 'Conversations', badge: 'live' as const };
const none = { needs: 0, unread: 0 };

describe('the rail link name', () => {
  it('says how many need you in words, with the comma against the label and no stray space', () => {
    expect(linkName(agents, false, { needs: 2, unread: 0 })).toBe('Agents, 2 need you');
    expect(linkName(agents, false, { needs: 1, unread: 0 })).toBe('Agents, 1 needs you');
  });

  it('says how many replies are new', () => {
    expect(linkName(home, false, { needs: 0, unread: 1 })).toBe('Home, 1 new reply');
    expect(linkName(home, false, { needs: 0, unread: 3 })).toBe('Home, 3 new replies');
  });

  it('is the label alone, left to the text, with nothing to say', () => {
    expect(linkName(agents, false, none)).toBeUndefined();
    expect(linkName(home, false, none)).toBeUndefined();
    // Another item's count is not this item's.
    expect(linkName(agents, false, { needs: 0, unread: 4 })).toBeUndefined();
    expect(linkName(home, false, { needs: 4, unread: 0 })).toBeUndefined();
  });

  it('keeps the full page name for a shortened label, and lets the live badge name itself', () => {
    expect(linkName(chats, false, none)).toBe('Chats, conversations');
    expect(linkName(chats, true, none)).toBeUndefined();
  });

  it('has no words for a badge that is not a count', () => {
    expect(badgeWords(chats, { needs: 3, unread: 3 })).toBe('');
  });
});
