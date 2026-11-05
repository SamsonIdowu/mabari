// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';
import { demoLength, exploreDemo } from './demo.ts';
import { useOfficeStore } from './officeStore.ts';

const now = 1_800_000_000_000;
const minute = 60_000;

describe('how long the demo says it runs', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { hash: '' } }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('tells the time the server gave, not a number of its own', () => {
    expect(demoLength(now + 10 * minute, now)).toBe('It turns itself off in 10 minutes.');
    expect(demoLength(now + 10 * minute - 2_000, now)).toBe('It turns itself off in 10 minutes.');
    expect(demoLength(now + 3 * minute, now)).toBe('It turns itself off in 3 minutes.');
    expect(demoLength(now + 20 * minute, now)).toBe('It turns itself off in 20 minutes.');
    expect(demoLength(now + 40_000, now)).toBe('It turns itself off in 1 minute.');
  });

  it("doesn't guess when the server gave no time", () => {
    expect(demoLength(undefined, now)).toBe('It turns itself off soon.');
    expect(demoLength(0, now)).toBe('It turns itself off soon.');
    expect(demoLength(now - 1, now)).toBe('It turns itself off soon.');
  });

  it('puts the server’s time in the toast shown after loading the demo', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(api, 'loadDemo').mockResolvedValue({ ok: true, endsAt: now + 10 * minute });
    const toast = vi.fn();
    vi.spyOn(useOfficeStore, 'getState').mockReturnValue({ toast } as never);
    await exploreDemo();
    expect(toast).toHaveBeenCalledWith(
      'Demo office loaded. Every agent state is on the floor. It turns itself off in 10 minutes.',
    );
  });

  it('follows the server when it runs the demo for another length', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(api, 'loadDemo').mockResolvedValue({ ok: true, endsAt: now + 20 * minute });
    const toast = vi.fn();
    vi.spyOn(useOfficeStore, 'getState').mockReturnValue({ toast } as never);
    await exploreDemo();
    expect(toast.mock.calls[0]?.[0]).toContain('in 20 minutes');
  });
});
