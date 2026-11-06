// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  complete,
  crowd,
  hub,
  hubToken,
  overlapping,
  patternOf,
  pixelsOf,
  shippable,
  tagBoxes,
} from './support/hubOffice.ts';
import { fromPage, wipe } from './support/page.ts';

// The ship it party, the trophy display, the tags and the camera in the meeting room, the welcome
// office and the picture of the office: what makes the floor worth opening. Each test wipes the
// office first, so they don't depend on one another.

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

const floorOf = (page: Page) => page.locator('#floor');
/**
 * The lightest shade of the project's colour, #FFD3E1 for "Shop launch" in #FF6B9A: it is in the
 * confetti and nowhere else on the floor, which the project's own colour is not (a trophy and an
 * agent's tie have it), so it counts the confetti and only the confetti.
 */
const CONFETTI: [number, number, number] = [255, 211, 225];

/** Denies whatever waits on a person, and whatever the demo asks for meanwhile, until nothing does. */
async function settleApprovals(request: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const waiting = (await (await request.get('/api/approvals?pending=1')).json()) as {
          id: string;
        }[];
        for (const approval of waiting) {
          await request.post(`/api/approvals/${approval.id}/decision`, {
            data: { decision: 'denied' },
            headers: fromPage,
          });
        }
        return waiting.length;
      },
      { timeout: 15_000 },
    )
    .toBe(0);
}

test.describe('name tags', () => {
  test('never overlap, not even when a team crowds into the meeting room and walks there', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Shop launch', '#FF6B9A', 4);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(4);
    await complete(request, project.id);
    const floor = floorOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'gather');
    // From the first step to the last cheer, over and over, no two tags cover each other.
    let looks = 0;
    let sawParty = false;
    for (let phase = await floor.getAttribute('data-shipped'); phase;) {
      if (phase === 'party') sawParty = true;
      expect(overlapping(await tagBoxes(page)), `look ${looks}, ${phase}`).toEqual([]);
      looks++;
      await page.waitForTimeout(200);
      phase = await floor.getAttribute('data-shipped');
    }
    expect(sawParty).toBe(true);
    expect(looks).toBeGreaterThan(30);
  });

  test('never overlap in a crowded office, zoomed out and in, or on a phone', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const token = await hubToken(request);
    await crowd(request, token, 22);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(22);
    await page.waitForTimeout(1500);
    expect(overlapping(await tagBoxes(page))).toEqual([]);
    // Zoomed out, where tags shrink less than the floor does.
    for (const zoom of ['Zoom out', 'Zoom out', 'Zoom in', 'Zoom in', 'Zoom in']) {
      await page.getByRole('button', { name: zoom }).click();
      await page.waitForTimeout(700);
      expect(overlapping(await tagBoxes(page)), zoom).toEqual([]);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    expect(overlapping(await tagBoxes(page))).toEqual([]);
  });

  test('never overlap in the demo office, with the agents it has talking and checking in', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('.tag .nt')).toHaveCount(10);
    for (let look = 0; look < 12; look++) {
      await page.waitForTimeout(700);
      expect(overlapping(await tagBoxes(page)), `look ${look}`).toEqual([]);
    }
  });
});

