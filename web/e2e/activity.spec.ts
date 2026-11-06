// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';
import { wipe } from './support/page.ts';

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

test('a log with nothing in it says nothing has happened yet', async ({ page }) => {
  await page.goto('/#activity');
  await expect(page.locator('tbody')).toContainText('Nothing has happened yet');
  await expect(page.locator('tbody')).not.toContainText('Nothing matches');
  await expect(page.getByText('0 of 0 entries')).toBeVisible();
});

test('a filter that hides every row says nothing matches', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await page.goto('/#activity');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('Search the log').fill('zzz no such thing');
  await expect(page.locator('tbody')).toContainText('Nothing matches');
  await expect(page.locator('tbody')).not.toContainText('Nothing has happened yet');
});

test('the type filter offers every kind of entry, sessions included', async ({ page, request }) => {
  // Turning the demo off is logged as a session.
  await request.post('/api/demo/load');
  await request.post('/api/demo/stop');
  await page.goto('/#activity');
  const type = page.getByLabel('Type');
  await expect(type.locator('option')).toHaveText([
    'All types',
    'Instructions',
    'Queries',
    'Approvals',
    'Sessions',
  ]);
  await type.selectOption('Session');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Stopped the demo office');
  await type.selectOption('Approval');
  await expect(page.locator('tbody')).toContainText('Nothing matches');
});

test('the log can be narrowed to one agent', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await page.goto('/#activity');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const all = await rows.count();
  const agent = page.getByLabel('Agent', { exact: true });
  await expect(agent.locator('option').first()).toHaveText('All agents');
  await expect(agent.locator('option', { hasText: 'Atlas' })).toHaveCount(1);
  await agent.selectOption('Atlas');
  const some = await rows.count();
  expect(some).toBeGreaterThan(0);
  expect(some).toBeLessThan(all);
  // Every row left is Atlas's.
  const names = await rows.locator('td:nth-child(2)').allTextContents();
  expect(names.every((name) => name.trim() === 'Atlas')).toBe(true);
  await expect(page.getByText(`${some} of ${all} entries`)).toBeVisible();
});
