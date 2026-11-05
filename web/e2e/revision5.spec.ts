// SPDX-License-Identifier: Apache-2.0
// The office header, wall bar, approval bell, noise filters, Home proportions and the Library.
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function office(page: Page) {
  await page.request.post('/api/demo/load');
  await page.goto('/#office');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [width, rows] of [
  [1440, 'one'],
  [1100, 'two'],
] as const) {
  test(`the Agents header is ${rows} row${rows === 'one' ? '' : 's'} at ${width} px and nothing overlaps`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await office(page);
    const head = page.locator('.ohead');
    if (rows === 'one') await expect(head).not.toHaveClass(/stack/);
    else await expect(head).toHaveClass(/stack/);
    const parts = await head
      .locator('.ohtitle, .obar2.inhead > *, .ohact > *')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).offsetWidth)
          .map((node) => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          }),
      );
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        expect(overlaps(parts[i]!, parts[j]!), `parts ${i} and ${j} overlap`).toBe(false);
      }
    }
  });
}

test('the wall bar stays put while the floor zooms and pans', async ({ page }) => {
  await office(page);
  const bar = page.locator('#wallBar');
  const before = (await bar.boundingBox())!;
  expect(before.height).toBe(58);
  await expect(bar.getByRole('group', { name: 'What to show on agents' })).toBeVisible();
  await expect(bar.locator('.pwin')).toHaveCount(4);
  await expect(bar.locator('#wClock')).toHaveAttribute('title', /\d/);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await bar.boundingBox()).toEqual(before);
  // A project panel shows only that project; clicking it again shows every project.
  const docs = bar.locator('.pwin', { hasText: 'Docs site' });
  await docs.click();
  await expect(docs).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dd').first()).toContainText('Docs site');
  await docs.click();
  await expect(page.locator('.dd').first()).toContainText('All projects');
});

test('the approval bell pops up, minimises, and opens again for a new approval', async ({
  page,
  request,
}) => {
  await office(page);
  const board = page.locator('#board');
  const stage = (await page.locator('.stage').boundingBox())!;
  await expect(board).toContainText('Needs approval');
  const card = (await board.boundingBox())!;
  expect(stage.x + stage.width - (card.x + card.width)).toBeCloseTo(14, 0);
  expect(card.width).toBeLessThanOrEqual(280);
  // The request wraps instead of being cut off.
  await expect(board.locator('.bitem span')).toContainText('npm run db:migrate ‑‑ ‑‑env=staging');
  await board.getByRole('button', { name: 'Minimise' }).click();
  const bell = page.getByRole('button', { name: '1 approval waiting' });
  await expect(bell).toBeVisible();
  await expect(bell.locator('.bcount')).toHaveText('1');
  await bell.click();
  await expect(board).toContainText('Needs approval');
  await board.getByRole('button', { name: 'Minimise' }).click();
  // Settling it leaves the grey bell.
  await request.post('/api/auto-approve', { data: { on: true, scope: 'all', acknowledged: true } });
  await expect(page.getByRole('button', { name: 'Nothing needs approval' })).toBeVisible();
  await request.post('/api/auto-approve', {
    data: { on: false, scope: 'all', acknowledged: false },
  });
});

test('noise filters hide layers, quiet mode hides them all, and the browser remembers', async ({
  page,
}) => {
  await office(page);
  const tags = page.locator('.ovl > div').first();
  const bubbles = page.getByRole('button', { name: 'Speech bubbles' });
  await bubbles.click();
  await expect(bubbles).toHaveAttribute('aria-pressed', 'false');
  await expect(tags).toHaveClass(/hide-bub/);
  // Approval bubbles stay, so what needs you is never hidden.
  await expect(page.locator('.bub.red').first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Speech bubbles' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const quiet = page.getByRole('button', { name: 'Quiet mode' });
  await quiet.click();
  await expect(quiet).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ovl > div').first()).toHaveClass(
    'hide-bub hide-meta hide-msg hide-tags',
  );
  await expect(page.locator('.tag.attn').first()).toBeVisible();
  await quiet.click();
  await expect(page.locator('.ovl > div').first()).toHaveClass('');
});

test('Home says good morning, afternoon or evening, with Mabari centred above the chat box', async ({
  page,
}) => {
  await page.request.post('/api/demo/load');
  await page.goto('/#home');
  await expect(page.locator('#homeGreet')).toHaveText(/^Good (morning|afternoon|evening)$/);
  const stage = (await page.locator('.h2stage').boundingBox())!;
  const box = (await page.locator('#hcForm').boundingBox())!;
  const view = page.viewportSize()!;
  expect(stage.height).toBeLessThanOrEqual(Math.min(view.height * 0.54, 480) + 1);
  expect(box.y - (stage.y + stage.height)).toBeGreaterThanOrEqual(28);
  // The chat box no longer hugs the bottom edge.
  expect(view.height - (box.y + box.height)).toBeGreaterThan(60);
});

test('the Library has Status screens first, and Components as identical tiles', async ({
  page,
}) => {
  await page.goto('/#states');
  await expect(page).toHaveURL(/#components$/);
  await expect(page.locator('h1')).toHaveText('Library');
  const status = page.getByRole('tab', { name: 'Status screens' });
  await expect(status).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#statesPane .statecard')).toHaveCount(6);
  await page.getByRole('tab', { name: 'Components' }).click();
  await expect(page.getByRole('tab', { name: 'Components' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const tiles = page.locator('#compPage .libtile:not(.notescard)');
  await expect(tiles).toHaveCount(17);
  const heights = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );
  expect(new Set(heights).size).toBe(1);
  await expect(tiles.first()).toContainText('Buttons');
  await expect(tiles.first()).toContainText('Continue');
  // One Library item in the menu, and no separate Status item.
  const rail = page.getByRole('complementary', { name: 'Main' });
  await expect(rail.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('link', { name: /^Status/ })).toHaveCount(0);
});

test('Chats uses the two speech bubbles icon', async ({ page }) => {
  await page.goto('/#home');
  const paths = await page
    .getByRole('link', { name: /Chats/ })
    .locator('svg path')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
  expect(paths).toEqual([
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z',
    'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  ]);
});
