import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { innerWidth: 1440, localStorage: { getItem: () => null } });

const { resolveRailCollapsed } = await import('./railStore.ts');

describe('resolveRailCollapsed', () => {
  it('starts open on wide screens', () => {
    expect(resolveRailCollapsed(null, 1440)).toBe(false);
    expect(resolveRailCollapsed(null, 1180)).toBe(false);
  });

  it('starts collapsed below 1180 px', () => {
    expect(resolveRailCollapsed(null, 1179)).toBe(true);
  });

  it('prefers a saved choice over the width', () => {
    expect(resolveRailCollapsed('closed', 1440)).toBe(true);
    expect(resolveRailCollapsed('open', 1024)).toBe(false);
  });
});
