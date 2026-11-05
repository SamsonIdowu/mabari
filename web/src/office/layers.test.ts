// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

describe('noise filters', () => {
  it('start with everything shown and remember each choice in this browser', async () => {
    const { useLayers, hiddenClasses } = await import('./layers.ts');
    expect(hiddenClasses(useLayers.getState().layers)).toBe('');
    useLayers.getState().toggle('meta');
    expect(hiddenClasses(useLayers.getState().layers)).toBe('hide-meta');
    vi.resetModules();
    const again = await import('./layers.ts');
    expect(again.useLayers.getState().layers.meta).toBe(false);
  });

  it('quiet mode hides every layer, and a second press shows them all', async () => {
    const { useLayers, isQuiet, hiddenClasses } = await import('./layers.ts');
    useLayers.getState().quiet();
    expect(isQuiet(useLayers.getState().layers)).toBe(true);
    expect(hiddenClasses(useLayers.getState().layers)).toBe(
      'hide-bub hide-meta hide-msg hide-tags',
    );
    useLayers.getState().quiet();
    expect(hiddenClasses(useLayers.getState().layers)).toBe('');
  });
});
