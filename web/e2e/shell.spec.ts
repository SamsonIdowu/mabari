// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import { themes } from '../src/shared/tokens.ts';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

const NAV: [name: string, label: string, heading: string][] = [
  ['Agents', 'Agents', 'Agents'],
  ['Projects', 'Projects', 'Projects'],
  ['Agent builder', 'Builder', 'Agent builder'],
  ['Chats, conversations', 'Chats', 'Conversations'],
  ['Accounts', 'Accounts', 'Accounts'],
  ['Activity log', 'Activity', 'Activity log'],
  ['Settings', 'Settings', 'Settings'],
  ['Library', 'Library', 'Library'],
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

test('opens in light mode whatever the computer prefers', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background(page)).toBe(rgb(themes.light.bg));
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(rgb(themes.dark.bg));
});

test('the Notes switch shows and hides the design notes', async ({ page, request }) => {
  await request.post('/api/demo/load');
  await page.goto('/#office');
  const note = page.locator('#noteQueue');
  await expect(note).toBeHidden();
  await page.locator('.topright').getByText('Notes').click();
  await expect(page.locator('.fnote:visible')).toHaveCount(3);
  await expect(page.locator('#noteQueue')).toContainText('Amber tag');
  await page.locator('.topright').getByText('Notes').click();
  await expect(note).toBeHidden();
  await expect(page.locator('.fnote:visible')).toHaveCount(0);
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

test('the top bar brand goes home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Mabari, go home' }).click();
  await expect(page.locator('#homeGreet')).toHaveText(/^Good (morning|afternoon|evening)$/);
});

test('the theme button switches themes and remembers the choice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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

test('the calmer page styles win over the older ones', async ({ page }) => {
  await page.goto('/#preferences');
  const heading = page.locator('.phead h1');
  await expect(heading).toHaveCSS('font-size', '34px');
  await expect(page.locator('.phead p')).toBeHidden();
  await expect(page.locator('.page').first()).toHaveCSS('max-width', 'none');
});

test('shows the local only status', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('.localpill');
  await expect(status).toHaveText('Local');
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
  expect(box?.width).toBe(58);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
});

test('the menu collapses, keeps tooltips and remembers the choice', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('complementary', { name: 'Main' });
  const width = async () => (await rail.boundingBox())?.width;
  expect(await width()).toBe(84);

  const collapse = page.getByRole('button', { name: 'Collapse menu' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect.poll(width).toBe(58);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Library' })).toHaveAttribute('title', /^Library/);
  await expect(rail.getByRole('link', { name: 'Projects' })).toHaveAttribute('title', 'Projects');

  await page.reload();
  await expect(page.locator('.app')).toHaveClass(/collapsed/);

  const expand = page.getByRole('button', { name: 'Expand menu' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect.poll(width).toBe(84);
});

test('the app fills the window with no margins', async ({ page }) => {
  await page.goto('/');
  const box = await page.locator('.app').boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
});
