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
      'hide-bub hide-meta hide-msg hide-link hide-tags',
    );
    useLayers.getState().quiet();
    expect(hiddenClasses(useLayers.getState().layers)).toBe('');
  });

  it("shows connections between agents until they're turned off, even with an older saved choice", async () => {
    storage.set('mabari.layers', JSON.stringify({ bub: false, meta: true, msg: true, tags: true }));
    const { useLayers } = await import('./layers.ts');
    expect(useLayers.getState().layers).toMatchObject({ bub: false, link: true });
    useLayers.getState().toggle('link');
    expect(JSON.parse(storage.get('mabari.layers')!).link).toBe(false);
  });

  it('keeps quiet mode quiet for someone who saved it before connections were a layer', async () => {
    storage.set(
      'mabari.layers',
      JSON.stringify({ bub: false, meta: false, msg: false, tags: false }),
    );
    const { useLayers, isQuiet } = await import('./layers.ts');
    expect(isQuiet(useLayers.getState().layers)).toBe(true);
  });
});
