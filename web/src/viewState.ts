// SPDX-License-Identifier: Apache-2.0
// What the page keeps across a reload, and what its address says. The office filters and the two
// tabs are remembered in this browser. The agent whose panel is open, and the project whose chat
// is open, are in the address (`#office?agent=…`, `#projects?chat=…`), so Back closes them and a
// link opens them. A bare `#office` still works, as it always did.
import { useOfficeStore } from './data/officeStore.ts';
import type { Snapshot } from './gen/models.ts';
import { restKey } from './office/layout.ts';
import { useOfficeUi, type ProjectsTab, type StatusFilter } from './office/uiStore.ts';
import { hashParam, hashWith, routeOf } from './routes.ts';

/** The choices on the Agents and Projects pages and Conversations that are remembered. */
export interface SavedView {
  project: string;
  provider: string;
  model: string;
  status: StatusFilter;
  threadProject: string;
  projectsTab: ProjectsTab;
}

export const DEFAULT_VIEW: SavedView = {
  project: 'all',
  provider: 'all',
  model: 'all',
  status: 'all',
  threadProject: 'all',
  projectsTab: 'all',
};

const STORAGE_KEY = 'mabari.view';
const STATUSES: readonly string[] = ['all', 'needs', 'active'] satisfies StatusFilter[];
const TABS: readonly string[] = ['all', 'open', 'done'] satisfies ProjectsTab[];

/** Reads what was saved, keeping only values of the right shape. */
export function parseView(raw: string | null): Partial<SavedView> {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const view: Partial<SavedView> = {};
  for (const key of ['project', 'provider', 'model', 'threadProject'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value) view[key] = value;
  }
  if (typeof record.status === 'string' && STATUSES.includes(record.status)) {
    view.status = record.status as StatusFilter;
  }
  if (typeof record.projectsTab === 'string' && TABS.includes(record.projectsTab)) {
    view.projectsTab = record.projectsTab as ProjectsTab;
  }
  return view;
}

/** The part of the page's state that is remembered. */
export function viewOf(state: SavedView): SavedView {
  const { project, provider, model, status, threadProject, projectsTab } = state;
  return { project, provider, model, status, threadProject, projectsTab };
}

/**
 * Drops choices that no longer match anything in the office, such as a project deleted since or a
 * provider whose agents have all left, so a reload never lands on a floor with nobody on it and no
 * sign of why. Project, provider and model are judged the same way: a saved value stays only while
 * something in the office has it.
 */
export function cleanView(
  view: SavedView,
  office: Pick<Snapshot, 'projects' | 'agents'>,
): SavedView {
  const projects = new Set(office.projects.map((project) => project.id));
  const models = new Set(office.agents.map((agent) => agent.model));
  const providersHere = new Set<string>(office.agents.map((agent) => agent.provider));
  return {
    ...view,
    project: view.project === 'all' || projects.has(view.project) ? view.project : 'all',
    provider: view.provider === 'all' || providersHere.has(view.provider) ? view.provider : 'all',
    model: view.model === 'all' || models.has(view.model) ? view.model : 'all',
    threadProject:
      view.threadProject === 'all' || projects.has(view.threadProject) ? view.threadProject : 'all',
  };
}

/** What in the store is shown in the address: the page it belongs on, the query name, the field. */
export interface Binding {
  route: string;
  param: string;
  key: 'selected' | 'projectChat';
}

export const BINDINGS: readonly Binding[] = [
  { route: 'office', param: 'agent', key: 'selected' },
  { route: 'projects', param: 'chat', key: 'projectChat' },
];

export type FromHash =
  | { action: 'none' }
  | { action: 'open'; value: string }
  | { action: 'close' }
  /** Keep what the store has, and put it in the address. */
  | { action: 'mirror'; hash: string };

/**
 * What a new address means for the store. `have` is what the store holds now and `previous` is the
 * address before this one, if it is known.
 *
 * An address that names the value opens it. A bare address closes it only when it follows one that
 * named it, which is Back, or the page's own link: arriving from another page keeps what was open
 * and shows it in the address.
 */
export function fromHash(
  binding: Binding,
  hash: string,
  have: string | null,
  previous: string | null,
): FromHash {
  if (routeOf(hash) !== binding.route) return { action: 'none' };
  const wanted = hashParam(hash, binding.param);
  if (wanted) return wanted === have ? { action: 'none' } : { action: 'open', value: wanted };
  if (!have) return { action: 'none' };
  const before =
    previous !== null && routeOf(previous) === binding.route
      ? hashParam(previous, binding.param)
      : null;
  return before
    ? { action: 'close' }
    : { action: 'mirror', hash: hashWith(binding.route, binding.param, have) };
}

export type HashMove = 'none' | 'push' | 'replace' | 'back';

