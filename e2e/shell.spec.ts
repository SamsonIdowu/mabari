import { expect, test, type Page } from '@playwright/test';
import { themes } from '@mabari/shared/tokens';

const NAV: [string, string][] = [
  ['Office', 'Office'],
  ['Projects', 'Projects'],
  ['Conversations', 'Conversations'],
  ['Accounts', 'Accounts'],
  ['Activity log', 'Activity log'],
  ['Settings', 'Settings'],
  ['Component sheet', 'Component sheet'],
  ['Status screens', 'Status screens'],
  ['First run', 'See your AI agents at work, in a little office.'],
];

function cssVar(page: Page, name: string) {
  return page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name,
  );
}

test('starts on the welcome page in the dark theme', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('See your AI agents at work, in a little office.');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await cssVar(page, '--bg')).toBe(themes.dark.bg);
});

test('every nav link routes and marks itself current', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('complementary', { name: 'Main' });
  for (const [label, heading] of NAV) {
    await rail.getByRole('link', { name: label, exact: true }).click();
    await expect(page.locator('h1')).toHaveText(heading);
    await expect(rail.locator('[aria-current="page"]')).toHaveText(label);
  }
});

test('the theme button switches themes and remembers the choice', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await cssVar(page, '--bg')).toBe(themes.light.bg);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Dark theme' })).toBeVisible();
  expect(await cssVar(page, '--bg')).toBe(themes.light.bg);

  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Light theme' })).toBeVisible();
});

test('shows the local only status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('localhost:4317 · only on this computer')).toBeVisible();
});

test('turns the status red when the server cannot be reached', async ({ page }) => {
  await page.route('/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByText('Mabari server not reachable')).toBeVisible();
});

test('the rail starts collapsed below 1180 px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  const box = await page.getByRole('complementary', { name: 'Main' }).boundingBox();
  expect(box?.width).toBe(68);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
});

test('the menu collapses, keeps tooltips and remembers the choice', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('complementary', { name: 'Main' });
  const width = async () => (await rail.boundingBox())?.width;
  expect(await width()).toBe(220);

  const collapse = page.getByRole('button', { name: 'Collapse menu' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect.poll(width).toBe(68);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
  await expect(rail.getByRole('link', { name: 'Status screens' })).toHaveAttribute(
    'title',
    'Status screens',
  );

  await page.reload();
  await expect(page.locator('.app')).toHaveClass(/collapsed/);

  const expand = page.getByRole('button', { name: 'Expand menu' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect.poll(width).toBe(220);
});

test('the app fills the window with no margins', async ({ page }) => {
  await page.goto('/');
  const box = await page.locator('.app').boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
});
