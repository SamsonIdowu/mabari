// SPDX-License-Identifier: Apache-2.0
// The quick switcher: what it can jump to, how a query finds it, and which keys open it. It is made
// of sources. A source is one kind of result, such as agents or screens, and the switcher shows
// every registered source's results under its own heading. To add a kind of result, write a
// SwitcherSource in its own file and call registerSource once, as switcherSources.ts does for the
// ones that ship. Nothing else here changes: the dialog, the search, the keyboard and the count
// that is announced all work from the list of sources. Conversations will be one more.
//
// The switcher adds no route and no state of its own. A result is one of the pages' existing hash
// links, or a plain action. The ones that need a click and some thought, such as approving,
// stopping or pausing, are not results at all.
import type { LiveAgent, Snapshot } from '../gen/models.ts';

/** What a source may draw on. Everything that touches a store or the page comes in through here, so sources stay plain functions. */
export interface SwitcherContext {
  /** Null until the office has loaded: only what needs no office is offered then. */
  office: Snapshot | null;
  /** Opens an agent's panel, widening the floor if it is out of view, and puts it in the address. */
  openAgent: (agent: LiveAgent) => void;
  controls: SwitcherControls;
}

/** The plain actions: each is what the matching button elsewhere does. */
export interface SwitcherControls {
  quietOn: boolean;
  theme: 'light' | 'dark';
  toggleQuiet: () => void;
  toggleTheme: () => void;
  newAgent: () => void;
  newProject: () => void;
}

export type ChipTone = '' | 'red' | 'amber' | 'ok' | 'ask';

export interface SwitcherResult {
  /** Unique across every source, such as `agent:cc-1`. */
  id: string;
  label: string;
  /** The muted line under the label. It is searched too. */
  detail?: string;
  /** Searched but never shown, such as what an agent is working on. */
  keywords?: string;
  /** The colour of the mark before the label: an agent's own, or a project's. */
  color?: string;
  /** The mark: a square for an agent, a dot for a project. Others take an arrow when they open a page and a bolt when they act. */
  glyph?: 'square' | 'dot';
  chip?: { text: string; tone: ChipTone };
  /** The hash link this opens, one the pages already use. */
  href?: string;
  /** Run when it is chosen. A result with no `href` is an action and must have this. */
  run?: () => void;
  /** Among equal matches in its group, lower comes first. */
  order: number;
}

export interface SwitcherSource {
  id: string;
  /** The group's heading. */
  heading: string;
  /** Where its group sits when nothing is typed, and breaks ties when something is. Lower is higher up. */
  position: number;
  results: (context: SwitcherContext) => SwitcherResult[];
}

export interface SwitcherGroup {
  id: string;
  heading: string;
  results: SwitcherResult[];
}

const registered: SwitcherSource[] = [];

/**
 * Adds a kind of result to the switcher, or replaces the source with the same id. Returns the
 * function that takes it out again.
 */
export function registerSource(source: SwitcherSource): () => void {
  const at = registered.findIndex((item) => item.id === source.id);
  if (at >= 0) registered.splice(at, 1, source);
  else registered.push(source);
  return () => {
    const now = registered.indexOf(source);
    if (now >= 0) registered.splice(now, 1);
  };
}

/** Every registered source, top group first. */
export function registeredSources(): SwitcherSource[] {
  return [...registered].sort((a, b) => a.position - b.position);
}

/** Text as it is compared: without accents or capitals. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * How well one word of the query matches a result, best first: 0 the label starts with it, 1 a
 * word of the label does, 2 it is somewhere in the label, 3 a word of the muted line or the hidden
 * keywords starts with it, 4 it is somewhere in those. Null when it matches nothing.
 */
