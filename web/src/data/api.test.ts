// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, unreachableMessage } from './api.ts';
import { holdChangesWith } from './heldChanges.ts';

afterEach(() => vi.unstubAllGlobals());

const offline = () =>
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

describe('a call that never reaches Mabari', () => {
  it('says so, in words, and not the browser own "Failed to fetch"', async () => {
    offline();
    await expect(api.updateSettings({ spokenReplies: true })).rejects.toThrow(
      "Can't reach Mabari. Your change was not saved.",
    );
  });

  it('says an approval was not sent, and is still waiting', async () => {
    offline();
    await expect(api.decide('ap-1', 'allowed')).rejects.toThrow(
      "Can't reach Mabari. Your decision was not sent. The approval is still waiting.",
    );
  });

  it('says a message to Mabari or an agent was not sent', async () => {
    offline();
    await expect(api.vee('status')).rejects.toThrow(
      "Can't reach Mabari. Your message was not sent.",
    );
    await expect(
      api.sendMessage('hello', 'instruct', 'auto', { projectId: 'all', teamId: '' }),
    ).rejects.toThrow("Can't reach Mabari. Your message was not sent.");
    await expect(api.sendToProject('shop', 'hello')).rejects.toThrow(
      "Can't reach Mabari. Your message was not sent.",
    );
  });

  it('says nothing about a change for something that only reads', async () => {
    offline();
    await expect(api.snapshot()).rejects.toThrow("Can't reach Mabari.");
    await expect(api.snapshot()).rejects.not.toThrow('not saved');
  });

  it('leaves a call someone cancelled alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')),
    );
    await expect(api.transcribe(new Blob(), 'en')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("still passes on the server's own words when it answers with an error", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'that folder is gone' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(api.updateSettings({})).rejects.toThrow('that folder is gone');
  });
});

describe('unreachableMessage', () => {
  it('picks the sentence from what was being done', () => {
    expect(unreachableMessage('/api/settings', 'PATCH')).toContain('change was not saved');
    expect(unreachableMessage('/api/approvals/ap-1/decision', 'POST')).toContain('not sent');
    expect(unreachableMessage('/api/vee', 'POST')).toContain('message was not sent');
    expect(unreachableMessage('/api/snapshot')).toBe("Can't reach Mabari.");
  });
});

// The server pushes a change over the WebSocket and then answers the call that caused it. The
// office holds pushed changes for a frame, so an answer must not get ahead of them: Mabari reads
// whether an agent has its instruction the moment the answer comes.
describe('an answer from the server', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('arrives after the changes the server pushed before it were applied', async () => {
    const order: string[] = [];
    const release = holdChangesWith(() => order.push('applied'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true })));
    await api.snapshot();
    order.push('answered');
    release();
    expect(order[0]).toBe('applied');
    expect(order.at(-1)).toBe('answered');
  });

  it('does the same for an error, and for an answer with no content', async () => {
    for (const response of [json({ error: 'no' }, 400), new Response(null, { status: 204 })]) {
      const applied = vi.fn();
      const release = holdChangesWith(applied);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await api.updateSettings({ spokenReplies: true }).catch(() => undefined);
      expect(applied).toHaveBeenCalled();
      release();
    }
  });
});
