// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fromPage, wipe } from './support/page.ts';

// Package 7, "A place worth opening": shipping a project, the trophy shelf, the small moments, the
// agent card, the sound of the office, loading skeletons, the cast in empty states and the motion
// language. Each test wipes the office first, so they don't depend on one another.

const API = `http://127.0.0.1:${process.env.MABARI_API_PORT ?? '4327'}`;

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

async function hubToken(request: APIRequestContext): Promise<string> {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  return token;
}

/** Reports one event as a custom app would. Vite proxies only /api and /ws, so the hub is called directly. */
async function hub(request: APIRequestContext, token: string, body: object) {
  const reply = await request.post(`${API}/hub/v1/events`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(reply.status(), await reply.text()).toBe(200);
}

/**
 * A project whose agents have all finished, so it can be marked complete: the project, and three
 * agents named "<first word> 1" to "3".
 */
async function shippable(
  request: APIRequestContext,
  token: string,
  name: string,
  color = '#FF6B9A',
  agents = 3,
) {
  const project = (await (
    await request.post('/api/projects', { data: { name, color } })
  ).json()) as {
    id: string;
  };
  const slug = name.toLowerCase().replace(/\W+/g, '-');
  for (let index = 0; index < agents; index++) {
    const agent = `${slug}-${index}`;
    await hub(request, token, {
      agent,
      name: `${name.split(' ')[0]} ${index + 1}`,
      state: 'editing',
      task: 'Work',
    });
    const patched = await request.patch(`/api/agents/hub-${agent}`, {
      data: { projectId: project.id },
    });
    expect(patched.ok()).toBe(true);
    await hub(request, token, { agent, state: 'done', task: 'Finished the work' });
  }
  return project;
}

const complete = async (request: APIRequestContext, id: string) => {
  const reply = await request.post(`/api/projects/${id}/complete`);
  expect(reply.status(), await reply.text()).toBe(200);
};

const phaseOf = (page: Page) => page.locator('#floor');

/**
 * Checks that no party starts for `ms`. Looking once at the end proves nothing, and an assertion
 * that something is not there waits for it to go, so this looks again and again.
 */
async function nothingPlaysFor(page: Page, ms: number) {
  for (let waited = 0; waited < ms; waited += 150) {
    expect((await phaseOf(page).getAttribute('data-shipped')) ?? '').not.toMatch(/gather|party/);
    expect(await page.locator('.shipped').count()).toBe(0);
    await page.waitForTimeout(150);
  }
}

/**
 * Whether two boxes are in the same place. The view of the floor eases the last fraction of a
 * pixel into place, so a tag that isn't walking can still drift by a tenth of one.
 */
const sameSpot = (
  a: { x: number; y: number } | null | undefined,
  b: { x: number; y: number } | null | undefined,
) => !!a && !!b && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

/** Waits until a name tag has stopped moving, and returns where it is. */
async function settled(locator: Locator) {
  let last = '';
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        const now = JSON.stringify(box);
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [250], timeout: 25_000 },
    )
    .toBe(true);
  return (await locator.boundingBox())!;
}

