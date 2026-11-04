import type { ReactNode } from 'react';
import type { Route } from '../routes.ts';

export interface NavItem {
  route: Route;
  label: string;
  icon: ReactNode;
}

export const mainNav: NavItem[] = [
  {
    route: 'office',
    label: 'Office',
    icon: (
      <>
        <path d="M3 21V9l9-6 9 6v12" />
        <path d="M9 21v-7h6v7" />
      </>
    ),
  },
  {
    route: 'projects',
    label: 'Projects',
    icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  },
  {
    route: 'conversations',
    label: 'Conversations',
    icon: (
      <>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        <path d="M8 11h8M8 14h5" />
      </>
    ),
  },
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
    label: 'Activity log',
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

export const secondaryNav: NavItem[] = [
  {
    route: 'components',
    label: 'Component sheet',
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
    route: 'states',
    label: 'Empty and error states',
    icon: (
      <>
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </>
    ),
  },
  {
    route: 'welcome',
    label: 'First run',
    icon: <path d="M5 12h14M13 6l6 6-6 6" />,
  },
];