test.describe('the party', () => {
  test('is big and lasts seconds, frames the meeting room, and ends cleanly', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Shop launch', '#FF6B9A', 3);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    await page.waitForTimeout(1500);
    const floor = floorOf(page);
    const zoomText = () => page.locator('#zoomPct').textContent();
    expect(await zoomText()).toBe('100%');
    const calm = await pixelsOf(page, CONFETTI);

    await complete(request, project.id);
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    const began = Date.now();

    // The camera has pushed in: the room is whole on the screen, clear of the bars over the floor.
    await page.waitForTimeout(1500);
    expect(Number.parseInt((await zoomText()) ?? '0', 10)).toBeGreaterThanOrEqual(150);
    const room = ((await floor.getAttribute('data-room')) ?? '').split(',').map(Number);
    expect(room).toHaveLength(4);
    const size = (await floor.boundingBox())!;
    const [left, top, right, bottom] = room as [number, number, number, number];
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(size.width + 1);
    // Under the wall bar and the banner, and over the toolbar and the readout.
    expect(top).toBeGreaterThanOrEqual(120);
    expect(bottom).toBeLessThanOrEqual(size.height - 60);

    // A lot of confetti, in the project's colour, at the height of it.
    const during = await pixelsOf(page, CONFETTI);
    expect(during, 'confetti pixels in the air').toBeGreaterThan(calm + 150);
    await expect(page.locator('.shipped')).toContainText('Shipped');
    await expect(page.locator('.shipped')).toContainText('Shop launch');
    await expect(page.locator('.shipped small')).toContainText('3 agents');

    // The party lasts several seconds, and is over by itself.
    await expect(floor).not.toHaveAttribute('data-shipped', /party/, { timeout: 15_000 });
    const lasted = Date.now() - began;
    expect(lasted).toBeGreaterThan(5000);
    expect(lasted).toBeLessThan(9500);
    await expect(page.locator('.shipped')).toHaveCount(0);
    // Nothing of it is left on the floor, and the view is back where it was.
    await expect.poll(() => zoomText(), { timeout: 5000 }).toBe('100%');
    await expect(floor).toHaveAttribute('data-room', '');
    await page.waitForTimeout(1500);
    expect(await pixelsOf(page, CONFETTI)).toBeLessThan(calm + 10);
  });

  test('leaves the view alone if someone moved it during the party', async ({ page, request }) => {
    test.setTimeout(90_000);
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Shop launch', '#FF6B9A', 2);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(2);
    await complete(request, project.id);
    const floor = floorOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    await page.waitForTimeout(1200);
    // Zoomed out by hand, the person's choice stands after the party.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    // The view eases to the zoom chosen: the figure is read once it has stopped changing.
    let chosen = '';
    await expect
      .poll(async () => {
        const now = (await page.locator('#zoomPct').textContent()) ?? '';
        const same = now === chosen;
        chosen = now;
        return same;
      })
      .toBe(true);
    expect(chosen).not.toBe('100%');
    await expect(floor).not.toHaveAttribute('data-shipped', /party/, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(await page.locator('#zoomPct').textContent()).toBe(chosen);
  });

  test('plays on, with motion, as a moving picture, and with reduced motion as a still', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const token = await hubToken(request);
    const first = await shippable(request, token, 'Shop launch', '#FF6B9A', 3);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    await complete(request, first.id);
    const floor = floorOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    await page.waitForTimeout(1600);
    // With motion, the confetti is somewhere else a moment later: the control for the still.
    const moving = await patternOf(page, CONFETTI);
    await page.waitForTimeout(500);
    expect(await patternOf(page, CONFETTI)).not.toBe(moving);
    await expect(floor).not.toHaveAttribute('data-shipped', /party/, { timeout: 15_000 });

    // The same party with reduced motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    const second = await shippable(request, token, 'Shop launch again', '#FF6B9A', 1);
    await complete(request, second.id);
    // No walk: it goes straight to the party, and nobody gathers.
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 10_000 });
    await expect(floor).not.toHaveAttribute('data-team', /\d/);
    await page.waitForTimeout(1200);
    const still = await patternOf(page, CONFETTI);
    expect(await pixelsOf(page, CONFETTI), 'confetti pixels in the still').toBeGreaterThan(8);
    await page.waitForTimeout(700);
    expect(await patternOf(page, CONFETTI)).toBe(still);
    // The view doesn't move either: no camera in a still.
    expect(await page.locator('#zoomPct').textContent()).toBe('100%');
    await expect(page.locator('.shipped')).toHaveCount(0, { timeout: 12_000 });
    await page.waitForTimeout(500);
    expect(await pixelsOf(page, CONFETTI)).toBe(0);
  });

  test('stops at once when an approval arrives, leaves nothing behind, and never covers it', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await request.post('/api/demo/load');
    await settleApprovals(request);
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Shop launch', '#FF6B9A', 2);
    await page.goto('/#office');
    await expect(page.locator('.tag .nt').first()).toBeVisible();
    await page.waitForTimeout(1500);
    const calm = await pixelsOf(page, CONFETTI);
    await complete(request, project.id);
    const floor = floorOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 40_000 });
    const began = Date.now();

    // A project's plan is waiting for you: an approval, in the middle of the party. It shows
    // about four and a half seconds after the project starts, with the party's seven still to run.
    const planned = await request.post('/api/planner', {
      data: {
        said: ['Build a landing page for our coffee shop'],
        previous: null,
        instructions: '',
        files: [],
        repo: null,
      },
    });
    const { plan } = (await planned.json()) as { plan: unknown };
    const started = await request.post('/api/projects/start', {
      data: {
        plan,
        name: 'Bean counter',
        instructions: '',
        files: [],
        folder: '',
        branch: '',
        mode: 'plan',
        brief: 'Build a landing page for our coffee shop',
      },
    });
    expect(started.ok()).toBe(true);
    await page.waitForTimeout(1200);
    expect(await pixelsOf(page, CONFETTI)).toBeGreaterThan(calm + 150);

    // The party is over at once: no banner, no confetti, nobody still cheering.
    await expect(floor).toHaveAttribute('data-shipped', '', { timeout: 6000 });
    // Well before it would have ended by itself, which is seven seconds in.
    expect(Date.now() - began).toBeLessThan(6500);
    await expect(page.locator('.shipped')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await pixelsOf(page, CONFETTI)).toBeLessThan(calm + 10);
    // The approval is on top, where it can be read and clicked.
    const card = page.locator('#board:not(.is-mini)');
    await expect(card.locator('.bitem').first()).toBeVisible({ timeout: 10_000 });
    const hit = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return element.contains(top);
    });
    expect(hit).toBe(true);
  });
});

