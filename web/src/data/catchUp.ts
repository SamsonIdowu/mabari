// SPDX-License-Identifier: Apache-2.0
import type { Recap, RecapGroup, Timeline } from '../gen/models.ts';
import { SIGN_IN_EVENT, request, unreachableMessage } from './api.ts';
import { keepSession, sessionHeaders } from './session.ts';

/** The Activity page's filters, as the export is asked for them. "all" means no filter. */
export interface ActivityFilters {
  search: string;
  type: string;
  agent: string;
}

export type ExportFormat = 'csv' | 'json';

/** The address of an export of the log, narrowed by what the page is showing. */
export function exportPath(format: ExportFormat, filters: ActivityFilters): string {
  const query = new URLSearchParams({ format });
  if (filters.search) query.set('q', filters.search);
  if (filters.type !== 'all') query.set('type', filters.type);
  if (filters.agent !== 'all') query.set('agent', filters.agent);
  return `/api/activity/export?${query.toString()}`;
}

/** A date as the timeline asks for it, in this computer's own time zone: 2026-11-06. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The file name the server gave a download, or the name it would have given. */
export function downloadName(disposition: string | null, format: ExportFormat, now: Date): string {
  const given = /filename="([^"\\/]+)"/.exec(disposition ?? '')?.[1];
  return given ?? `mabari-activity-${localDay(now)}.${format}`;
}

/** The groups of a recap in the order it tells them, each with its heading. */
export function recapGroups(recap: Recap): { key: string; title: string; group: RecapGroup }[] {
  return [
    { key: 'finished', title: 'Tasks finished', group: recap.finished },
    { key: 'autoApproved', title: 'Approved by auto approve', group: recap.autoApproved },
    { key: 'errors', title: 'Errors', group: recap.errors },
    { key: 'needs', title: 'Needs you now', group: recap.needs },
  ];
}

export const catchUp = {
  /** What happened from `since` to `until`, in milliseconds, or up to now when `until` is left out. */
  recap: (since: number, until?: number) =>
    request<Recap>(`/api/recap?since=${since}${until ? `&until=${until}` : ''}`),
  /** One day of the office. With no day, today. */
  timeline: (day?: string) => request<Timeline>(`/api/timeline${day ? `?day=${day}` : ''}`),
};

/**
 * Downloads the log as a file, narrowed by the filters. The request carries the session like any
 * other, so it works when signing in is needed, which a plain link could not. Returns the file name.
 */
export async function downloadActivity(
  format: ExportFormat,
  filters: ActivityFilters,
): Promise<string> {
  const path = exportPath(format, filters);
  let response: Response;
  try {
    response = await fetch(path, { headers: sessionHeaders() });
  } catch (error) {
    throw new Error(unreachableMessage(path), { cause: error });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      login?: boolean;
    } | null;
    if (response.status === 401 && body?.login) {
      keepSession('');
      window.dispatchEvent(new Event(SIGN_IN_EVENT));
    }
    throw new Error(body?.error ?? `The export failed: ${response.status}`);
  }
  const name = downloadName(response.headers.get('Content-Disposition'), format, new Date());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