test.describe('shipping a project', () => {
  test('the team walks to the meeting room, the party plays once, and a trophy stays', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Checkout revamp', '#FF6B9A');
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    await settled(page.locator('[data-o] .nt').first());
    await expect(page.getByRole('button', { name: /Checkout revamp, shipped/ })).toHaveCount(0);

    await complete(request, project.id);
    const floor = phaseOf(page);
    await expect(floor).toHaveAttribute('data-shipped', 'gather');
    // They set off for the meeting room, and are all there when the party begins.
    await expect(floor).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    await expect(floor).toHaveAttribute('data-team', '3/3');
    await expect(page.locator('.shipped')).toContainText('Shipped');
    await expect(page.locator('.shipped')).toContainText('Checkout revamp');
    await expect(page.getByRole('status').filter({ hasText: 'Shipped' })).toBeVisible();

    // It ends by itself and the team goes back.
    await expect(page.locator('.shipped')).toHaveCount(0, { timeout: 15_000 });
    await expect(floor).not.toHaveAttribute('data-shipped', /gather|party/);
    await expect(page.getByRole('button', { name: /Checkout revamp, shipped/ })).toBeVisible();

    // It never plays again: not when the floor is left and come back to, and not on a reload.
    await page.evaluate(() => {
      window.location.hash = '#projects';
    });
    await expect(page.locator('h1')).toHaveText('Projects');
    await page.evaluate(() => {
      window.location.hash = '#office';
    });
    await page.reload();
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    await nothingPlaysFor(page, 3500);
    await expect(page.getByRole('button', { name: /Checkout revamp, shipped/ })).toBeVisible();
  });

  test('a project completed elsewhere is celebrated when the floor next shows, once', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Docs site', '#48DBFB', 2);
    await page.goto('/#projects');
    await expect(page.locator('h1')).toHaveText('Projects');
    await page.getByRole('button', { name: 'Mark as complete' }).first().click();
    await expect(page.getByText('Completed just now')).toBeVisible();
    // Nothing plays on the Projects page, where there is no floor.
    await expect(page.locator('.shipped')).toHaveCount(0);

    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(phaseOf(page)).toHaveAttribute('data-shipped', 'party');
    await expect(page.locator('.shipped')).toContainText('Docs site');
    await expect(page.locator('.shipped')).toHaveCount(0, { timeout: 10_000 });
    // Leaving and coming back finds nothing to play.
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await nothingPlaysFor(page, 1500);
    expect(project.id).toBeTruthy();
  });

  test('with reduced motion nobody walks and nothing falls, and the banner shows still', async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Checkout revamp');
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(3);
    const names = page.locator('[data-o] .nt');
    const before = await names.evaluateAll((all) =>
      all.map((element) => element.getBoundingClientRect().toJSON() as { x: number; y: number }),
    );
    await complete(request, project.id);
    const floor = phaseOf(page);
    // There is no walk: it goes straight to the party.
    await expect(floor).toHaveAttribute('data-shipped', 'party');
    await expect(floor).not.toHaveAttribute('data-team', /\d/);
    await expect(page.locator('.shipped')).toContainText('Shipped');
    const during = await names.evaluateAll((all) =>
      all.map((element) => element.getBoundingClientRect().toJSON() as { x: number; y: number }),
    );
    expect(during.every((box, index) => sameSpot(box, before[index]))).toBe(true);
    // The banner doesn't animate in or out.
    const animation = await page
      .locator('.shipped')
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(animation).toBe('none');
    await expect(page.locator('.shipped')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Checkout revamp, shipped/ })).toBeVisible();
  });

  test('never plays while an approval waits on you, and plays once it is settled', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('.tag .nt').first()).toBeVisible();
    const pending = (await (await request.get('/api/approvals?pending=1')).json()) as {
      id: string;
    }[];
    expect(pending.length).toBeGreaterThan(0);

    const token = await hubToken(request);
    const project = await shippable(request, token, 'Billing', '#B5E35B', 1);
    await complete(request, project.id);
    // The demo's approval is still waiting, so there is no celebration over it.
    await nothingPlaysFor(page, 3000);

    // Settle whatever waits, and anything the demo asks for in the meantime, until nothing does.
    await expect
      .poll(
        async () => {
          const waiting = (await (await request.get('/api/approvals?pending=1')).json()) as {
            id: string;
          }[];
          for (const approval of waiting) {
            await request.post(`/api/approvals/${approval.id}/decision`, {
              headers: fromPage,
              data: { decision: 'denied' },
            });
          }
          return waiting.length;
        },
        { timeout: 15_000 },
      )
      .toBe(0);
    await expect(phaseOf(page)).toHaveAttribute('data-shipped', 'party', { timeout: 10_000 });
  });

  test('the trophy opens the project summary, which closes with Escape and gives focus back', async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const token = await hubToken(request);
    const project = await shippable(request, token, 'Landing page', '#B5E35B', 2);
    await complete(request, project.id);
    await page.goto('/#office');
    const trophy = page.getByRole('button', { name: /Landing page, shipped/ });
    await expect(trophy).toBeVisible();
    await trophy.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Landing page' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Agents involved')).toBeVisible();
    await expect(dialog.getByText('What got done')).toBeVisible();
    await expect(dialog.getByText('Finished the work').first()).toBeVisible();
    const found = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(found.violations.map((violation) => violation.id)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trophy).toBeFocused();
  });

  test('the trophy display fills up as projects ship, left to right', async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const token = await hubToken(request);
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
    const colours = ['#FF6B9A', '#48DBFB', '#FECA57', '#1DD1A1', '#4FB3FF', '#FF9F43', '#B892FF'];
    for (const [index, name] of names.entries()) {
      const project = await shippable(request, token, `${name} app`, colours[index], 1);
      await complete(request, project.id);
    }
    await page.goto('/#office');
    const trophies = page.locator('.trophy');
    await expect(trophies).toHaveCount(7);
    // Oldest first, left to right, and each is named for its project.
    const labels = await trophies.evaluateAll((all) =>
      all.map((element) => element.getAttribute('aria-label') ?? ''),
    );
    expect(labels.map((label) => label.split(',')[0])).toEqual(names.map((name) => `${name} app`));
    const lefts = await trophies.evaluateAll((all) =>
      all.map((element) => element.getBoundingClientRect().left),
    );
    expect(lefts[1]!).toBeGreaterThan(lefts[0]!);
    expect(lefts[6]!).toBeGreaterThan(lefts[5]!);
  });
});

