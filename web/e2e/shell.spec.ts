// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import { themes } from '../src/shared/tokens.ts';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

const NAV: [name: string, label: string, heading: string][] = [
  ['Office', 'Office', 'All projects'],
  ['Projects', 'Projects', 'Projects'],
  ['Conversations', 'Chats', 'Conversations'],
  ['Accounts', 'Accounts', 'Accounts'],
  ['Activity log', 'Activity', 'Activity log'],
  ['Settings', 'Settings', 'Settings'],
  ['Components', 'Components', 'Component sheet'],
  ['Status screens', 'Status', 'Status screens'],
  ['First run', 'First run', 'See your AI agents at work, in a little office.'],
];

/** The colour actually painted, so the check holds for minified CSS too. */
function background(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

function rgb(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

test('starts on the welcome page in the dark theme', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('See your AI agents at work, in a little office.');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(rgb(themes.dark.bg));
});

test('every nav link routes and marks itself current', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('complementary', { name: 'Main' });
  for (const [name, label, heading] of NAV) {
    await rail.getByRole('link', { name, exact: true }).click();
    await expect(page.locator('h1')).toHaveText(heading);
    await expect(rail.locator('[aria-current="page"] .lbl')).toHaveText(label);
  }
});

test('the top bar brand goes to the office', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.bm-tag')).toHaveText('Your AI agents at work');
  await page.getByRole('link', { name: 'Mabari, go to the office' }).click();
  await expect(page.locator('h1')).toHaveText('All projects');
});

test('the theme button switches themes and remembers the choice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background(page)).toBe(rgb(themes.light.bg));

  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
  expect(await background(page)).toBe(rgb(themes.light.bg));

  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Light' })).toBeVisible();
});

test('shows the local only status', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('.localpill');
  await expect(status).toHaveText('Local localhost:4317');
  await expect(status).toHaveAttribute('title', /only on this computer/);
});

test('turns the status red when the server cannot be reached', async ({ page }) => {
  await page.route('/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByText('Mabari server not reachable')).toBeVisible();
});

test('the rail starts collapsed below 1180 px and the top bar slims down', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  const box = await page.getByRole('complementary', { name: 'Main' }).boundingBox();
  expect(box?.width).toBe(68);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
  await expect(page.locator('.bm-tag')).toBeHidden();
});

test('the menu collapses, keeps tooltips and remembers the choice', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('complementary', { name: 'Main' });
  const width = async () => (await rail.boundingBox())?.width;
  expect(await width()).toBe(104);

  const collapse = page.getByRole('button', { name: 'Collapse menu' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect.poll(width).toBe(68);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Status screens' })).toHaveAttribute(
    'title',
    /^Status screens/,
  );
  await expect(rail.getByRole('link', { name: 'Projects' })).toHaveAttribute('title', 'Projects');

  await page.reload();
  await expect(page.locator('.app')).toHaveClass(/collapsed/);

  const expand = page.getByRole('button', { name: 'Expand menu' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect.poll(width).toBe(104);
});

test('the app fills the window with no margins', async ({ page }) => {
  await page.goto('/');
  const box = await page.locator('.app').boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
});
