// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface Def {
  id: string;
  system: boolean;
}

// Agent files outlive wipes, so each test removes the ones it made.
async function clearDefs(request: APIRequestContext) {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as { defs: Def[] };
  for (const def of snapshot.defs) {
    if (!def.system) await request.delete(`/api/defs/${encodeURIComponent(def.id)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
  await clearDefs(request);
});
test.afterEach(async ({ request }) => clearDefs(request));

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const list = (page: Page) => page.getByRole('complementary', { name: 'Everyone on the floor' });
/** A line in the list, by the exact name on it. */
const entry = (page: Page, name: string) =>
  list(page)
    .getByRole('button')
    .filter({ has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }) });

test('the list beside the floor opens an agent as clicking it on the floor does', async ({
  page,
}) => {
  await loadDemo(page);
  const floorList = list(page);
  await expect(floorList).toBeVisible();
  // It sits beside the floor, which shrinks to make room, so nothing on the floor is covered.
  const stage = (await page.locator('.stage').boundingBox())!;
  const box = (await floorList.boundingBox())!;
  expect(stage.x + stage.width).toBeLessThanOrEqual(box.x + 1);

  // Atlas is waiting on an approval, so it is listed first, under Needs you.
  const needs = floorList.getByRole('group', { name: /Needs you/ });
  await expect(needs.getByRole('button', { name: /^Atlas Needs approval/ })).toBeVisible();
  await expect(floorList.getByRole('group', { name: /Working/ })).toBeVisible();

  const ledger = entry(page, 'Ledger');
  await expect(ledger).toHaveAttribute('aria-pressed', 'false');
  await ledger.click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(ledger).toHaveAttribute('aria-pressed', 'true');
  // The floor shows the same agent selected.
  await expect(page.locator('[data-o] .tag.sel')).toContainText('Ledger');

  // An agent waiting on an approval opens it for review, as on the floor.
  await entry(page, 'Atlas').click();
  await expect(panel.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Allow once' })).toBeVisible();
});

test('the list works from the keyboard', async ({ page }) => {
  await loadDemo(page);
  const rows = list(page).locator('.flrow');
  // The list is one stop for Tab, and the arrow keys move along it.
  await expect(list(page).locator('.flrow[tabindex="0"]')).toHaveCount(1);
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rows.first()).toBeFocused();

  const scout = entry(page, 'Scout');
  await scout.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
  await expect(scout).toHaveAttribute('aria-pressed', 'true');
});

test('the list says it is one Tab stop with arrow keys, to a screen reader', async ({ page }) => {
  await loadDemo(page);
  // A toolbar is the pattern for one stop with arrows inside, and a hint says so in words. Both
  // are in what a screen reader is given, which the aria snapshot shows.
  await expect(list(page)).toMatchAriaSnapshot(`
    - complementary "Everyone on the floor":
      - text: /Tab stops on one agent. The up and down arrow keys move between agents, and Home and End go to the first and last./
      - toolbar "Pick an agent":
        - group /Needs you/:
          - button /^Atlas Needs approval/
  `);
  const toolbar = list(page).getByRole('toolbar', { name: 'Pick an agent' });
  await expect(toolbar).toHaveAttribute('aria-orientation', 'vertical');
  await expect(toolbar).toHaveAccessibleDescription(/arrow keys move between agents/);
});

test('the Project filter narrows the list as it narrows the floor', async ({ page }) => {
  await loadDemo(page);
  await expect(entry(page, 'Scout')).toBeVisible();
  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Checkout revamp/ }).click();
  await expect(entry(page, 'Ledger')).toBeVisible();
  await expect(entry(page, 'Scout')).toHaveCount(0);
});

test('a resting agent file in the list opens its panel, as an agent does', async ({
  page,
  request,
}) => {
  await request.post('/api/defs', {
    data: {
      def: {
        name: 'list-reader',
        description: 'Use to read the docs.',
        scope: 'account',
        model: 'inherit',
        tools: ['Read'],
        instructions: 'Read the docs.',
        color: '#7FA8FF',
      },
      previousId: '',
    },
  });
  await loadDemo(page);
  const lounge = list(page).getByRole('group', { name: /Lounge/ });
  const file = lounge.getByRole('button', { name: /^list-reader Agent file/ });
  await expect(file).toContainText('Agent file');
  await file.click();
  await expect(page).toHaveURL(/#office$/);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel).toContainText('list-reader');
  await expect(panel).toContainText('Use to read the docs.');
  await expect(panel).toContainText('Resting');
  await expect(file).toHaveAttribute('aria-pressed', 'true');
  // Giving it a task sits it down at a desk, and its panel becomes the working agent's.
  await panel.getByLabel('What should it do?').fill('Read the setup guide');
  await panel.getByRole('button', { name: 'Start at a desk' }).click();
  await expect(panel.locator('.chip', { hasText: 'Resting' })).toHaveCount(0);
  await expect(panel).toContainText('Read the setup guide');
  // Once it works, it no longer rests in the lounge.
  await page.keyboard.press('Escape');
  const again = list(page).getByRole('group', { name: /Lounge/ });
  await expect(again.getByRole('button', { name: /^list-reader/ })).toHaveCount(0);
});

test('the list can be hidden, and stays out of the way in full screen', async ({ page }) => {
  await loadDemo(page);
  const toggle = page.getByRole('button', { name: 'List of everyone on the floor' });
  const stageWidth = async () => (await page.locator('.stage').boundingBox())!.width;
  await expect(list(page)).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const narrow = await stageWidth();
  await toggle.click();
  await expect(list(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // The floor takes the room back.
  await expect.poll(stageWidth).toBeGreaterThan(narrow);
  await toggle.click();
  await expect(list(page)).toBeVisible();

  await page.keyboard.press('f');
  await expect(page.locator('body')).toHaveClass(/ofs/);
  await expect(list(page)).toBeHidden();
  await toggle.click();
  await expect(list(page)).toBeVisible();
});

test('a narrow window starts with the list hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await loadDemo(page);
  const toggle = page.getByRole('button', { name: 'List of everyone on the floor' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(list(page)).toBeHidden();
  await toggle.click();
  await expect(list(page)).toBeVisible();
});