test.describe('small moments', () => {
  test('a new agent walks in through the door, and an agent found on the floor does not', async ({
    page,
    request,
  }) => {
    const token = await hubToken(request);
    await hub(request, token, { agent: 'first', name: 'Early', state: 'editing', task: 'Work' });
    await page.goto('/#office');
    const early = page.locator('[data-o]', { hasText: 'Early' }).locator('.nt');
    await expect(early).toBeVisible();
    // Found already seated: it is at its desk at once.
    const first = await early.boundingBox();
    await page.waitForTimeout(500);
    expect(sameSpot(await early.boundingBox(), first)).toBe(true);

    await hub(request, token, { agent: 'late', name: 'Latecomer', state: 'editing', task: 'Work' });
    const late = page.locator('[data-o]', { hasText: 'Latecomer' }).locator('.nt');
    await expect(late).toBeVisible();
    const at = await late.boundingBox();
    await page.waitForTimeout(700);
    const later = await late.boundingBox();
    // It is walking in: it has moved, from near the bottom of the floor up to its desk.
    expect(Math.abs(later!.y - at!.y) + Math.abs(later!.x - at!.x)).toBeGreaterThan(20);
    const seated = await settled(late);
    expect(seated.y).toBeLessThan(at!.y);
  });

  test('with reduced motion a new agent is simply there', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const token = await hubToken(request);
    await hub(request, token, { agent: 'first', name: 'Early', state: 'editing', task: 'Work' });
    await page.goto('/#office');
    await expect(page.locator('.tag .nt')).toHaveCount(1);
    await hub(request, token, { agent: 'late', name: 'Latecomer', state: 'editing', task: 'Work' });
    const late = page.locator('[data-o]', { hasText: 'Latecomer' }).locator('.nt');
    await expect(late).toBeVisible();
    const at = await late.boundingBox();
    await page.waitForTimeout(600);
    expect(sameSpot(await late.boundingBox(), at)).toBe(true);
  });

  test('a crowd arriving at once, as the demo does, is simply there', async ({ page }) => {
    await page.goto('/#office');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('.tag .nt')).toHaveCount(10);
    // Nobody is on the way in from the door at the bottom of the floor: the agents at their desks
    // keep their places in relation to each other from the first moment, which a walk would not.
    // Both are read in one go, so the view easing into place can't come between the two.
    const apart = () =>
      page.evaluate(() => {
        const box = (name: string) =>
          [...document.querySelectorAll('[data-o]')]
            .find((element) => element.textContent?.includes(name))!
            .querySelector('.nt')!
            .getBoundingClientRect();
        const ledger = box('Ledger');
        const scout = box('Scout');
        return { x: scout.x - ledger.x, y: scout.y - ledger.y };
      });
    const at = await apart();
    await page.waitForTimeout(600);
    expect(sameSpot(await apart(), at)).toBe(true);
    // And none of them is down at the door.
    const stage = (await page.locator('.stage').boundingBox())!;
    const lowest = await page
      .locator('[data-o]:not([hidden]) .nt')
      .evaluateAll((all) => Math.max(...all.map((tag) => tag.getBoundingClientRect().bottom)));
    expect(lowest).toBeLessThan(stage.y + stage.height - 20);
  });
});

