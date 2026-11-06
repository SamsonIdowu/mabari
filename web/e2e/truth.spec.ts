// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { wipe } from './support/page.ts';

// Mabari tells the truth: what it says about the office, about what it did with a message, and
// about itself is so. Each test is a thing a newcomer's first minutes hit.

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

async function demoHome(page: Page, request: APIRequestContext) {
  await request.post('/api/demo/load');
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
}

/** The Type button shows the text field above the dock; it stays until Esc or Type hides it. */
async function ask(page: Page, text: string) {
  if (!(await page.locator('#hcForm').isVisible())) await page.locator('#hcType').click();
  await page.getByLabel('Message Mabari').fill(text);
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(page.locator('#youSaid')).toHaveText(text);
  await expect(page.locator('#veeSay .typing')).toBeHidden();
}

/** Opens an agent from its row in the list beside the floor, which a speech bubble can't cover. */
async function clickAgent(page: Page, name: string) {
  const row = page.locator('.flrow', {
    has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }),
  });
  await expect(row).toBeVisible();
  await row.click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  return panel;
}

test('"how is everything going?" gets the status, and so does every phrase Mabari suggests', async ({
  page,
  request,
}) => {
  await demoHome(page, request);
  for (const phrase of ['how is everything going?', 'how are things going?', "how's it going"]) {
    await ask(page, phrase);
    await expect(page.locator('#veeSay')).toContainText(/\d+ of \d+ agents are working/);
    await expect(page.locator('#veeSay')).not.toContainText("I'm not sure");
  }
  // The reply to something Mabari can't place suggests only questions it answers, so it's safe to
  // type them back.
  await ask(page, 'ok');
  const said = (await page.locator('#veeSay').textContent()) ?? '';
  expect(said).toContain("I'm not sure what to do with that");
  const suggested = [...said.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  expect(suggested.length).toBeGreaterThan(0);
  for (const phrase of suggested) {
    await ask(page, phrase);
    await expect(page.locator('#veeSay')).not.toContainText("I'm not sure");
    await expect(page.locator('#veeSay')).not.toContainText('On it, sent to');
  }
});

test('an instruction is acknowledged in words that make sense', async ({ page, request }) => {
  await demoHome(page, request);
  const say = page.locator('#veeSay');
  await ask(page, 'tell Scout to please check the chart labels');
  await expect(say).toContainText("Scout (ChatGPT) replied: Got it. I'll check the chart labels.", {
    timeout: 10000,
  });
  await ask(page, 'tell Scout to after this step, run the linter');
  await expect(say).toContainText(
    'Scout (ChatGPT) replied: Got it: after this step, run the linter.',
    {
      timeout: 10000,
    },
  );
  await ask(page, 'tell Scout we need tests for csv');
  await expect(say).toContainText('Scout (ChatGPT) replied: Got it: we need tests for csv.', {
    timeout: 10000,
  });
});

test('an instruction to an agent waiting on an approval waits, and is delivered after Allow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  const panel = await clickAgent(page, 'Atlas');
  // Clicking an agent that needs approval opens its card first; the panel is behind it.
  const card = page.getByRole('dialog');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Close' }).click();

  await panel
    .getByLabel('Message', { exact: true })
    .fill('After the migration, also seed the test data');
  await panel.getByRole('button', { name: 'Send instruction' }).click();
  const tray = page.locator('#promptTray');
  const held = tray.locator('.ptcard', { hasText: 'seed the test data' });
  await expect(held).toContainText('Waiting for its next checkpoint');
  await expect(held).not.toContainText('Replied');
  await expect(panel).toContainText('Paused until you decide on the approval');
  await expect(panel).toContainText('Waiting to deliver');
  // It stays held while it waits on you.
  await page.waitForTimeout(3000);
  await expect(held).toContainText('Waiting for its next checkpoint');

  await clickAgent(page, 'Atlas');
  await page.getByRole('dialog').getByRole('button', { name: 'Allow once' }).click();
  await expect(held).toContainText('Replied');
  await expect(held).toContainText('Got it: After the migration, also seed the test data.');
  await expect(panel).not.toContainText('Waiting to deliver');
});

