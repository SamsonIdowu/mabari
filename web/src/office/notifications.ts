// SPDX-License-Identifier: Apache-2.0
// Desktop notifications, for when Mabari isn't in front: an approval or an error needs you, or a
// watch you set ("tell me when it's done") has fired. Off until you turn it on in Settings, and the
// browser is asked for permission then and not before. A notification only ever names who: no
// command, path, task or error text, and it has no buttons, so nothing can be approved from one.
import { create } from 'zustand';
import { onWatchFired, useOfficeStore } from '../data/officeStore.ts';
import type { LiveAgent, WatchFired } from '../gen/models.ts';
import { openAgent } from './uiStore.ts';

const STORAGE_KEY = 'mabari.notify';

/** A new agent that is already waiting, as a hub agent can be, still counts for this long. */
const JUST_ARRIVED_MS = 30_000;

/** Why notifications can't work in this page, or empty when they can. */
export function unsupportedReason(): string {
  if (typeof Notification === 'undefined') {
    return "This browser can't show desktop notifications.";
  }
  // A page opened over a network address, not localhost or https, is not a secure context, and
  // browsers keep notifications from those.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return "Desktop notifications need a secure address, and this one isn't. Open Mabari on this computer at localhost to turn them on.";
  }
  return '';
}

const BLOCKED =
  'Your browser has blocked notifications for Mabari. Allow them in the site settings, then turn this on again.';
const NOT_GIVEN = "Your browser didn't give permission, so this stays off.";

function readSaved(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(STORAGE_KEY, '1');
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // The choice lasts until the page reloads.
  }
}

interface Notify {
  /** The switch, kept in this browser: permission is the browser's, so it is not a shared setting. */
  enabled: boolean;
  /** Why it is off when it couldn't be turned on, in a sentence, or empty. */
  problem: string;
  turnOn: () => Promise<void>;
  turnOff: () => void;
}

/** On only if it was left on and the browser still allows it, so a revoked permission shows as off. */
function startedOn(): boolean {
  return readSaved() && unsupportedReason() === '' && Notification.permission === 'granted';
}

export const useNotify = create<Notify>((set) => ({
  enabled: startedOn(),
  problem: '',
  turnOn: async () => {
    const unsupported = unsupportedReason();
    if (unsupported) {
      set({ enabled: false, problem: unsupported });
      return;
    }
    let permission: NotificationPermission = Notification.permission;
    // Only now, from the click on the switch, does the browser get asked.
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    if (permission === 'granted') {
      save(true);
      set({ enabled: true, problem: '' });
      return;
    }
    save(false);
    set({ enabled: false, problem: permission === 'denied' ? BLOCKED : NOT_GIVEN });
  },
  turnOff: () => {
    save(false);
    set({ enabled: false, problem: '' });
  },
}));

/** Says what the notification is for. */
export type AlertKind = 'approval' | 'error';

export interface Alert {
  kind: AlertKind;
  agent: LiveAgent;
  /** The same for the same event, so two tabs make one notification, not two. */
  tag: string;
  /** What it says: "Atlas needs your approval", "Mori hit an error". Nothing else. */
  title: string;
}

/**
 * The approvals and errors that are new between two states of the office: an agent now waiting on
 * an approval it wasn't waiting on, or now stopped by an error it wasn't. An agent already waiting,
 * and one the office had only just got to know, stay quiet, except that a new agent that arrives
 * already waiting counts if it arrived a moment ago. Questions never do: only approvals and errors
 * are red.
 */
export function newAlerts(before: LiveAgent[], after: LiveAgent[], now: number): Alert[] {
  const alerts: Alert[] = [];
  for (const agent of after) {
    const earlier = before.find((item) => item.id === agent.id);
    const arrived = earlier === undefined && now - agent.createdAt < JUST_ARRIVED_MS;
    if (earlier === undefined && !arrived) continue;
    if (agent.state === 'approval' && agent.approval) {
      if (earlier?.approval?.id !== agent.approval.id) {
        alerts.push({
          kind: 'approval',
          agent,
          tag: `mabari-approval-${agent.approval.id}`,
          title: `${agent.name} needs your approval`,
        });
      }
    } else if (agent.state === 'error' && earlier?.state !== 'error') {
      alerts.push({
        kind: 'error',
        agent,
        tag: `mabari-error-${agent.id}`,
        title: `${agent.name} hit an error`,
      });
    }
  }
  return alerts;
}

/** True when a notification may be shown now: it is on, allowed, and the page is hidden. */
function mayShow(): boolean {
  return (
    useNotify.getState().enabled &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    document.visibilityState === 'hidden'
  );
}

/** Brings Mabari to the front and opens what the notification was about. */
function open(agentId: string | null, fallback: string): void {
  window.focus();
  const office = useOfficeStore.getState().office;
  const agent = agentId ? office?.agents.find((item) => item.id === agentId) : undefined;
  if (office && agent) openAgent(agent, office.agents);
  else window.location.hash = fallback;
}

function show(title: string, tag: string, agentId: string | null, fallback: string): void {
  if (!mayShow()) return;
  // No body and no action buttons: a notification can tell you, never decide for you.
  const note = new Notification(title, { tag });
  note.onclick = () => {
    note.close();
    open(agentId, fallback);
  };
}

/** Shows what a watch you set has to say, if the page is hidden. */
export function notifyWatchFired(fired: WatchFired): void {
  show(
    fired.notice,
    `mabari-watch-${fired.watch}`,
    fired.agentId || null,
    fired.projectId ? '#projects' : '#office',
  );
}

/** Starts watching the office for new approvals and errors, and returns how to stop. */
export function listenForNotifications(): () => void {
  const stopOffice = useOfficeStore.subscribe((state, previous) => {
    // The first snapshot is what is already there, not news.
    if (!state.office || !previous.office || state.office === previous.office) return;
    for (const alert of newAlerts(previous.office.agents, state.office.agents, Date.now())) {
      show(alert.title, alert.tag, alert.agent.id, '#office');
    }
  });
  const stopWatches = onWatchFired(notifyWatchFired);
  return () => {
    stopOffice();
    stopWatches();
  };
}