test.describe('the agent card', () => {
  test('shows the numbers the server counted, and Escape puts it away', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const token = await hubToken(request);
    // Two tasks finished today: it is seated and done, then does a second task and finishes it.
    for (const state of ['idle', 'running', 'done', 'thinking', 'done']) {
      await hub(request, token, { agent: 'card', name: 'Card Bot', state, task: 'Tidy up' });
    }
    await page.goto('/#office');
    const name = page.locator('[data-o]', { hasText: 'Card Bot' }).locator('.nt');
    await expect(name).toBeVisible();
    const box = await settled(name);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const card = page.getByRole('tooltip');
    await expect(card).toBeVisible();

    const served = (await (await request.get('/api/agents/hub-card/card')).json()) as {
      role: string;
      finishedToday: number;
      workedSeconds: number;
      costKnown: boolean;
    };
    expect(served.finishedToday).toBe(2);
    expect(served.role).toBe('Custom AI agent');
    // The card says what the server counted, formatted, and nothing it worked out itself.
    await expect(card.locator('h3')).toHaveText('Card Bot');
    await expect(card).toContainText(served.role);
    await expect(card.locator('.acnt', { hasText: 'Finished today' }).locator('dd')).toHaveText(
      String(served.finishedToday),
    );
    const worked = card.locator('.acnt', { hasText: 'Worked today' }).locator('dd');
    await expect(worked).toHaveText(served.workedSeconds < 60 ? '< 1 min' : /\d+ (min|h)/);
    // A hub app reports no tokens, so it has no cost to show: a dash, not $0.00.
    expect(served.costKnown).toBe(false);
    await expect(card.locator('.acnt', { hasText: 'Est. cost' }).locator('dd')).toHaveText('–');

    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    // Escape for the card did nothing else: moving away and back shows it again.
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(card).toBeVisible();
    await page.mouse.move(box.x + 400, box.y + 300);
    await expect(card).toHaveCount(0);
  });

  test('shows for a line in the list on keyboard focus too', async ({ page, request }) => {
    const token = await hubToken(request);
    await hub(request, token, {
      agent: 'listed',
      name: 'Listed Bot',
      state: 'editing',
      task: 'Work',
    });
    await page.goto('/#office');
    const row = page.locator('.flrow', { hasText: 'Listed Bot' });
    await expect(row).toBeVisible();
    // Reached by the keyboard: Tab into the list, from the control before it.
    await row.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(row).toBeFocused();
    await expect(page.getByRole('tooltip')).toContainText('Listed Bot');
    await expect(row).toHaveAttribute('aria-describedby', 'agentCard');
  });
});