function tier(token: string, result: SwitcherResult): number | null {
  const label = fold(result.label);
  if (label.startsWith(token)) return 0;
  if (words(label).some((word) => word.startsWith(token))) return 1;
  if (label.includes(token)) return 2;
  const rest = fold(`${result.detail ?? ''} ${result.keywords ?? ''}`);
  if (words(rest).some((word) => word.startsWith(token))) return 3;
  if (rest.includes(token)) return 4;
  return null;
}

/** A result's score for a query, or null if any word of the query is missing from it. The worst word counts. */
export function scoreOf(query: string, result: SwitcherResult): number | null {
  const tokens = words(fold(query));
  let worst = 0;
  for (const token of tokens) {
    const found = tier(token, result);
    if (found === null) return null;
    worst = Math.max(worst, found);
  }
  return worst;
}

const byLabel = (a: SwitcherResult, b: SwitcherResult) =>
  a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/**
 * What the switcher lists for a query. With nothing typed it is everything, each group in its
 * place and each result in its source's order. With a query, only what matches is left, best first
 * within a group, and the group with the best match goes first. Empty groups are left out.
 */
export function search(
  context: SwitcherContext,
  query: string,
  sources: readonly SwitcherSource[] = registeredSources(),
): SwitcherGroup[] {
  const asked = words(fold(query)).length > 0;
  const found = sources.map((source) => {
    const scored = source
      .results(context)
      .map((result) => ({ result, score: asked ? scoreOf(query, result) : 0 }))
      .filter((item): item is { result: SwitcherResult; score: number } => item.score !== null)
      .sort(
        (a, b) =>
          a.score - b.score || a.result.order - b.result.order || byLabel(a.result, b.result),
      );
    return { source, scored };
  });
  return found
    .filter((item) => item.scored.length > 0)
    .sort(
      (a, b) =>
        (a.scored[0]?.score ?? 0) - (b.scored[0]?.score ?? 0) ||
        a.source.position - b.source.position,
    )
    .map((item) => ({
      id: item.source.id,
      heading: item.source.heading,
      results: item.scored.map((entry) => entry.result),
    }));
}

/** The results in the order the arrow keys walk them: group after group, as drawn. */
export const flatten = (groups: SwitcherGroup[]): SwitcherResult[] =>
  groups.flatMap((group) => group.results);

/** What the dialog says for a screen reader as the list changes: the count, or that nothing matched. */
export function countText(count: number, query: string): string {
  if (count > 0) return `${count} result${count === 1 ? '' : 's'}`;
  return query.trim() ? `No results for "${query.trim()}"` : 'No results';
}

/** Where the arrow keys go: one step up or down, round the ends, or nowhere with no results. */
export function stepIndex(at: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0) return step === 1 ? 0 : count - 1;
  return (at + step + count) % count;
}

/** The key that opens the switcher, Ctrl or Command with K and nothing else held. */
export function isSwitcherKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

/** What the key was pressed in. Worked out from the page's element by the dialog's own code. */
export interface KeyTarget {
  /** The box says it uses Ctrl K itself, or is rich text, where Ctrl K is "insert a link". */
  claimed: boolean;
  /** A single or multi line text field. */
  textField: boolean;
}

/**
 * Whether the box the key was pressed in uses it, so the switcher stays out of its way. A box can
 * claim the key with `data-uses-ctrl-k`, and rich text always has it. A plain text field uses
 * Ctrl K only on a Mac, where it deletes to the end of the line, so there Ctrl K in a text field is
 * left alone and Command K, which no text field uses, still opens the switcher.
 */
export function boxUsesKey(
  target: KeyTarget,
  event: { ctrlKey: boolean; metaKey: boolean },
  mac: boolean,
): boolean {
  if (target.claimed) return true;
  return target.textField && mac && event.ctrlKey && !event.metaKey;
}

/** True on a Mac, where Ctrl K in a text field is the field's own and Command K is the switcher's. */
export const onMac = (): boolean =>
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** The shortcut as it is written on this computer. */
export const shortcutText = (): string => (onMac() ? '⌘K' : 'Ctrl K');