test('Mabari on Home says why a message to an agent waiting on you waits', async ({
  page,
  request,
}) => {
  await demoHome(page, request);
  await ask(page, 'tell Atlas to also seed the test data');
  await expect(page.locator('#veeSay')).toContainText(
    'Atlas is waiting for your approval, so it gets it once you decide.',
  );
  await expect(page.locator('#veeSay')).not.toContainText("It's mid step");
});

test('a long list says how many more are working, so the count and the list reconcile', async ({
  page,
  request,
}) => {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  for (let index = 0; index < 9; index++) {
    // Vite proxies only /api and /ws, so the hub is called on the Go server directly.
    const seated = await request.post(
      `http://127.0.0.1:${process.env.MABARI_API_PORT ?? '4327'}/hub/v1/events`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          agent: `truth-${index}`,
          name: `Worker ${index + 1}`,
          state: 'editing',
          task: 'Work',
        },
      },
    );
    expect(seated.status(), await seated.text()).toBe(200);
  }
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('9 working');
  await ask(page, 'status?');
  const say = page.locator('#veeSay');
  await expect(say).toContainText('9 of 9 agents are working');
  await expect(say.locator('.hclist li')).toHaveCount(7);
  await expect(say.locator('.hclist li').last()).toHaveText('and 3 more');
  await expect(say.locator('.hclist li button')).toHaveCount(6);
});

test('Mabari says how to get an agent when there is none', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toHaveText('No agents yet');
  await ask(page, 'build me a todo app');
  const say = page.locator('#veeSay');
  await expect(say).toContainText("There's no agent free to take that yet.");
  await expect(say).toContainText('Open Accounts');
  await expect(say).toContainText('New agent');
  await expect(say).not.toContainText('Start one first');
});

test('the planner names a project from accents and other scripts, and as a noun phrase', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#office');
  for (const [brief, name] of [
    ['Café ordering für Zürich app', 'Café Ordering Zürich'],
    ['Build an internal dashboard that shows weekly sales by region', 'Internal Dashboard'],
    ['Research three competitors and write a short report on their pricing', 'Competitors'],
    ['做一个咖啡店的网站', '做一个咖啡店的网站'],
  ] as const) {
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.locator('#briefText').fill(brief);
    await dialog.locator('#briefText').press('Enter');
    await expect(dialog.locator('#bpName')).toHaveValue(name);
    await expect(dialog.locator('.plancard')).toContainText(`Plan ${name.toLowerCase()},`);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  }
});

test('the demo says when it ends, and the banner, the toast and the timer agree', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const before = Date.now();
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  const banner = page.locator('#demoBanner');
  await expect(banner).toContainText(/turns itself off at \d\d:\d\d/);
  // The toast says how long is left, from the timer's own end time.
  await expect(page.getByText('It turns itself off in 10 minutes.')).toBeVisible();
  const { demoEndsAt } = (await (await request.get('/api/snapshot')).json()) as {
    demoEndsAt: number;
  };
  const left = demoEndsAt - before;
  expect(left).toBeGreaterThan(9 * 60_000 + 50_000);
  expect(left).toBeLessThan(10 * 60_000 + 10_000);
  // The banner shows that end time, in the page's own clock.
  const shown = await page.evaluate((ms) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }, demoEndsAt);
  await expect(banner).toContainText(`turns itself off at ${shown}`);
});

test('a demo estimate falls at the pace of the clock', async ({ request }) => {
  await request.post('/api/demo/load');
  const read = async () => {
    const snapshot = (await (await request.get('/api/snapshot')).json()) as {
      agents: { name: string; task: string; estimate: { secondsLeft: number } | null }[];
    };
    return new Map(
      snapshot.agents
        .filter((agent) => agent.estimate)
        .map((agent) => [agent.name, { task: agent.task, left: agent.estimate!.secondsLeft }]),
    );
  };
  const first = await read();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const second = await read();
  const seconds = (Date.now() - started) / 1000;
  let measured = 0;
  for (const [name, then] of first) {
    const now = second.get(name);
    if (!now || now.task !== then.task) continue;
    const fell = (then.left - now.left) / seconds;
    measured++;
    // Seconds per second: about one, where it used to be about six.
    expect(fell, `${name} fell ${fell.toFixed(2)} s per second`).toBeGreaterThan(0.5);
    expect(fell, `${name} fell ${fell.toFixed(2)} s per second`).toBeLessThan(1.6);
  }
  expect(measured).toBeGreaterThanOrEqual(4);
});

