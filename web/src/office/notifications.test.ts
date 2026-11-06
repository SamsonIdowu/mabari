// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, Snapshot, WatchFired } from '../gen/models.ts';
import {
  listenForNotifications,
  newAlerts,
  notifyWatchFired,
  unsupportedReason,
  useNotify,
} from './notifications.ts';

const NOW = 1_800_000_000_000;
const OLD = NOW - 60 * 60_000;

const agent = (id: string, fields: Partial<LiveAgent> = {}) =>
  ({ id, name: id.toUpperCase(), state: 'editing', createdAt: OLD, ...fields }) as LiveAgent;

const waiting = (id: string, approvalId: string, fields: Partial<LiveAgent> = {}) =>
  agent(id, {
    state: 'approval',
    approval: { id: approvalId } as LiveAgent['approval'],
    ...fields,
  });

describe('newAlerts', () => {
  it('sees an approval that has just started waiting, in words that name only the agent', () => {
    const alerts = newAlerts([agent('atlas')], [waiting('atlas', 'p1', { name: 'Atlas' })], NOW);
    expect(alerts).toEqual([
      {
        kind: 'approval',
        agent: expect.objectContaining({ id: 'atlas' }),
        tag: 'mabari-approval-p1',
        title: 'Atlas needs your approval',
      },
    ]);
  });

  it('sees a second approval from the same agent, and not the same one again', () => {
    expect(newAlerts([waiting('a', 'p1')], [waiting('a', 'p2')], NOW)).toHaveLength(1);
    expect(newAlerts([waiting('a', 'p1')], [waiting('a', 'p1')], NOW)).toHaveLength(0);
  });

  it('sees an agent stop with an error, once', () => {
    const [alert] = newAlerts(
      [agent('mori')],
      [agent('mori', { name: 'Mori', state: 'error' })],
      NOW,
    );
    expect(alert).toMatchObject({
      kind: 'error',
      tag: 'mabari-error-mori',
      title: 'Mori hit an error',
    });
    expect(
      newAlerts([agent('mori', { state: 'error' })], [agent('mori', { state: 'error' })], NOW),
    ).toHaveLength(0);
  });

  it('says nothing for a question, which waits quietly', () => {
    const asking = agent('sage', { question: { id: 'q1' } as LiveAgent['question'] });
    expect(newAlerts([agent('sage')], [asking], NOW)).toHaveLength(0);
  });

  it('says nothing for finished work or an agent the office has only just got to know', () => {
    expect(newAlerts([agent('a')], [agent('a', { state: 'done' })], NOW)).toHaveLength(0);
    expect(newAlerts([], [waiting('a', 'p1')], NOW)).toHaveLength(0);
  });

  it('counts an agent that arrived a moment ago already waiting, as a hub agent can', () => {
    const fresh = { createdAt: NOW - 2000 };
    expect(newAlerts([], [waiting('a', 'p1', fresh)], NOW)).toHaveLength(1);
    expect(newAlerts([], [agent('b', { state: 'error', ...fresh })], NOW)).toHaveLength(1);
  });
});