test.describe('the trophy display', () => {
  test('grows as projects ship, and past its room says how many more with a +N', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const token = await hubToken(request);
    await hub(request, token, { agent: 'solo', name: 'Solo', state: 'editing', task: 'Work' });
    const total = 24;
    for (let index = 0; index < total; index++) {
      const project = (await (
        await request.post('/api/projects', {
          data: {
            name: `Project ${index + 1}`,
            color: ['#FF6B9A', '#48DBFB', '#FECA57'][index % 3],
          },
        })
      ).json()) as { id: string };
      await request.patch('/api/agents/hub-solo', { data: { projectId: project.id } });
      await hub(request, token, { agent: 'solo', state: 'done', task: `Finished ${index}` });
      await complete(request, project.id);
      await hub(request, token, { agent: 'solo', state: 'editing', task: 'Next' });
    }
    await page.goto('/#office');
    const trophies = page.locator('.trophy');
    await expect(trophies.first()).toBeVisible();
    const shown = await trophies.count();
    expect(shown).toBeGreaterThanOrEqual(10);
    expect(shown).toBeLessThan(total);

    // The tile says how many are not shown, and is a link to where they all are.
    const more = page.locator('.trophymore');
    await expect(more).toHaveText(`+${total - shown}`);
    await expect(more).toHaveAttribute('href', '#projects');
    await expect(
      page.getByRole('link', { name: `${total - shown} more shipped projects` }),
    ).toBeVisible();

    // Every trophy and the tile are big enough to see and to click, none covers another, and all
    // are on the floor.
    const stage = (await page.locator('#stage').boundingBox())!;
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('.trophy, .trophymore')].map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      }),
    );
    expect(boxes).toHaveLength(shown + 1);
    for (const box of boxes) {
      expect(box.right - box.left).toBeGreaterThanOrEqual(24);
      expect(box.bottom - box.top).toBeGreaterThanOrEqual(28);
      expect(box.left).toBeGreaterThanOrEqual(stage.x);
      expect(box.right).toBeLessThanOrEqual(stage.x + stage.width);
    }
    expect(overlapping(boxes.map((box, index) => ({ name: String(index), ...box })))).toEqual([]);

    // The newest are the ones shown: the last project is there and the first is not.
    await expect(page.getByRole('button', { name: /^Project 24, shipped/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Project 1, shipped/ })).toHaveCount(0);

    // The tile goes to the Projects page.
    await more.click();
    await expect(page).toHaveURL(/#projects/);
  });

  test('is twice the size it was, and fills from the left as the first projects ship', async ({
    page,
    request,
  }) => {
    const token = await hubToken(request);
    for (const [index, name] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
      const project = await shippable(request, token, `${name} app`, '#48DBFB', 1);
      await complete(request, project.id);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    await page.goto('/#office');
    const trophies = page.locator('.trophy');
    await expect(trophies).toHaveCount(3);
    const boxes = await trophies.evaluateAll((all) =>
      all.map((element) => element.getBoundingClientRect().toJSON() as DOMRect),
    );
    // About 28 by 32 world pixels at the floor's scale: well over the 14 by 16 it was.
    expect(boxes[0]!.height).toBeGreaterThanOrEqual(28);
    expect(boxes[0]!.width).toBeGreaterThanOrEqual(24);
    expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
    expect(boxes[2]!.left).toBeGreaterThan(boxes[1]!.left);
    // No +N while everything fits.
    await expect(page.locator('.trophymore')).toHaveCount(0);
  });

  test('the party can be played again from a trophy, in the demo, and not over an approval', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('.tag .nt')).toHaveCount(10);
    await page.getByRole('button', { name: /Landing page, shipped/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Landing page' });
    const play = dialog.getByRole('button', { name: 'Play the party' });
    // The demo opens with an approval waiting, so the party can't play over it, and says why.
    await expect(play).toBeDisabled();
    await expect(dialog).toContainText('An approval is waiting for you');
    await expect(play).toHaveAccessibleDescription(/approval is waiting/);

    await settleApprovals(request);
    await expect(play).toBeEnabled();
    await play.click();
    await expect(dialog).toHaveCount(0);
    const floor = floorOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'gather');
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    await expect(page.locator('.shipped')).toContainText('Landing page');
    await expect(page.locator('.shipped small')).toContainText('3 agents · 46 min · $2.15');
    await expect(page.locator('.shipped')).toHaveCount(0, { timeout: 15_000 });

    // A reload plays nothing: it only plays when asked.
    await page.reload();
    await expect(page.locator('.tag .nt')).toHaveCount(10);
    for (let waited = 0; waited < 3000; waited += 250) {
      expect((await floor.getAttribute('data-shipped')) ?? '').toBe('');
      await page.waitForTimeout(250);
    }
  });
});

