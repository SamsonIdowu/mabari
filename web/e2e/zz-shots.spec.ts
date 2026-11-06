// SPDX-License-Identifier: Apache-2.0
import { test } from '@playwright/test';

const out = '/private/tmp/claude-501/-Users-samson-Projects-mabari/39716f96-fd1a-4022-b356-7f58cb0cc4dc/scratchpad/shots';

test('shots', async ({ page, request }) => {
  test.setTimeout(90_000);
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.post('/api/demo/load');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#conversations');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/with-1440.png` });
  await page.locator('.chrow').nth(2).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/agent-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/agent-390.png` });
  await page.goto('/#conversations');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/list-390.png` });
});
