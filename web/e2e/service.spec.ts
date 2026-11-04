// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

test('Run at login is off and explains why under go run', async ({ page }) => {
  await page.goto('/#preferences');
  const box = page.locator('#pLogin');
  await expect(box).toBeDisabled();
  await expect(page.locator('label.switch', { has: box })).toHaveAttribute(
    'title',
    /Not available here: install the service from a built mabari/,
  );
});

test('Run at login turns on for the next login only', async ({ page }) => {
  const posted: string[] = [];
  let installed = false;
  await page.route('**/api/service', (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postData() ?? '');
      installed = (JSON.parse(route.request().postData() ?? '{}') as { on: boolean }).on;
    }
    return route.fulfill({ json: { supported: true, installed, running: false, detail: '' } });
  });
  await page.goto('/#preferences');
  const box = page.locator('#pLogin');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
  await box.click();
  await expect(box).not.toBeChecked();
  expect(posted).toEqual(['{"on":true}', '{"on":false}']);
});