test.describe('the sound of the office', () => {
  /** A stand in for Web Audio that counts what is made, so a test can tell silence from sound. */
  const fakeAudio = () => {
    const counts = { sources: 0, created: 0, suspended: 0 };
    (window as unknown as { __sound: typeof counts }).__sound = counts;
    const param = () => ({
      value: 0,
      setTargetAtTime() {},
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
    });
    const node = () => ({
      gain: param(),
      frequency: param(),
      Q: param(),
      connect() {},
      disconnect() {},
      stop() {},
      start() {
        counts.sources += 1;
      },
    });
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      sampleRate = 1000;
      destination = {};
      constructor() {
        counts.created += 1;
      }
      resume() {
        return Promise.resolve();
      }
      suspend() {
        counts.suspended += 1;
        return Promise.resolve();
      }
      createBuffer(_channels: number, length: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
      createGain = node;
      createBiquadFilter = node;
      createBufferSource = node;
      createOscillator = node;
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  };
  const sounds = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __sound: { sources: number; created: number; suspended: number } })
          .__sound,
    );

  test('is off until you turn it on, keeps its volume, and is silent with nobody working', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(fakeAudio);
    await page.goto('/#preferences');
    const card = page.locator('#officeSound');
    const sound = card.getByRole('checkbox', { name: 'Play the sound of the office' });
    const volume = card.getByRole('slider', { name: 'Volume' });
    await expect(sound).not.toBeChecked();
    await expect(volume).toBeDisabled();
    // Nothing is made while it is off.
    expect((await sounds(page)).created).toBe(0);

    await sound.check();
    await expect(volume).toBeEnabled();
    await volume.fill('30');
    await expect(card.getByText('30%')).toBeVisible();
    // The approval ding wakes its own context on the first click too, so there may be two.
    expect((await sounds(page)).created).toBeGreaterThanOrEqual(1);
    const saved = await page.evaluate(() => window.localStorage.getItem('mabari.sound'));
    expect(JSON.parse(saved!)).toEqual({ on: true, volume: 0.3 });

    // With no one working, only the quiet room tone's one source exists, and no keys.
    await page.waitForTimeout(2500);
    const quiet = (await sounds(page)).sources;
    expect(quiet).toBe(1);

    // Agents start work: the keys begin. They stop again when the work does.
    const token = await hubToken(request);
    for (let index = 0; index < 3; index++) {
      await hub(request, token, {
        agent: `typist-${index}`,
        name: `Typist ${index}`,
        state: 'editing',
        task: 'Work',
      });
    }
    await expect
      .poll(async () => (await sounds(page)).sources, { timeout: 15_000 })
      .toBeGreaterThan(quiet + 2);
    for (let index = 0; index < 3; index++) {
      await hub(request, token, { agent: `typist-${index}`, state: 'idle', task: 'Resting' });
    }
    await page.waitForTimeout(800);
    const stopped = (await sounds(page)).sources;
    await page.waitForTimeout(3000);
    expect((await sounds(page)).sources).toBe(stopped);

    // The choice and the volume come back after a reload.
    await page.reload();
    await expect(sound).toBeChecked();
    await expect(volume).toHaveValue('30');
    await sound.uncheck();
    expect(
      JSON.parse((await page.evaluate(() => window.localStorage.getItem('mabari.sound')))!),
    ).toEqual({
      on: false,
      volume: 0.3,
    });
  });

  test('the Settings page, with the sound card, passes the accessibility checks in both themes', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
      await page.goto('/#preferences');
      await page.evaluate((name) => {
        window.localStorage.setItem('mabari.theme', name);
        document.documentElement.setAttribute('data-theme', name);
      }, theme);
      await expect(page.locator('#officeSound')).toBeVisible();
      const found = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        found.violations.map((violation) => `${theme} ${violation.id}`),
        JSON.stringify(found.violations.map((violation) => violation.nodes[0]?.target)),
      ).toEqual([]);
    }
  });
});

test.describe('loading and empty states', () => {
  test('a slow first load shows a skeleton, not a blank page', async ({ page }) => {
    await page.route('**/api/snapshot', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto('/');
    const loading = page.getByRole('region', { name: 'Loading Mabari' });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(await loading.locator('.skel').count()).toBeGreaterThan(3);
    // Then the app arrives and the skeleton is gone.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
    await expect(loading).toHaveCount(0);
  });

  test('every empty state has a character in it, in both themes', async ({ page, request }) => {
    test.setTimeout(60_000);
    // An office with no agents, after the demo: Mabari's wipe leaves it first-run, so the demo is
    // loaded and stopped to get an ordinary empty office.
    await request.post('/api/demo/load');
    await request.post('/api/demo/stop');
    // Where there is nothing to show: the office with no one in it, no projects, a search that
    // matches nothing in the log or among the agents, and no conversations.
    const places: [string, string, ((page: Page) => Promise<void>) | undefined][] = [
      ['#office', '.floormsg .cast', undefined],
      ['#office', '#floorList .cast', undefined],
      ['#projects', '#noProjects .cast', undefined],
      [
        '#activity',
        'tbody .cast',
        (page) => page.getByPlaceholder('Search by agent, message or outcome').fill('zzzzzz'),
      ],
      ['#conversations', '.emptycast .cast', undefined],
      [
        '#builder',
        '.defempty .cast',
        (page) => page.getByPlaceholder('Search agents').fill('zzzzzz'),
      ],
    ];
    for (const theme of ['dark', 'light']) {
      await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
      for (const [route, selector, prepare] of places) {
        await page.goto(`/${route}`);
        await page.evaluate((name) => {
          document.documentElement.setAttribute('data-theme', name);
        }, theme);
        await prepare?.(page);
        const cast = page.locator(selector).first();
        await expect(cast, `${theme} ${route} ${selector}`).toBeVisible();
        // It is drawn: not a blank canvas.
        const drawn = await cast.evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let painted = 0;
          for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) painted++;
          return painted;
        });
        expect(drawn, `${theme} ${route} ${selector} is drawn`).toBeGreaterThan(150);
      }
    }
  });
});

