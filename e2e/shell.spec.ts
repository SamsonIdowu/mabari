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
  ['Empty and error states', 'Empty and error states'],
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

test('collapses the rail to icons at 1024 px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  const box = await page.getByRole('complementary', { name: 'Main' }).boundingBox();
  expect(box?.width).toBe(68);
  await expect(page.locator('.rail .lbl').first()).toBeHidden();
});