test('a demo agent asks a question, and the answer in its panel lets it carry on', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await request.post('/api/demo/load');
  await page.goto('/#office');
  // It asks half a minute in, once it has read the message the demo opens with waiting for it.
  const asking = page.locator('.bub.ask', { hasText: 'Asking you a question' });
  await expect(asking).toBeVisible({ timeout: 75_000 });
  await expect(page.getByText('Sage is asking you a question').first()).toBeVisible();

  const panel = await clickAgent(page, 'Sage');
  const form = panel.getByRole('form', { name: 'Sage is asking you 2 questions' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('Which pagination style should the orders API use?');
  await expect(form).toContainText('Stable while orders change');
  // A question is not an approval: nothing about it is red.
  await expect(panel.locator('.banner.red')).toHaveCount(0);

  const send = form.getByRole('button', { name: 'Send answers' });
  await expect(send).toBeDisabled();
  await form.getByRole('radio', { name: /Cursor-based/ }).check();
  await form
    .getByRole('group', { name: /What else should it include/ })
    .getByRole('checkbox', { name: /Link headers/ })
    .check();
  await expect(send).toBeEnabled();
  await send.click();

  await expect(form).toBeHidden();
  await expect(asking).toBeHidden();
  await expect(
    page.locator('.bub.reply', { hasText: 'Thanks. Going with Cursor-based and Link headers.' }),
  ).toBeVisible();
  // Sage carries on: it works again, with a finish time, and doesn't ask a second time.
  await expect(panel).toContainText(/About \d+ min left|Under a minute left/);
  await expect(panel.getByRole('form', { name: /Sage is asking you/ })).toHaveCount(0);
});

// A tester's click on Sage missed while its question bubble showed (NEW-10). Bubbles, name tags
// and chips are drawn over the floor with pointer-events off, so a click goes through them to the
// floor, and the floor opens the agent under the click: its sprite, or the bubble just above it,
// which reads as Sage's. This pins that down, because a bubble that took the click would make the
// agent that is asking for you the hardest one to open. The name tag below the feet is on the edge
// of what the floor counts as the sprite, as in the prototype, so only its being uncovered is
// checked.
test('a question bubble swallows no click: the agent opens from its sprite and its bubble', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await request.post('/api/demo/load');
  await page.goto('/#office');
  const asking = page.locator('.bub.ask', { hasText: 'Asking you a question' });
  await expect(asking).toBeVisible({ timeout: 75_000 });
  const panel = page.getByRole('complementary', { name: 'Agent details' });

  for (const spot of ['sprite', 'bubble', 'name tag'] as const) {
    // The spotlight on the last agent fades out a moment after its panel closes, and covers the
    // floor until it has.
    await expect(page.locator('#focusLayer')).toBeHidden();
    // Where each is now: Sage keeps still while it waits, but the layout may still settle.
    const point = await page.evaluate((which) => {
      // The tag named Sage: other tags mention it too, in their message chips.
      const name = [...document.querySelectorAll('.tag')].find(
        (item) => item.querySelector('.nn b')?.textContent === 'Sage',
      )!;
      const tagBox = name.getBoundingClientRect();
      const bubble = document.querySelector('.bub.ask')!.getBoundingClientRect();
      const at = {
        sprite: { x: tagBox.x + tagBox.width / 2, y: tagBox.y - 24 },
        bubble: { x: bubble.x + bubble.width / 2, y: bubble.y + bubble.height / 2 },
        'name tag': { x: tagBox.x + tagBox.width / 2, y: tagBox.y + tagBox.height / 2 },
      }[which];
      const top = document.elementFromPoint(at.x, at.y);
      return { ...at, topmost: top?.id || `${top?.tagName}.${top?.className}` };
    }, spot);
    // Nothing is in the way: what a click meets is the floor.
    expect(point.topmost, `what is at the ${spot}`).toBe('floor');
    if (spot === 'name tag') continue;
    await page.mouse.click(point.x, point.y);
    await expect(
      panel.getByRole('heading', { name: 'Sage', exact: true }),
      `a click on the ${spot}`,
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});
