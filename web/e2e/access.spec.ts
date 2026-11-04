// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await request.patch('/api/settings', { data: { requireLogin: false } });
});

let knownKey = '';

// If a test stops half way with the shared computer setting on, sign in and turn it off, so the
// other tests aren't asked for the key.
test.afterEach(async ({ request }) => {
  if (knownKey) await request.post('/api/login', { data: { key: knownKey } });
  await request.patch('/api/settings', { data: { requireLogin: false } });
  knownKey = '';
});

test('LAN access shows where other devices sign in, and the key', async ({ page }) => {
  await page.goto('/#preferences');
  await page.getByText('Allow other devices on my network').click();
  await expect(page.locator('#lanAddresses')).toContainText('http://192.0.2.10:');
  await expect(page.locator('#lanAddresses')).toContainText('sign in with the access key');
  const key = page.locator('#pAccessKey');
  await expect(key).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(key).toHaveValue(/^mab_[0-9a-f]{40}$/);
  const first = await key.inputValue();
  await page.getByRole('button', { name: 'New key' }).click();
  await expect(key).not.toHaveValue(first);
  await page.getByText('Allow other devices on my network').click();
  await expect(page.getByText('Off. Mabari only answers on localhost.')).toBeAttached();
});

test('a shared computer asks for the key, and a wrong one is refused', async ({ page }) => {
  await page.goto('/#preferences');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.locator('#pAccessKey')).toHaveValue(/^mab_/);
  const key = await page.locator('#pAccessKey').inputValue();
  knownKey = key;
  await page.getByText('Ask for the access key on this computer too').click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Mabari' })).toBeVisible();
  await page.getByLabel('Access key').fill('mab_wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText("That access key isn't right.");
  await page.getByLabel('Access key').fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Mabari' })).toBeHidden();
  await page.goto('/#preferences');
  await page.getByText('Ask for the access key on this computer too').click();
  await expect(page.locator('#pRequireLogin')).not.toBeChecked();
});
