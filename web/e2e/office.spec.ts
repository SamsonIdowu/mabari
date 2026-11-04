// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

/** Counts the colours on the canvas, so a blank or broken canvas fails. */
function colours(page: Page) {
  return page.locator('#floor').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set<number>();
    for (let index = 0; index < data.length; index += 400) {
      seen.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
    }
    return seen.size;
  });
}

test('shows the no accounts message on an empty floor', async ({ page }) => {
  await page.goto('/#office');
  await expect(page.getByRole('heading', { name: 'No accounts connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.getByRole('heading', { name: 'No accounts connected' })).toBeHidden();
  await expect(page.locator('.tag .nt')).toHaveCount(10);
});

test('draws the office in both themes', async ({ page }) => {
  await loadDemo(page);
  expect(await colours(page)).toBeGreaterThan(40);
  const dark = await page.locator('#floor').screenshot();
  await page.locator('.topright .tbtn').click();
  await page.waitForTimeout(200);
  const light = await page.locator('#floor').screenshot();
  expect(dark.equals(light)).toBe(false);
});

for (const [width, height] of [
  [1920, 1080],
  [1440, 900],
  [1100, 700],
] as const) {
  test(`the office fills the floor area at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await loadDemo(page);
    const stage = (await page.locator('.stage').boundingBox())!;
    const bar = (await page.locator('.obar2').boundingBox())!;
    const main = (await page.locator('main').boundingBox())!;
    expect(stage.y).toBe(bar.y + bar.height);
    expect(stage.x).toBe(main.x);
    expect(stage.x + stage.width).toBe(main.x + main.width);
    const commands = (await page.locator('.cmdbar').boundingBox())!;
    expect(stage.y + stage.height).toBe(commands.y);
    expect(commands.y + commands.height).toBe(height);
  });
}

test('name tags show every state with time estimates', async ({ page }) => {
  await loadDemo(page);
  const tags = page.locator('.tag .nt');
  await expect(tags.filter({ hasText: 'Atlas' }).first()).toContainText('paused');
  await expect(tags.filter({ hasText: 'Mori' })).toContainText('stopped');
  await expect(tags.filter({ hasText: 'Rune' })).toContainText('done');
  await expect(tags.filter({ hasText: 'Ledger' })).toContainText(/~\d+m/);
  await expect(page.locator('.tag .qd:visible')).toHaveText('Waiting to deliver');
});

test('the header summarises the floor', async ({ page }) => {
  await loadDemo(page);
  const summary = page.locator('#officeClock');
  await expect(summary).toContainText('10 agents');
  await expect(summary).toContainText('need you');
  await expect(summary).toContainText(/done ~\d+ min/);
  await expect(summary.locator('[title*="not counting 1 waiting on you"]')).toBeVisible();
});

test('the notice board lists approvals', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('.board')).toContainText('Atlas: npm run db:migrate');
});

test('filters and projects narrow the floor', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('button', { name: 'Needs me' }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(3);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(10);

  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Docs site/ }).click();
  await expect(page.locator('h1')).toHaveText('Docs site');
  await expect(page.locator('.tag .nt:visible')).toHaveCount(3);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: /^Models/ }).click();
  await page.getByRole('menuitemradio', { name: 'Every Custom agent' }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(2);
});

test('opening a project from the Projects page filters the floor', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .locator('article', { hasText: 'Test coverage' })
    .getByRole('link', { name: 'Open in office' })
    .click();
  await expect(page.locator('h1')).toHaveText('Test coverage');
  await page.getByRole('button', { name: 'Clear filters' }).click();
});

test('selecting an agent opens the spotlight, and clicking away closes it', async ({ page }) => {
  await loadDemo(page);
  const tag = (await page.locator('.tag', { hasText: 'Mori' }).boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  await expect(page.locator('.fhname')).toContainText('Mori');
  await expect(page.locator('.finfo')).toContainText('#A-0008');
  await expect(page.locator('.readout')).toContainText('Elapsed');
  await expect(page.locator('.fbubble')).toHaveText('Lost connection to the embedding service');
  await page.locator('.fscrim').click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.fhname')).toBeHidden();
  await expect(page.locator('.readout')).toContainText('Agents');
});

test('zoom tools change the view and fit resets it', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('#zoomPct')).toHaveText('100%');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('#zoomPct')).toHaveText('150%');
  await page.getByRole('button', { name: 'Fit the whole office' }).click();
  await expect(page.locator('#zoomPct')).toHaveText('100%');
});