test.describe('a picture of the office', () => {
  test('is saved from the page as a PNG with a strip of counts, and sends nothing', async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    const sent: string[] = [];
    page.on('request', (one) => {
      if (one.method() !== 'GET') sent.push(one.url());
    });
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(10);
    await page.waitForTimeout(800);
    const canvas = (await floorOf(page).boundingBox())!;
    const posted = sent.length;
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save a picture of the office' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^mabari-office-\d{4}-\d{2}-\d{2}\.png$/);
    const path = await download.path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.length).toBeGreaterThan(4000);
    // The image is the floor, and a strip of 44 pixels under it.
    expect(bytes.readUInt32BE(16)).toBe(Math.round(canvas.width));
    expect(bytes.readUInt32BE(20)).toBe(Math.round(canvas.height) + 44);
    await expect(page.locator('.toast')).toContainText('mabari-office-');
    // Nothing was sent anywhere: the page made no request that writes.
    expect(sent.length).toBe(posted);
  });
});

test.describe('the welcome office', () => {
  /** A number that changes when anything on the welcome picture does. */
  const hero = (page: Page) =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#heroCanvas')!;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let hash = 0;
      for (let at = 0; at < data.length; at += 4) {
        hash = (hash * 31 + data[at]! + data[at + 1]! * 3 + data[at + 2]! * 7) >>> 0;
      }
      return hash;
    });

  test('is alive: its agents move and, now and then, there is a party', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#heroCanvas')).toBeVisible();
    const first = await hero(page);
    await page.waitForTimeout(500);
    const second = await hero(page);
    expect(second).not.toBe(first);
    // Confetti, in the colours of the projects, once the first party is on: more of both than
    // there was before it, and none of it left once it is over.
    const colours = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#heroCanvas')!;
        const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        let count = 0;
        for (let at = 0; at < data.length; at += 4) {
          const pink = data[at] === 255 && data[at + 1] === 107 && data[at + 2] === 154;
          const cyan = data[at] === 72 && data[at + 1] === 219 && data[at + 2] === 251;
          if (pink || cyan) count++;
        }
        return count;
      });
    const before = await colours();
    await page.waitForTimeout(2600);
    expect(await colours()).toBeGreaterThan(before + 100);
    await page.waitForTimeout(6500);
    expect(await colours()).toBeLessThan(before + 20);
    // The words and buttons on the screen are as they were.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'See your AI agents at work, in a little office.',
    );
    await expect(page.getByRole('button', { name: 'Explore a demo office' })).toBeVisible();
  });

  test('is the same still picture with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('#heroCanvas')).toBeVisible();
    const first = await hero(page);
    await page.waitForTimeout(3200);
    expect(await hero(page)).toBe(first);
  });
});
