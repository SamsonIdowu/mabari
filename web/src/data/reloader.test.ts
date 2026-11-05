// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { ServerMessage, Snapshot } from '../gen/models.ts';
import { reloader } from './reloader.ts';

const snap = (seq: number) => ({ seq }) as unknown as Snapshot;
const message = (seq: number) => ({ type: 'agent', seq }) as unknown as ServerMessage;

/** A page whose snapshot calls are answered by hand, in whatever order a test likes. */
function page() {
  const pending: { resolve: (s: Snapshot) => void; reject: (e: Error) => void }[] = [];
  const log: string[] = [];
  let stopped = false;
  const made = reloader({
    snapshot: () =>
      new Promise<Snapshot>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    setSnapshot: (s) => log.push(`snapshot ${(s as unknown as { seq: number }).seq}`),
    applyAll: (messages) =>
      log.push(`apply ${messages.map((m) => (m as unknown as { seq: number }).seq).join(',')}`),
    flush: () => log.push('flush'),
    stopped: () => stopped,
  });
  return {
    ...made,
    pending,
    log,
    stop: () => (stopped = true),
  };
}

describe('loading the snapshot', () => {
  it('applies the snapshot, then the changes that arrived while it loaded, in order', async () => {
    const p = page();
    const done = p.reload();
    expect(p.hold(message(5))).toBe(true);
    expect(p.hold(message(6))).toBe(true);
    p.pending[0]!.resolve(snap(4));
    await done;
    expect(p.log).toEqual(['flush', 'snapshot 4', 'apply 5,6']);
    // Nothing is waiting any more, so the next change is applied at once.
    expect(p.hold(message(7))).toBe(false);
  });

  it('does not hold changes when no snapshot is loading', () => {
    expect(page().hold(message(1))).toBe(false);
  });

  it('drops a snapshot that lands after the page has gone', async () => {
    const p = page();
    const done = p.reload();
    p.stop();
    p.pending[0]!.resolve(snap(1));
    await done;
    expect(p.log).toEqual(['flush']);
  });

  it('clears what was held and rejects when the snapshot cannot be loaded', async () => {
    const p = page();
    const done = p.reload();
    p.hold(message(2));
    p.pending[0]!.reject(new Error('offline'));
    await expect(done).rejects.toThrow('offline');
    expect(p.hold(message(3))).toBe(false);
  });
});

// REV-7: reloads overlapped and shared the held changes. The first to land emptied them, and the
// second applied nothing and threw, so the page loaded the snapshot all over again.
describe('overlapping reloads', () => {
  it('applies only the newest, and the older one landing first neither throws nor clears what is held', async () => {
    const p = page();
    const first = p.reload();
    p.hold(message(5));
    const second = p.reload();
    p.hold(message(6));
    // The first lands while the second is still on its way.
    p.pending[0]!.resolve(snap(4));
    await expect(first).resolves.toBeUndefined();
    expect(p.log).toEqual(['flush', 'flush']);
    // Changes still wait for the second.
    expect(p.hold(message(7))).toBe(true);
    p.pending[1]!.resolve(snap(6));
    await expect(second).resolves.toBeUndefined();
    expect(p.log).toEqual(['flush', 'flush', 'snapshot 6', 'apply 5,6,7']);
    expect(p.hold(message(8))).toBe(false);
  });

  it('does not let an older snapshot that lands last replace the newer one', async () => {
    const p = page();
    const first = p.reload();
    const second = p.reload();
    p.pending[1]!.resolve(snap(9));
    await second;
    p.pending[0]!.resolve(snap(3));
    await expect(first).resolves.toBeUndefined();
    expect(p.log.filter((line) => line.startsWith('snapshot'))).toEqual(['snapshot 9']);
  });

  it('never applies the held list twice, however many reloads overlap', async () => {
    const p = page();
    const loads = [p.reload(), p.reload(), p.reload()];
    p.hold(message(1));
    for (const [index, pending] of p.pending.entries()) pending.resolve(snap(index));
    await Promise.all(loads);
    expect(p.log.filter((line) => line.startsWith('apply'))).toEqual(['apply 1']);
    expect(p.log.filter((line) => line.startsWith('snapshot'))).toEqual(['snapshot 2']);
  });

  it('stops holding changes if the newest fails, so they are not kept for ever', async () => {
    const p = page();
    const first = p.reload();
    const second = p.reload();
    p.hold(message(1));
    p.pending[1]!.reject(new Error('offline'));
    await expect(second).rejects.toThrow('offline');
    p.pending[0]!.resolve(snap(1));
    await first;
    expect(p.hold(message(2))).toBe(false);
  });
});
