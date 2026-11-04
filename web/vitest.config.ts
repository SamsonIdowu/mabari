import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: 'packages/shared', include: ['**/*.test.ts'] } },
      { test: { name: 'server', root: 'apps/server', include: ['src/**/*.test.ts'] } },
      { test: { name: 'web', root: 'apps/web', include: ['src/**/*.test.{ts,tsx}'] } },
      { test: { name: 'scripts', root: 'scripts', include: ['**/*.test.ts'] } },
    ],
  },
});
