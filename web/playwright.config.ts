// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Tests never touch real data.
const dataDir = mkdtempSync(join(tmpdir(), 'mabari-e2e-'));
// MABARI_WEB_PORT and MABARI_API_PORT move the test servers off 4317 and 4327, for when Mabari is running.
const webPort = process.env.MABARI_WEB_PORT ?? '4317';
const apiPort = process.env.MABARI_API_PORT ?? '4327';

export default defineConfig({
  testDir: 'e2e',
  // Tests share one server and its demo office, so they run one at a time.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${webPort}`,
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
      command: `go run ./cmd/mabari serve --port ${apiPort}`,
      cwd: '..',
      env: { MABARI_DATA_DIR: dataDir },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev',
      env: { MABARI_WEB_PORT: webPort, MABARI_API_PORT: apiPort },
      url: `http://localhost:${webPort}`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