/**
 * How the address follows the store. Opening something adds a step to history, so Back closes it.
 * Switching to another value replaces that step. Closing goes back when that step was ours, and
 * rewrites the address otherwise, as when the page was opened from a link.
 */
export function hashMove(
  binding: Binding,
  hash: string,
  before: string | null,
  now: string | null,
  ours: boolean,
): HashMove {
  if (routeOf(hash) !== binding.route) return 'none';
  const shown = hashParam(hash, binding.param);
  if ((shown ?? null) === now) return 'none';
  if (now === null) return ours && shown ? 'back' : 'replace';
  return before === null ? 'push' : 'replace';
}

/** True when the office has the agent, or the agent file resting in the lounge, with this id. */
export function knowsAgent(office: Pick<Snapshot, 'agents' | 'defs'>, id: string): boolean {
  return (
    office.agents.some((agent) => agent.id === id) ||
    (office.defs ?? []).some((def) => restKey(def) === id)
  );
}

/** Marks the history steps this module added, which Back can safely undo. */
const OURS = 'mabariOverlay';

const fragment = (url: string) => (url.includes('#') ? url.slice(url.indexOf('#')) : '');

function ours(): boolean {
  const state: unknown = window.history.state;
  return !!state && typeof state === 'object' && OURS in state;
}

function open(binding: Binding, value: string) {
  const ui = useOfficeUi.getState();
  if (binding.key === 'selected') ui.set({ selected: value, target: 'selected', follow: false });
  else ui.set({ projectChat: value });
}

function close(binding: Binding) {
  const ui = useOfficeUi.getState();
  if (binding.key === 'selected') ui.set({ selected: null, follow: false });
  else ui.set({ projectChat: null });
}

/** The address changed: open or close what it says, or show what is already open. */
function applyHash(previous: string | null) {
  const hash = window.location.hash;
  const office = useOfficeStore.getState().office;
  for (const binding of BINDINGS) {
    const move = fromHash(binding, hash, useOfficeUi.getState()[binding.key], previous);
    if (move.action === 'open') {
      // A link to an agent that isn't here shows nothing, so the address drops it.
      const missing = binding.key === 'selected' && office && !knowsAgent(office, move.value);
      const gone =
        binding.key === 'projectChat' &&
        office &&
        !office.projects.some((project) => project.id === move.value);
      if (missing || gone) {
        window.history.replaceState(window.history.state, '', hashWith(binding.route, '', null));
      } else {
        open(binding, move.value);
      }
    } else if (move.action === 'close') {
      close(binding);
    } else if (move.action === 'mirror') {
      window.history.replaceState(window.history.state, '', move.hash);
    }
  }
}

function followStore(
  state: { selected: string | null; projectChat: string | null },
  previous: typeof state,
) {
  for (const binding of BINDINGS) {
    const before = previous[binding.key];
    const now = state[binding.key];
    if (before === now) continue;
    const move = hashMove(binding, window.location.hash, before, now, ours());
    const hash = hashWith(binding.route, binding.param, now);
    if (move === 'push') window.history.pushState({ [OURS]: true }, '', hash);
    else if (move === 'replace') window.history.replaceState(window.history.state, '', hash);
    else if (move === 'back') window.history.back();
  }
}

function save(state: SavedView, previous: SavedView) {
  const now = JSON.stringify(viewOf(state));
  if (now === JSON.stringify(viewOf(previous))) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, now);
  } catch {
    // Remembering the view is a convenience; without storage it lasts until a reload.
  }
}

let started = false;

/** Restores the saved view and the address, then keeps both in step. Called once, at start. */
export function startViewState(): void {
  if (started) return;
  started = true;
  try {
    useOfficeUi.setState(parseView(window.localStorage.getItem(STORAGE_KEY)));
  } catch {
    // No storage, so nothing was remembered.
  }
  applyHash(null);
  window.addEventListener('hashchange', (event) => applyHash(fragment(event.oldURL)));
  useOfficeUi.subscribe((state, previous) => {
    followStore(state, previous);
    save(state, previous);
  });
  // Once the office is known, anything it doesn't have is dropped from what was restored.
  const settle = (office: Snapshot) => {
    const ui = useOfficeUi.getState();
    const cleaned = cleanView(viewOf(ui), office);
    if (JSON.stringify(cleaned) !== JSON.stringify(viewOf(ui))) useOfficeUi.setState(cleaned);
    if (ui.selected && !knowsAgent(office, ui.selected)) useOfficeUi.setState({ selected: null });
    if (ui.projectChat && !office.projects.some((project) => project.id === ui.projectChat)) {
      useOfficeUi.setState({ projectChat: null });
    }
  };
  const first = useOfficeStore.getState().office;
  if (first) {
    settle(first);
    return;
  }
  const stop = useOfficeStore.subscribe((state) => {
    if (!state.office) return;
    stop();
    settle(state.office);
  });
}
