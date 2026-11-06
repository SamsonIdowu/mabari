// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boxUsesKey,
  countText,
  flatten,
  isSwitcherKey,
  registerSource,
  registeredSources,
  scoreOf,
  search,
  stepIndex,
  type SwitcherContext,
  type SwitcherResult,
  type SwitcherSource,
} from './switcher.ts';

const result = (overrides: Partial<SwitcherResult> & { id: string; label: string }) =>
  ({ order: 0, ...overrides }) as SwitcherResult;

const context = {
  office: null,
  openAgent: () => {},
  controls: {},
} as unknown as SwitcherContext;

const source = (
  id: string,
  position: number,
  results: SwitcherResult[],
  heading = id,
): SwitcherSource => ({ id, heading, position, results: () => results });

describe('scoreOf', () => {
  const atlas = result({
    id: 'a',
    label: 'Atlas scribe',
    detail: 'Checkout revamp',
    keywords: 'Needs approval Draft the migration',
  });

  it('ranks the start of the label first, then a word of it, then inside it', () => {
    expect(scoreOf('atl', atlas)).toBe(0);
    expect(scoreOf('scr', atlas)).toBe(1);
    expect(scoreOf('cribe', atlas)).toBe(2);
  });

  it('finds what is in the muted line or the hidden words, after the label', () => {
    expect(scoreOf('checkout', atlas)).toBe(3);
    expect(scoreOf('approv', atlas)).toBe(3);
    expect(scoreOf('igration', atlas)).toBe(4);
  });

  it('wants every word of the query, and scores by the worst', () => {
    expect(scoreOf('atlas checkout', atlas)).toBe(3);
    expect(scoreOf('atlas nonsense', atlas)).toBeNull();
    expect(scoreOf('', atlas)).toBe(0);
  });

  it('ignores capitals and accents', () => {
    expect(scoreOf('CAFE', result({ id: 'c', label: 'Café ordering' }))).toBe(0);
    expect(scoreOf('café', result({ id: 'c', label: 'Cafe ordering' }))).toBe(0);
  });
});

