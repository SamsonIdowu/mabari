// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Tests never touch real data.
const dataDir = mkdtempSync(join(tmpdir(), 'mabari-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4317',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  // Started directly, not through `make dev`, because air detaches its child process.
  webServer: [
    {
      command: 'go run ./cmd/mabari serve --port 4327',
      cwd: '..',
      env: { MABARI_DATA_DIR: dataDir },
      url: 'http://127.0.0.1:4327/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:4317',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
