// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';
import { crowd, hub, hubToken, overlapping, tagBoxes } from './support/hubOffice.ts';
import { wipe } from './support/page.ts';

// Mabari on a phone, 390 by 844: the office with 22 agents, Home's catch-up card and an open chat
// thread. Each took more of the screen than it should and left the rest too small to use.

test.beforeEach(async ({ page, request }) => {
  await wipe(request);
  await page.setViewportSize({ width: 390, height: 844 });
});

const noSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('the office', () => {
  test('with 22 agents the header is a few short rows and the floor is big enough to read', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const token = await hubToken(request);
    await crowd(request, token, 22);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(22);
    await page.waitForTimeout(1000);

    // The header was 273 px of the screen, and the floor 523.
    const header = (await page.locator('.ohead').boundingBox())!;
    const stage = (await page.locator('#stage').boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(90);
    expect(stage.height).toBeGreaterThanOrEqual(680);
    expect(header.height + stage.height).toBeGreaterThan(740);
    // The floor is drawn at a scale where an agent is a face you can see: 0.5 or more, and it was
    // 0.27 with the whole of the office squeezed in.
    const scale = Number(await page.locator('#floor').getAttribute('data-scale'));
    expect(scale).toBeGreaterThanOrEqual(0.5);
    // Names are readable: the tags are the size of text, not of a speck.
    const names = await page.locator('[data-o]:not([hidden]) .nt').first().boundingBox();
    expect(names!.height).toBeGreaterThanOrEqual(18);
    expect(overlapping(await tagBoxes(page))).toEqual([]);
    expect(await noSideways(page)).toBe(true);
  });

  test('the filters are one button away, and say how many are narrowing the floor', async ({
    page,
    request,
  }) => {
    const token = await hubToken(request);
    await crowd(request, token, 8);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(8);
    const toggle = page.getByRole('button', { name: /^Filters/ });
    const project = page.getByRole('button', { name: /^Project/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(project).toBeHidden();
    const closed = (await page.locator('.ohead').boundingBox())!.height;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(project).toBeVisible();
    await expect(page.getByRole('group', { name: 'Agent status' })).toBeVisible();
    expect((await page.locator('.ohead').boundingBox())!.height).toBeGreaterThan(closed + 40);

    // A filter in place shows on the button, which is red for nothing.
    await page.getByRole('button', { name: 'Working' }).click();
    await toggle.click();
    await expect(toggle).toContainText('1');
    await expect(toggle.locator('.badge')).toHaveClass(/calm/);
  });

  test('every button in the row can be reached by scrolling it, and New agent opens', async ({
    page,
    request,
  }) => {
    const token = await hubToken(request);
    await crowd(request, token, 4);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(4);
    for (const name of ['Auto approve', 'Pause everyone', 'New project', 'New agent']) {
      const button = page.locator('.ohact').getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const reachable = await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return box.x >= 0 && box.right <= window.innerWidth && element.contains(hit);
      });
      expect(reachable, name).toBe(true);
    }
    await page.locator('.ohact').getByRole('button', { name: 'New agent', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
    expect(await noSideways(page)).toBe(true);
  });

  test('dragging along the floor reaches the desks off to the right', async ({ page, request }) => {
    test.setTimeout(60_000);
    const token = await hubToken(request);
    await crowd(request, token, 22);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(22);
    await page.waitForTimeout(800);
    const inView = () => tagBoxes(page).then((boxes) => new Set(boxes.map((box) => box.name)));
    const before = await inView();
    // Fewer than all of the agents show at first: the rest are along the floor.
    expect(before.size).toBeLessThan(22);
    const stage = (await page.locator('#floor').boundingBox())!;
    await page.mouse.move(stage.x + 280, stage.y + 300);
    await page.mouse.down();
    await page.mouse.move(stage.x + 40, stage.y + 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await inView();
    // Others have come into view, and the scroll bar under the floor shows it moved.
    expect([...after].some((name) => !before.has(name))).toBe(true);
    await expect(page.locator('.oscroll')).toBeVisible();
    expect(await noSideways(page)).toBe(true);
  });
});

/** Pretends the person was last here `minutes` ago, from a page that isn't Mabari's. */
async function awayFor(page: Page, minutes: number, route = '#home') {
  await page.goto('/api/health');
  await page.evaluate((ago) => {
    window.localStorage.removeItem('mabari.absence');
    window.localStorage.setItem('mabari.lastActive', String(Date.now() - ago * 60_000));
  }, minutes);
  await page.goto(`/${route}`);
}

test.describe('While you were away', () => {
  test('is not cut off or against Mabari, opens out, and leaves the buttons on screen', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const token = await hubToken(request);
    for (let index = 0; index < 9; index++) {
      await hub(request, token, {
        agent: `away-${index}`,
        name: `Worker ${index + 1}`,
        state: 'editing',
        task: 'Work',
      });
      await hub(request, token, {
        agent: `away-${index}`,
        state: 'done',
        task: `Finished task number ${index + 1} with a long description that has to wrap`,
      });
    }
    await awayFor(page, 200);
    const card = page.getByTestId('away-card');
    await expect(card).toBeVisible();
    const rows = card.locator('[data-group="finished"] li:not(.muted)');

    // Folded, it is a line of counts: no row is cut off part way down, because there are none.
    await expect(card.getByTestId('recapsum')).toContainText('Tasks finished 9');
    await expect(rows).toHaveCount(0);
    const fits = await card.evaluate((element) => element.scrollHeight <= element.clientHeight + 1);
    expect(fits, 'the card has nothing to scroll to').toBe(true);
    // The card is inside the screen and well clear of Mabari's bubble.
    const cardBox = (await card.boundingBox())!;
    const bubble = (await page.locator('#veeSay').boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390);
    expect(bubble.y - (cardBox.y + cardBox.height)).toBeGreaterThanOrEqual(24);
    // The buttons under Mabari are on the screen without scrolling.
    const hold = (await page.getByRole('button', { name: /Hold to talk/ }).boundingBox())!;
    expect(hold.y + hold.height).toBeLessThanOrEqual(844);

    // Opened out, it shows every row, wrapped rather than clipped to one line, and shuts again.
    await card.getByRole('button', { name: 'Show details' }).click();
    // The server lists the first five of a kind and counts the rest, as it does on a wide screen.
    await expect(rows).toHaveCount(5);
    await expect(card.locator('[data-group="finished"] li.muted')).toHaveText('and 4 more');
    const wrapped = await card
      .locator('.recaptext')
      .first()
      .evaluate((element) => getComputedStyle(element).whiteSpace);
    expect(wrapped).toBe('normal');
    await expect(card.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await card.getByRole('button', { name: 'Hide details' }).click();
    await expect(rows).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });

  test('is not changed on a wide screen, where it has the room', async ({ page, request }) => {
    const token = await hubToken(request);
    for (let index = 0; index < 5; index++) {
      await hub(request, token, { agent: `w${index}`, name: `Wide ${index}`, state: 'editing' });
      await hub(request, token, { agent: `w${index}`, state: 'done', task: `Did thing ${index}` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await awayFor(page, 200);
    const card = page.getByTestId('away-card');
    await expect(card).toBeVisible();
    // All five, with no button to open the rest.
    await expect(card.locator('[data-group="finished"] li:not(.muted)')).toHaveCount(5);
    await expect(card.getByRole('button', { name: 'Show details' })).toBeHidden();
  });
});

test.describe('a chat thread', () => {
  test('owns the screen on a phone: the title and tabs step aside and the thread is tall', async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    const office = (await (await request.get('/api/snapshot')).json()) as {
      agents: { id: string; name: string }[];
    };
    const ledger = office.agents.find((agent) => agent.name === 'Ledger')!;
    await page.goto(`/#conversations?agent=${ledger.id}`);
    const thread = page.locator('.mscroll');
    await expect(thread).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Conversations' })).toBeHidden();
    await expect(page.getByRole('group', { name: 'Conversation views' })).toBeHidden();
    // The thread had about 270 px beside the composer.
    await expect
      .poll(async () => (await thread.boundingBox())!.height, { timeout: 5000 })
      .toBeGreaterThanOrEqual(380);
    // The message box is on the screen with it, and Send can be reached.
    const send = page.getByRole('button', { name: /^(Send|Queue)/ }).first();
    const box = (await send.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(await noSideways(page)).toBe(true);

    // The way back to the list is in the thread, and brings the title and tabs back.
    await page.getByRole('link', { name: 'All chats' }).click();
    await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Conversation views' })).toBeVisible();
  });
});
