// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('All projects');
}

const go = (page: Page, route: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash;
  }, route);

const SCREENS: [route: string, heading: string][] = [
  ['#welcome', 'See your AI agents at work, in a little office.'],
  ['#projects', 'Projects'],
  ['#conversations', 'Conversations'],
  ['#accounts', 'Accounts'],
  ['#activity', 'Activity log'],
  ['#preferences', 'Settings'],
  ['#components', 'Component sheet'],
  ['#states', 'Status screens'],
];

test('first run turns into the office once the demo loads', async ({ page }) => {
  await loadDemo(page);
  await expect(page.getByText('Demo office loaded.')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('All projects');
});

test('every screen renders in both themes without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loadDemo(page);
  for (let click = 0; click < 2; click++) {
    await page.locator('.topright .tbtn').click();
    for (const [route, heading] of SCREENS) {
      await go(page, route);
      await expect(page.locator('main h1')).toHaveText(heading);
    }
  }
  expect(errors).toEqual([]);
});

test('the nav badge counts agents that need you', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('.rail .badge').first()).toHaveText('2');
});

test('projects show progress, estimates and completion from the server', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#projects');
  const card = page.locator('article', { hasText: 'Test coverage' });
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(card.getByText('Estimated completion:')).toBeVisible();
  const landing = page.locator('article', { hasText: 'Landing page' });
  await expect(landing.getByText('Completed 2 days ago')).toBeVisible();
  await expect(landing.getByText('Fixed 14 accessibility issues')).toBeVisible();

  await page.getByRole('button', { name: 'Completed 1' }).click();
  await expect(page.locator('main article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Landing page is open again')).toBeVisible();
  await expect(page.getByText('No completed projects yet')).toBeVisible();
});

test('the activity log searches and filters', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#activity');
  await expect(page.getByText('5 of 5 entries. Kept for 30 days.')).toBeVisible();
  await page.getByLabel('Search the log').fill('changelog');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Waiting for checkpoint')).toBeVisible();
  await page.getByLabel('Search the log').fill('');
  await page.getByLabel('Type').selectOption('Approval');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Search the log').fill('no such thing');
  await expect(page.getByText('Nothing matches. Try a different word or type.')).toBeVisible();
});

test('conversations list threads and open one', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#conversations');
  await page.getByRole('button', { name: /Ledger and Sage/ }).click();
  await expect(page.locator('.cmsg', { hasText: 'Yes, for pagination.' })).toBeVisible();
  await page.getByLabel('Search conversations').fill('rollback');
  await expect(page.getByRole('button', { name: /Atlas and Atlas scribe/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Ledger and Sage/ })).toBeHidden();
});

test('accounts show connections without pretending to connect', async ({ page }) => {
  await page.goto('/#accounts');
  await expect(page.locator('.chip', { hasText: 'Not connected' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeDisabled();
  await page.getByText('API keys (optional)').click();
  await expect(page.getByLabel('Key').first()).toBeDisabled();
});

test('settings are saved on the server', async ({ page, request }) => {
  await page.goto('/#preferences');
  await page.getByLabel('Keep events for').selectOption('90');
  await page.getByText('Read agent replies aloud').click();
  await page.getByText('Allow other devices on my network').click();
  await expect(page.getByText('Turn this off on shared or public networks.')).toBeVisible();
  await expect
    .poll(async () => (await (await request.get('/api/settings')).json()).retentionDays)
    .toBe(90);
  await page.reload();
  await expect(page.getByLabel('Keep events for')).toHaveValue('90');
  await expect(page.getByRole('checkbox', { name: 'Read agent replies aloud' })).toBeChecked();
});

test('the query model picker lists only connected accounts', async ({ page }) => {
  await page.goto('/#preferences');
  await expect(page.getByLabel('Model that answers queries')).toBeDisabled();
  await loadDemo(page);
  await go(page, '#preferences');
  await expect(page.getByLabel('Model that answers queries')).toBeEnabled();
});

test('wiping asks twice and returns to first run', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#preferences');
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  await page.getByRole('button', { name: 'Yes, wipe all data' }).click();
  await expect(page.getByText('All data wiped')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('See your AI agents at work, in a little office.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Explore a demo office' })).toBeVisible();
});

test('live updates reach the page', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#activity');
  await expect(page.getByText('5 of 5 entries.')).toBeVisible();
  await page.request.patch('/api/settings', { data: { retentionDays: 7 } });
  await expect(page.getByText('Kept for 7 days.')).toBeVisible();
});