test.describe('the motion language', () => {
  test('dialogs and panels ease in over the same short time, and none of it moves with reduced motion', async ({
    page,
  }) => {
    await page.goto('/#office');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await page.getByRole('button', { name: 'New agent' }).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    const motion = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      return {
        name: style.animationName,
        duration: style.animationDuration,
        timing: style.animationTimingFunction,
        tokens: [root.getPropertyValue('--dur').trim(), root.getPropertyValue('--ease').trim()],
      };
    });
    expect(motion.name).not.toBe('none');
    expect(motion.duration).toBe('0.2s');
    expect(motion.tokens).toEqual(['200ms', 'cubic-bezier(.2,.7,.2,1)']);
    expect(motion.timing.replace(/\s/g, '')).toBe('cubic-bezier(0.2,0.7,0.2,1)');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      'none',
    );
  });

  test('a button sinks a pixel when pressed, and a list line darkens', async ({ page }) => {
    await page.goto('/#projects');
    const button = page.getByRole('button', { name: 'New project' }).first();
    await expect(button).toBeVisible();
    await button.hover();
    await page.mouse.down();
    const pressed = await button.evaluate((element) => getComputedStyle(element).transform);
    await page.mouse.up();
    expect(pressed).not.toBe('none');
    expect(pressed).toContain('1');
  });
});

test.describe('the floor stays smooth', () => {
  /** Animation frames a second over a window, counted in the page the way the browser draws. */
  const framesPerSecond = (page: Page, ms: number) =>
    page.evaluate(
      (window_ms) =>
        new Promise<number>((resolve) => {
          let count = 0;
          const start = performance.now();
          const tick = (now: number) => {
            count++;
            if (now - start < window_ms) requestAnimationFrame(tick);
            else resolve((count * 1000) / (now - start));
          };
          requestAnimationFrame(tick);
        }),
      ms,
    );

  test('with a full shelf, agents in every mood and a party under way', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const token = await hubToken(request);
    // Eight shipped projects fill a shelf of two cases.
    for (let index = 0; index < 8; index++) {
      const project = await shippable(request, token, `Shelf ${index}`, '#48DBFB', 1);
      await complete(request, project.id);
    }
    // Sixteen agents at once: some typing, some running, some stopped by an error and glancing at
    // the camera, and some resting in the lounge doing their different things.
    const moods = ['editing', 'running', 'error', 'idle'];
    for (let index = 0; index < 16; index++) {
      await hub(request, token, {
        agent: `mood-${index}`,
        name: `Mood ${index}`,
        state: moods[index % moods.length],
        task: 'Work',
        error: 'Stuck',
      });
    }
    // The team of one more project, about to ship.
    const shipping = await shippable(request, token, 'Shipping now', '#FF6B9A', 3);
    await page.goto('/#office');
    await expect(page.locator('.trophy')).toHaveCount(8);
    await expect(page.locator('.tag .nt')).toHaveCount(8 + 16 + 3);
    await settled(page.locator('[data-o]', { hasText: 'Mood 15' }).locator('.nt'));

    const calm = await framesPerSecond(page, 1500);
    console.log(`frame rate, full shelf and sixteen moods: ${calm.toFixed(1)} fps`);
    expect(calm, 'a full shelf and agents in every mood').toBeGreaterThan(50);

    await complete(request, shipping.id);
    await expect(phaseOf(page)).toHaveAttribute('data-shipped', 'gather');
    const walking = await framesPerSecond(page, 2500);
    console.log(`frame rate, the team walking to the party: ${walking.toFixed(1)} fps`);
    expect(walking, 'the team walking to the meeting room').toBeGreaterThan(50);
    await expect(phaseOf(page)).toHaveAttribute('data-shipped', 'party', { timeout: 30_000 });
    const party = await framesPerSecond(page, 2500);
    console.log(`frame rate, the party with confetti: ${party.toFixed(1)} fps`);
    expect(party, 'the party with its confetti').toBeGreaterThan(50);
  });
});
