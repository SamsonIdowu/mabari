// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';
import { useTrust } from './trust.ts';

const refusal = { folder: '/code/shop', found: ['/code/shop/.mcp.json'] };

function respondWith(...replies: Response[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path} ${String(init?.body ?? '')}`);
    const reply = replies.shift();
    if (!reply) throw new Error(`nothing left to answer ${path}`);
    return Promise.resolve(reply);
  });
  return calls;
}

const trustNeeded = () =>
  new Response(JSON.stringify({ error: 'no', trust: refusal }), { status: 409 });
const fine = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  useTrust.setState({ asking: null });
});

describe('a folder that brings its own code', () => {
  it('asks, then sends the same request again once it is trusted', async () => {
    const calls = respondWith(trustNeeded(), fine({ ok: true }), fine({ agentId: 'a1' }));
    const sent = api.sendToProject('p1', 'look around');
    await vi.waitFor(() => expect(useTrust.getState().asking?.folder).toBe('/code/shop'));
    useTrust.getState().answer(true);
    await expect(sent).resolves.toEqual({ agentId: 'a1' });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('POST /api/folders/trust');
    expect(calls[1]).toContain('"confirm":true');
    // What the person was shown is what they agreed to.
    expect(calls[1]).toContain('"found":["/code/shop/.mcp.json"]');
    expect(calls[2]).toBe(calls[0]);
  });

  it('trusts nothing and starts nothing when the person says no', async () => {
    const calls = respondWith(trustNeeded());
    const sent = api.sendToProject('p1', 'look around');
    await vi.waitFor(() => expect(useTrust.getState().asking).not.toBeNull());
    useTrust.getState().answer(false);
    await expect(sent).rejects.toThrow("you didn't trust that folder");
    expect(calls).toHaveLength(1);
  });

  it('leaves other refusals alone', async () => {
    respondWith(new Response(JSON.stringify({ error: 'The office is full.' }), { status: 409 }));
    await expect(api.sendToProject('p1', 'x')).rejects.toThrow('The office is full.');
    expect(useTrust.getState().asking).toBeNull();
  });

  it('answers no to an earlier question when another comes, rather than leaving it waiting', async () => {
    const first = useTrust.getState().ask(refusal);
    const second = useTrust.getState().ask({ ...refusal, folder: '/code/other' });
    await expect(first).resolves.toBe(false);
    expect(useTrust.getState().asking?.folder).toBe('/code/other');
    useTrust.getState().answer(true);
    await expect(second).resolves.toBe(true);
  });
});