describe('search', () => {
  const agents = source(
    'agents',
    10,
    [
      result({ id: 'agent:b', label: 'Bolt', order: 2 }),
      result({ id: 'agent:a', label: 'Atlas', order: 0 }),
      result({ id: 'agent:m', label: 'Mori', order: 0 }),
    ],
    'Agents',
  );
  const screens = source(
    'screens',
    20,
    [
      result({ id: 'screen:s', label: 'Settings' }),
      result({ id: 'screen:a', label: 'Agents', keywords: 'office' }),
    ],
    'Screens',
  );

  it('lists everything with nothing typed, each group in its place and in its own order', () => {
    const groups = search(context, '', [screens, agents]);
    expect(groups.map((group) => group.heading)).toEqual(['Agents', 'Screens']);
    // Equal order falls back to the label.
    expect(groups[0]?.results.map((item) => item.label)).toEqual(['Atlas', 'Mori', 'Bolt']);
    expect(flatten(groups)).toHaveLength(5);
  });

  it('keeps only what matches, best first, and puts the group with the best match first', () => {
    const groups = search(context, 'set', [agents, screens]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBe('Screens');
    const both = search(context, 'a', [agents, screens]);
    // Atlas and Agents both start with it; the agents group is higher up when they tie.
    expect(both.map((group) => group.heading)).toEqual(['Agents', 'Screens']);
    expect(both[1]?.results.map((item) => item.label)).toEqual(['Agents']);
  });

  it('leaves out groups with no match, and says so with no groups at all', () => {
    expect(search(context, 'zzzz', [agents, screens])).toEqual([]);
  });

  it('breaks a tie by position, and puts a better match ahead of a group that is higher up', () => {
    const late = source('late', 99, [result({ id: 'l:1', label: 'Moriarty' })], 'Late');
    const groups = search(context, 'mor', [agents, late]);
    expect(groups.map((group) => group.id)).toEqual(['agents', 'late']);
    const inside = source('inside', 1, [result({ id: 'i:1', label: 'The Mori' })], 'Inside');
    expect(search(context, 'mor', [inside, agents]).map((group) => group.id)).toEqual([
      'agents',
      'inside',
    ]);
  });
});

describe('sources', () => {
  const added: (() => void)[] = [];
  afterEach(() => {
    while (added.length) added.pop()?.();
  });

  it('takes a new kind of result in one call, and the dialog needs nothing else', () => {
    const before = registeredSources().length;
    added.push(
      registerSource(
        source('conversations', 25, [result({ id: 'chat:1', label: 'Atlas and Quill' })]),
      ),
    );
    expect(registeredSources()).toHaveLength(before + 1);
    expect(
      search(context, 'quill')
        .flatMap((group) => group.results)
        .map((item) => item.id),
    ).toEqual(['chat:1']);
  });

  it('puts sources in their position, and replaces one that has the same id', () => {
    added.push(registerSource(source('zz-late', 999, [])));
    added.push(registerSource(source('zz-early', -5, [])));
    const ids = registeredSources().map((item) => item.id);
    expect(ids[0]).toBe('zz-early');
    expect(ids.at(-1)).toBe('zz-late');
    const first = vi.fn(() => []);
    const second = vi.fn(() => []);
    added.push(registerSource({ id: 'zz-same', heading: 'x', position: 1, results: first }));
    added.push(registerSource({ id: 'zz-same', heading: 'x', position: 1, results: second }));
    search(context, '');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('stops listing a source once it is taken out', () => {
    const remove = registerSource(source('zz-gone', 5, [result({ id: 'g', label: 'Gone soon' })]));
    expect(flatten(search(context, 'gone soon')).map((item) => item.id)).toEqual(['g']);
    remove();
    expect(flatten(search(context, 'gone soon'))).toEqual([]);
  });
});

describe('what is announced and how the arrows move', () => {
  it('counts the results, and says when there are none', () => {
    expect(countText(1, '')).toBe('1 result');
    expect(countText(7, 'a')).toBe('7 results');
    expect(countText(0, ' nope ')).toBe('No results for "nope"');
    expect(countText(0, '')).toBe('No results');
  });

  it('moves one step and goes round the ends', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe('the key', () => {
  const press = (key: string, held: Partial<Record<string, boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...held,
  });

  it('is Ctrl K or Command K, and nothing else held', () => {
    expect(isSwitcherKey(press('k', { ctrlKey: true }))).toBe(true);
    expect(isSwitcherKey(press('K', { metaKey: true }))).toBe(true);
    expect(isSwitcherKey(press('k'))).toBe(false);
    expect(isSwitcherKey(press('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSwitcherKey(press('k', { metaKey: true, altKey: true }))).toBe(false);
    expect(isSwitcherKey(press('j', { ctrlKey: true }))).toBe(false);
  });

  const text = { claimed: false, textField: true };
  const ctrl = { ctrlKey: true, metaKey: false };
  const meta = { ctrlKey: false, metaKey: true };

  it('opens from anywhere, including a text field, where nothing claims the key', () => {
    expect(boxUsesKey({ claimed: false, textField: false }, ctrl, true)).toBe(false);
    expect(boxUsesKey(text, ctrl, false)).toBe(false);
    expect(boxUsesKey(text, meta, true)).toBe(false);
  });

  it('stays out of a box that claims Ctrl K, or rich text', () => {
    expect(boxUsesKey({ claimed: true, textField: false }, ctrl, false)).toBe(true);
    expect(boxUsesKey({ claimed: true, textField: true }, meta, true)).toBe(true);
  });

  it('leaves a Mac text field its own Ctrl K, which deletes to the end of the line', () => {
    expect(boxUsesKey(text, ctrl, true)).toBe(true);
    expect(boxUsesKey({ claimed: false, textField: false }, ctrl, true)).toBe(false);
  });
});
