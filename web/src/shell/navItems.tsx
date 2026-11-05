// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { Route } from '../routes.ts';

export interface NavItem {
  route: Route;
  /** The short label shown under the icon. */
  label: string;
  /** The full page name, for screen readers, when the label is shortened. */
  name?: string;
  /** The tooltip, when it should say more than the label. */
  title?: string;
  /** Shown when work needs attention. Hidden until the agents exist. */
  badge?: 'needs' | 'live' | 'unread';
  icon: ReactNode;
}

const workNav: NavItem[] = [
  {
    route: 'home',
    label: 'Home',
    title: 'Home: chat with Mabari',
    badge: 'unread',
    icon: (
      <>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9v12h14V9" />
        <path d="M10 21v-6h4v6" />
      </>
    ),
  },
  {
    route: 'office',
    label: 'Agents',
    title: 'Agents: the live office floor',
    badge: 'needs',
    icon: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <circle cx="17" cy="9" r="2.6" />
        <path d="M15.5 14.2A5 5 0 0 1 21.5 19" />
      </>
    ),
  },
  {
    route: 'projects',
    label: 'Projects',
    icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  },
  {
    route: 'builder',
    label: 'Builder',
    name: 'Agent builder',
    title: 'Agent builder: build and manage reusable agents',
    icon: (
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    ),
  },
  {
    route: 'conversations',
    label: 'Chats',
    name: 'Conversations',
    title: 'Conversations between agents',
    badge: 'live',
    icon: (
      <>
        <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
        <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
      </>
    ),
  },
];

const manageNav: NavItem[] = [
  {
    route: 'accounts',
    label: 'Accounts',
    icon: (
      <>
        <circle cx="9" cy="8" r="4" />
        <path d="M2 21a7 7 0 0 1 14 0" />
        <path d="M19 8v6M16 11h6" />
      </>
    ),
  },
  {
    route: 'activity',
    label: 'Activity',
    name: 'Activity log',
    title: 'Activity log',
    icon: <path d="M4 6h16M4 12h16M4 18h10" />,
  },
  {
    route: 'preferences',
    label: 'Settings',
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.6 4.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
      </>
    ),
  },
];

const referenceNav: NavItem[] = [
  {
    route: 'components',
    label: 'Library',
    title: 'Library: components and status screens',
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
  },
  {
    route: 'welcome',
    label: 'First run',
    icon: <path d="M5 12h14M13 6l6 6-6 6" />,
  },
];

export const navGroups = [
  { name: 'Work', items: workNav },
  { name: 'Manage', items: manageNav },
  { name: 'Design reference', items: referenceNav },
];
