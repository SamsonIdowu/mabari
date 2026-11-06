// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recap } from '../gen/models.ts';
import { SIGN_IN_EVENT } from './api.ts';
import { downloadActivity, downloadName, exportPath, localDay, recapGroups } from './catchUp.ts';

afterEach(() => vi.unstubAllGlobals());

const everything = { search: '', type: 'all', agent: 'all' };

describe('the address of an export', () => {
  it('asks for the format, and for nothing else when no filter is set', () => {
    expect(exportPath('csv', everything)).toBe('/api/activity/export?format=csv');
    expect(exportPath('json', everything)).toBe('/api/activity/export?format=json');
  });

  it('carries each filter the page has, with its text made safe for an address', () => {
    expect(
      exportPath('csv', { search: 'db & migrate', type: 'Approval', agent: 'Atlas scribe' }),
    ).toBe('/api/activity/export?format=csv&q=db+%26+migrate&type=Approval&agent=Atlas+scribe');
    expect(exportPath('json', { search: '', type: 'Session', agent: 'all' })).toBe(
      '/api/activity/export?format=json&type=Session',
    );
    expect(exportPath('json', { search: 'x', type: 'all', agent: 'Mori' })).toBe(
      '/api/activity/export?format=json&q=x&agent=Mori',
    );
  });
});

describe('dates and file names', () => {
  it('writes a date as the timeline asks for it, in local time', () => {
    expect(localDay(new Date(2026, 10, 6, 23, 59))).toBe('2026-11-06');
    expect(localDay(new Date(2026, 0, 2))).toBe('2026-01-02');
  });

  it("takes the file's name from the server's header", () => {
    const now = new Date(2026, 10, 6);
    expect(downloadName('attachment; filename="mabari-activity-2026-11-06.csv"', 'csv', now)).toBe(
      'mabari-activity-2026-11-06.csv',
    );
  });

  it('makes its own name with the date when the header is missing or would write somewhere else', () => {
    const now = new Date(2026, 10, 6);
    expect(downloadName(null, 'json', now)).toBe('mabari-activity-2026-11-06.json');
    expect(downloadName('attachment', 'csv', now)).toBe('mabari-activity-2026-11-06.csv');
    expect(downloadName('attachment; filename="../../etc/passwd"', 'csv', now)).toBe(
      'mabari-activity-2026-11-06.csv',
    );
  });
});

describe('a recap in the order it tells', () => {
  it('lists finished tasks, auto approved approvals, errors, then what needs you', () => {
    const group = (count: number) => ({ count, items: [] });
    const recap: Recap = {
      since: 1,
      until: 2,
      finished: group(1),
      autoApproved: group(2),
      errors: group(3),
      needs: group(4),
      happened: true,
    };
    expect(recapGroups(recap).map(({ key, group }) => [key, group.count])).toEqual([
      ['finished', 1],
      ['autoApproved', 2],
      ['errors', 3],
      ['needs', 4],
    ]);
  });
});

describe('downloading the log', () => {
  function stubPage() {
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { append: vi.fn() } });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const sent: Event[] = [];
    vi.stubGlobal('window', { dispatchEvent: (event: Event) => sent.push(event) });
    return { link, sent };
  }

  it('saves what the server sends under the name it gave, and returns the name', async () => {
    const { link } = stubPage();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('"Time"\n', {
        headers: { 'Content-Disposition': 'attachment; filename="mabari-activity-2026-11-06.csv"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const name = await downloadActivity('csv', { search: 'x', type: 'Approval', agent: 'all' });
    expect(name).toBe('mabari-activity-2026-11-06.csv');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/activity/export?format=csv&q=x&type=Approval');
    expect(link.download).toBe('mabari-activity-2026-11-06.csv');
    expect(link.href).toBe('blob:x');
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it("passes on the server's own words when it refuses", async () => {
    stubPage();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'format must be csv or json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(downloadActivity('csv', everything)).rejects.toThrow('format must be csv or json');
  });

  it('asks to sign in when the server says a sign in is needed', async () => {
    const { sent } = stubPage();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'sign in with the access key', login: true }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(downloadActivity('json', everything)).rejects.toThrow(
      'sign in with the access key',
    );
    expect(sent.map((event) => event.type)).toEqual([SIGN_IN_EVENT]);
  });

  it("says Mabari can't be reached, not the browser's own words", async () => {
    stubPage();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(downloadActivity('csv', everything)).rejects.toThrow("Can't reach Mabari.");
  });
});
