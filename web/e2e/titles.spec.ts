// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function title(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  const heading = page.locator('section[data-screen] .phead h1');
  await expect(heading).toBeVisible();
  await page.waitForTimeout(250);
  return (await heading.boundingBox())!;
}

test('the Library title is the size and place of the other screens', async ({ page }) => {
  const activity = await title(page, '#activity');
  const library = await title(page, '#components');
  expect(Math.abs(library.height - activity.height)).toBeLessThan(1);
  expect(Math.abs(library.y - activity.y)).toBeLessThan(1);
  expect(Math.abs(library.x - activity.x)).toBeLessThan(1);
  for (const hash of ['#projects', '#builder', '#accounts']) {
    const other = await title(page, hash);
    expect(Math.abs(library.height - other.height)).toBeLessThan(1);
    expect(Math.abs(library.y - other.y)).toBeLessThan(1);
  }
});
