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
  await page.getByRole('button', { name: /^Switch to (dark|light) theme$/ }).click();
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
    // The demo's banner sits between the header and the office.
    const above = (await page.locator('#demoBanner').locator('..').boundingBox())!;
    const main = (await page.locator('main').boundingBox())!;
    // The office sits right under them and runs to the bottom: no bar under it.
    expect(stage.y).toBeCloseTo(above.y + above.height, 0);
    expect(stage.x).toBe(main.x);
    // On a wide window the list of everyone on the floor sits beside it, and the floor runs up
    // to the list. On a narrow one the list starts hidden and the floor runs to the edge.
    const list = page.getByRole('complementary', { name: 'Everyone on the floor' });
    const right = width >= 1180 ? (await list.boundingBox())!.x : main.x + main.width;
    expect(stage.x + stage.width).toBeCloseTo(right, 0);
    if (width >= 1180) {
      const box = (await list.boundingBox())!;
      expect(box.x + box.width).toBeCloseTo(main.x + main.width, 0);
    } else await expect(list).toBeHidden();
    expect(stage.y + stage.height).toBeCloseTo(height, 0);
    await expect(page.locator('.cmdbar')).toHaveCount(0);
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
  // Atlas (approval) and Mori (error). Sage's queued instruction is a wait, not a request.
  await expect(page.locator('.tag .nt:visible')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(10);

  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Docs site/ }).click();
  await expect(page.locator('.dd').first()).toContainText('Docs site');
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
  await expect(page.locator('.dd').first()).toContainText('Test coverage');
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

test('the keyboard and the wheel zoom the office', async ({ page }) => {
  await loadDemo(page);
  const percent = page.locator('#zoomPct');
  await expect(percent).toHaveText('100%');
  await page.keyboard.press('=');
  await expect(percent).toHaveText('125%');
  await page.keyboard.press('0');
  await expect(percent).toHaveText('100%');
  await page.keyboard.press('-');
  await expect(percent).toHaveText('80%');
  await page.keyboard.press('0');
  await page.locator('#floor').hover();
  await page.mouse.wheel(0, -100);
  await expect(percent).toHaveText('125%');
});

test('shortcuts leave text boxes alone', async ({ page }) => {
  await loadDemo(page);
  const tag = (await page.locator('.tag', { hasText: 'Scout' }).first().boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('');
  await box.press('=');
  await box.press('f');
  await expect(box).toHaveValue('=f');
  await expect(page.locator('#zoomPct')).toHaveText('100%');
  await expect(page.locator('#fsBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('full screen hides only the top bar and the menu, and every control keeps working', async ({
  page,
}) => {
  await loadDemo(page);
  const button = page.locator('#fsBtn');
  await expect(button).toHaveAttribute('title', 'Full screen (F)');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeHidden();
  await expect(page.getByRole('button', { name: "Mabari's updates" })).toBeHidden();
  await page.keyboard.press('f');
  await expect(page.locator('body')).toHaveClass(/ofs/);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Exit full screen (F or Esc)');
  await expect(page.locator('.rail')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  // The header stays, compact, with all of its controls.
  const head = page.locator('.ohead');
  await expect(head).toBeVisible();
  for (const name of [
    'Auto approve',
    'New project',
    'Exit full screen',
    "Mabari's updates",
    'Colour key',
  ]) {
    await expect(head.getByRole('button', { name })).toBeVisible();
  }
  await head.getByRole('button', { name: 'Needs me' }).click();
  await expect(head.getByRole('button', { name: 'Needs me' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Exactly: Pause everyone is a button in the header too.
  await head.getByRole('button', { name: 'Everyone', exact: true }).click();
  // The wall bar, filters, bell and zoom tools work too.
  await page.getByRole('button', { name: 'Speech bubbles' }).click();
  await expect(page.getByRole('button', { name: 'Speech bubbles' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Speech bubbles' }).click();
  await page.getByRole('button', { name: 'Minimise' }).click();
  await expect(page.getByRole('button', { name: '1 approval waiting' })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('#zoomPct')).toHaveText('125%');
  // Mabari's updates open from the header, and lead back to Home.
  await head.getByRole('button', { name: "Mabari's updates" }).click();
  const updates = page.getByRole('dialog', { name: "Mabari's updates" });
  await expect(updates).toContainText('Open the chat with Mabari');
  // The agent panel and its message box work.
  const tag = (await page.locator('.tag', { hasText: 'Scout' }).first().boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.locator('.cmdbar')).toBeVisible();
  await head.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(page.locator('body')).not.toHaveClass(/ofs/);
});

test('in full screen Mabari counts its updates and opens the chat on Home', async ({ page }) => {
  await loadDemo(page);
  await page.keyboard.press('f');
  await page.evaluate(() =>
    fetch('/api/vee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'tell Scout to add the pricing pages' }),
    }),
  );
  // The relay arrives while Home can't be seen: a count on the button and a toast.
  const updatesButton = page.getByRole('button', { name: "Mabari's updates" });
  await updatesButton.click();
  const updates = page.getByRole('dialog', { name: "Mabari's updates" });
  await updates.getByRole('button', { name: 'Open the chat with Mabari' }).click();
  await expect(page.locator('body')).not.toHaveClass(/ofs/);
  await expect(page).toHaveURL(/#home$/);
});

test('escape leaves full screen last', async ({ page }) => {
  await loadDemo(page);
  await page.keyboard.press('f');
  await expect(page.locator('body')).toHaveClass(/ofs/);
  // The header and the floor take their full screen places over a few frames (the header may
  // change rows), so Scout is clicked once its tag has stopped moving.
  const scout = page.locator('.tag', { hasText: 'Scout' }).first();
  let last = (await scout.boundingBox())!;
  await expect
    .poll(async () => {
      const now = (await scout.boundingBox())!;
      const still = Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5;
      last = now;
      return still;
    })
    .toBe(true);
  const tag = (await scout.boundingBox())!;
  await page.mouse.click(tag.x + tag.width / 2, tag.y - 24);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel).toBeVisible();
  await page.locator('h2', { hasText: 'Scout' }).click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/ofs/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/ofs/);
});

test('an approval card shows over full screen', async ({ page }) => {
  await loadDemo(page);
  await page.keyboard.press('f');
  await page.locator('.bitem').click();
  const card = page.getByRole('dialog');
  await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/ofs/);
});

test('name tags grow and shrink with the zoom', async ({ page }) => {
  await loadDemo(page);
  const layer = page.locator('.ovl');
  const scale = async () =>
    Number(await layer.evaluate((node) => node.style.getPropertyValue('--oz')));
  await expect.poll(scale).toBeGreaterThan(0);
  const start = await scale();
  await page.keyboard.press('=');
  await page.keyboard.press('=');
  await expect.poll(scale).toBeGreaterThan(start);
});

test('zooming far out hides ordinary bubbles but keeps approvals', async ({ page }) => {
  await loadDemo(page);
  for (let press = 0; press < 4; press++) await page.keyboard.press('-');
  await expect(page.locator('#zoomPct')).toHaveText('50%');
  await expect(page.locator('.ovl.far')).toBeAttached();
  await expect(page.locator('.bub:not(.red):not(.reply):visible')).toHaveCount(0);
  await expect(page.locator('.bub.red:visible').first()).toBeVisible();
});

test('zooming below 100% keeps the office centred and panning off', async ({ page }) => {
  await loadDemo(page);
  await page.keyboard.press('-');
  await expect(page.locator('#zoomPct')).toHaveText('80%');
  const box = (await page.locator('#floor').boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 400, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('0');
  await expect(page.locator('#zoomPct')).toHaveText('100%');
});