/** A stand-in for the browser's Notification, which remembers what was shown. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static asked = 0;
  static shown: FakeNotification[] = [];
  static answer: NotificationPermission = 'granted';
  static requestPermission() {
    FakeNotification.asked += 1;
    FakeNotification.permission = FakeNotification.answer;
    return Promise.resolve(FakeNotification.answer);
  }
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let hidden = true;
let hash = '#office';
let focused = 0;

function office(agents: LiveAgent[]): Snapshot {
  return { agents, projects: [], settings: {}, watches: [] } as unknown as Snapshot;
}

beforeEach(() => {
  FakeNotification.permission = 'granted';
  FakeNotification.answer = 'granted';
  FakeNotification.asked = 0;
  FakeNotification.shown = [];
  hidden = true;
  hash = '#office';
  focused = 0;
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('document', {
    get visibilityState() {
      return hidden ? 'hidden' : 'visible';
    },
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('window', {
    isSecureContext: true,
    focus: () => (focused += 1),
    location: {
      get hash() {
        return hash;
      },
      set hash(value: string) {
        hash = value;
      },
    },
    history: { pushState: () => {}, replaceState: () => {} },
  });
  useNotify.setState({ enabled: true, problem: '' });
  useOfficeStore.setState({ office: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useNotify.setState({ enabled: false, problem: '' });
});

describe('turning notifications on', () => {
  it('asks the browser only now, and stays on once it says yes', async () => {
    FakeNotification.permission = 'default';
    useNotify.setState({ enabled: false });
    expect(FakeNotification.asked).toBe(0);
    await useNotify.getState().turnOn();
    expect(FakeNotification.asked).toBe(1);
    expect(useNotify.getState()).toMatchObject({ enabled: true, problem: '' });
  });

  it('stays off and says why when the browser refuses', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.answer = 'denied';
    await useNotify.getState().turnOn();
    expect(useNotify.getState().enabled).toBe(false);
    expect(useNotify.getState().problem).toMatch(/blocked notifications for Mabari/);
  });

  it('does not ask again once the browser has said no, and says why', async () => {
    FakeNotification.permission = 'denied';
    await useNotify.getState().turnOn();
    expect(FakeNotification.asked).toBe(0);
    expect(useNotify.getState()).toMatchObject({ enabled: false });
    expect(useNotify.getState().problem).toMatch(/site settings/);
  });

  it('stays off when the prompt was dismissed', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.answer = 'default';
    await useNotify.getState().turnOn();
    expect(useNotify.getState().enabled).toBe(false);
    expect(useNotify.getState().problem).toMatch(/didn't give permission/);
  });

  it("stays off, without asking, on an address that isn't a secure context", async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    FakeNotification.permission = 'default';
    expect(unsupportedReason()).toMatch(/secure address/);
    await useNotify.getState().turnOn();
    expect(FakeNotification.asked).toBe(0);
    expect(useNotify.getState().enabled).toBe(false);
    expect(useNotify.getState().problem).toMatch(/localhost/);
  });

  it('stays off in a browser with no notifications at all', async () => {
    vi.stubGlobal('Notification', undefined);
    await useNotify.getState().turnOn();
    expect(useNotify.getState()).toMatchObject({
      enabled: false,
      problem: "This browser can't show desktop notifications.",
    });
  });
});

describe('showing a notification', () => {
  let stop: () => void;
  const set = (agents: LiveAgent[]) => useOfficeStore.setState({ office: office(agents) });

  beforeEach(() => {
    stop = listenForNotifications();
  });
  afterEach(() => stop());

  it('shows one for a new approval while the page is hidden: a title, a tag, nothing else', () => {
    set([agent('atlas', { name: 'Atlas' })]);
    set([waiting('atlas', 'p1', { name: 'Atlas' })]);
    expect(FakeNotification.shown).toHaveLength(1);
    const [note] = FakeNotification.shown;
    expect(note?.title).toBe('Atlas needs your approval');
    // Only a tag: no body that could hold a command, and no action buttons to approve with.
    expect(note?.options).toEqual({ tag: 'mabari-approval-p1' });
  });

  it('shows one for an error, and says only that it happened', () => {
    set([agent('mori', { name: 'Mori', error: 'secret=hunter2' })]);
    set([agent('mori', { name: 'Mori', state: 'error', error: 'secret=hunter2' })]);
    expect(FakeNotification.shown.map((note) => note.title)).toEqual(['Mori hit an error']);
    expect(JSON.stringify(FakeNotification.shown[0])).not.toContain('hunter2');
  });

  it('shows nothing while the page is visible', () => {
    hidden = false;
    set([agent('atlas')]);
    set([waiting('atlas', 'p1')]);
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('shows nothing when it is off, or the browser no longer allows it', () => {
    useNotify.setState({ enabled: false });
    set([agent('atlas')]);
    set([waiting('atlas', 'p1')]);
    expect(FakeNotification.shown).toHaveLength(0);
    useNotify.setState({ enabled: true });
    FakeNotification.permission = 'denied';
    set([agent('atlas')]);
    set([waiting('atlas', 'p2')]);
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('shows one per approval, however often the office changes', () => {
    set([agent('atlas')]);
    set([waiting('atlas', 'p1')]);
    set([waiting('atlas', 'p1', { elapsed: 5 })]);
    set([waiting('atlas', 'p1', { elapsed: 9 })]);
    expect(FakeNotification.shown).toHaveLength(1);
    set([waiting('atlas', 'p2')]);
    expect(FakeNotification.shown).toHaveLength(2);
  });

  it('shows nothing for the first look at an office, or for a question', () => {
    set([waiting('atlas', 'p1')]);
    expect(FakeNotification.shown).toHaveLength(0);
    set([waiting('atlas', 'p1'), agent('sage')]);
    set([
      waiting('atlas', 'p1'),
      agent('sage', { question: { id: 'q' } as LiveAgent['question'] }),
    ]);
    expect(FakeNotification.shown).toHaveLength(0);
  });

  it('opens the agent when it is clicked, and brings Mabari to the front', () => {
    set([agent('atlas', { name: 'Atlas' })]);
    set([waiting('atlas', 'p1', { name: 'Atlas' })]);
    const [note] = FakeNotification.shown;
    note?.onclick?.();
    expect(note?.closed).toBe(true);
    expect(focused).toBe(1);
    expect(hash).toBe('#office?agent=atlas');
  });

  it('shows a watch that fired, with only the name, and opens its agent', () => {
    set([agent('ledger', { name: 'Ledger' })]);
    const fired = {
      watch: 'w1',
      agentId: 'ledger',
      projectId: '',
      outcome: 'done',
      text: 'Ledger is done: Fix the secret=hunter2 bug.',
      notice: 'Ledger is done',
    } as WatchFired;
    notifyWatchFired(fired);
    expect(FakeNotification.shown.map((note) => [note.title, note.options])).toEqual([
      ['Ledger is done', { tag: 'mabari-watch-w1' }],
    ]);
    FakeNotification.shown[0]?.onclick?.();
    expect(hash).toBe('#office?agent=ledger');
    // A project has no one agent to open, so it opens Projects.
    notifyWatchFired({
      ...fired,
      watch: 'w2',
      agentId: '',
      projectId: 'p1',
      notice: 'Docs is done',
    });
    FakeNotification.shown[1]?.onclick?.();
    expect(hash).toBe('#projects');
  });

  it('shows a watch that fired only while the page is hidden', () => {
    hidden = false;
    notifyWatchFired({
      watch: 'w1',
      agentId: 'a',
      projectId: '',
      outcome: 'done',
      text: '',
      notice: 'A is done',
    });
    expect(FakeNotification.shown).toHaveLength(0);
  });
});
