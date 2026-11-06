// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fromPage, wipe } from './support/page.ts';

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

/** The demo office, with something auto approve decided, so there is a line for the recap to tell. */
async function demoWithAnAutoApproval(request: APIRequestContext) {
  await request.post('/api/demo/load');
  await request.post('/api/auto-approve', {
    headers: fromPage,
    data: { on: true, scope: 'all', acknowledged: true },
  });
  await request.post('/api/auto-approve', {
    headers: fromPage,
    data: { on: false, scope: 'all', acknowledged: true },
  });
}

/**
 * Pretends the person was last here `minutes` ago. It is written from a page that isn't Mabari's,
 * because Mabari's own page saves its last sign of life as it goes, and would write over it.
 */
async function awayFor(page: Page, minutes: number, route = '#home') {
  await page.goto('/api/health');
  await page.evaluate((ago) => {
    window.localStorage.removeItem('mabari.absence');
    window.localStorage.setItem('mabari.lastActive', String(Date.now() - ago * 60_000));
  }, minutes);
  await page.goto(`/${route}`);
}

const card = (page: Page) => page.getByTestId('away-card');

test.describe('while you were away', () => {
  test('coming back after 80 minutes shows what happened, with a link to each agent', async ({
    page,
    request,
  }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      'While you were away · 1 h 20 min',
    );
    const auto = card(page).locator('[data-group="autoApproved"]');
    await expect(auto).toContainText('Atlas');
    await expect(auto).toContainText('npm run db:migrate');
    // Mori stopped with an error before the person left, so it is waiting, and not news.
    const needs = card(page).locator('[data-group="needs"]');
    await expect(needs).toContainText('Mori');
    await expect(needs.locator('.recapcount')).toHaveText('1');
    // Nothing it didn't find: no finished tasks yet in a demo this young.
    await expect(card(page).locator('[data-group="finished"]')).toHaveCount(0);

    // The name opens the agent.
    await needs.getByRole('button', { name: 'Mori' }).click();
    await expect(page).toHaveURL(/#office\?agent=/);
  });

  test('is calm: it is not red, and a question waits without red', async ({ page, request }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await expect(card(page)).toBeVisible();
    const colours = await card(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderTopColor };
    });
    // Neither the card's fill nor its border is the red of an approval.
    const red = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--red').trim(),
    );
    expect(red).not.toBe('');
    expect(Object.values(colours).join(' ')).not.toContain('195, 52, 55');
    // The one red thing in it is the count of what needs you now, because an error waits.
    await expect(card(page).locator('.recapcount.red')).toHaveCount(1);
  });

  test('is dismissible, and stays dismissed for that absence, even after a reload', async ({
    page,
    request,
  }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await expect(card(page)).toBeVisible();
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(card(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#homeSum')).toContainText('working');
    await expect(card(page)).toHaveCount(0);
    // Going to another page and back doesn't bring it back either.
    await page.goto('/#activity');
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await expect(card(page)).toHaveCount(0);
    // A later absence is a different one, and gets its own card.
    await awayFor(page, 30);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      'While you were away · 30 min',
    );
  });

  test('stays on Home after a reload until it is dismissed', async ({ page, request }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await expect(card(page)).toBeVisible();
    await page.reload();
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      'While you were away · 1 h 20 min',
    );
  });

  test('is not there when nothing happened', async ({ page }) => {
    // No agents and nothing in the log: the recap is asked for, and has nothing to tell.
    const answered = page.waitForResponse((response) => response.url().includes('/api/recap'));
    await awayFor(page, 80);
    const recap = (await (await answered).json()) as { happened: boolean };
    expect(recap.happened).toBe(false);
    await expect(page.locator('#homeSum')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('is not there on a first visit, and nothing is asked for', async ({ page, request }) => {
    await demoWithAnAutoApproval(request);
    await page.goto('/api/health');
    await page.evaluate(() => window.localStorage.clear());
    const asked: string[] = [];
    page.on('request', (made) => {
      if (made.url().includes('/api/recap')) asked.push(made.url());
    });
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await expect(card(page)).toHaveCount(0);
    // From now on the page knows when it was last here.
    expect(
      await page.evaluate(() => Number(window.localStorage.getItem('mabari.lastActive'))),
    ).toBeGreaterThan(0);
    expect(asked).toEqual([]);
  });

  test('is not there after a short break', async ({ page, request }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 10);
    await expect(page.locator('#homeSum')).toContainText('working');
    await expect(card(page)).toHaveCount(0);
  });

  test('shows when someone comes back to a page that stayed open', async ({ page, request }) => {
    await request.post('/api/demo/load');
    await page.clock.install();
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await expect(card(page)).toHaveCount(0);
    // Something happens while nobody is there: auto approve settles an approval.
    await request.post('/api/auto-approve', {
      headers: fromPage,
      data: { on: true, scope: 'all', acknowledged: true },
    });
    await request.post('/api/auto-approve', {
      headers: fromPage,
      data: { on: false, scope: 'all', acknowledged: true },
    });
    // Twenty minutes go by, and then the mouse moves.
    await page.clock.fastForward('20:00');
    await page.mouse.move(300, 300);
    await page.mouse.move(320, 320);
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole('heading', { level: 2 })).toContainText(
      'While you were away',
    );
  });

  test('is clear of the stage at 1440, and sits above it where there is no room beside it', async ({
    page,
    request,
  }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await expect(card(page)).toBeVisible();
    await page.waitForTimeout(400);
    const boxes = async () =>
      page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const mascot = rect('#veeHome');
        const away = rect('[data-testid="away-card"]');
        const dock = rect('.h2dock');
        return {
          awayRight: away.right,
          awayBottom: away.bottom,
          awayTop: away.top,
          awayLeft: away.left,
          mascotLeft: mascot.left + mascot.width * 0.32,
          stageTop: mascot.top,
          dockTop: dock.top,
          viewport: window.innerWidth,
        };
      });
    const wide = await boxes();
    // Beside Mabari, not over it, and clear of the dock.
    expect(wide.awayRight).toBeLessThan(wide.mascotLeft);
    expect(wide.awayBottom).toBeLessThan(wide.dockTop);
    for (const [width, height] of [
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(400);
      const narrow = await boxes();
      // In the flow above the stage, inside the window, and clear of the dock.
      expect(narrow.awayLeft).toBeGreaterThanOrEqual(0);
      expect(narrow.awayRight).toBeLessThanOrEqual(narrow.viewport);
      expect(narrow.awayBottom).toBeLessThanOrEqual(narrow.stageTop + 1);
      expect(narrow.awayBottom).toBeLessThan(narrow.dockTop);
    }
  });
});

test.describe('Mabari answers what did I miss', () => {
  async function ask(page: Page, text: string) {
    if (!(await page.getByLabel('Message Mabari').isVisible()))
      await page.locator('#hcType').click();
    await page.getByLabel('Message Mabari').fill(text);
    await page.getByLabel('Message Mabari').press('Enter');
    await expect(page.locator('#youSaid')).toHaveText(text);
    await expect(page.locator('#veeSay .typing')).toBeHidden();
  }

  test('with the recap of the absence, from the same data as the card', async ({
    page,
    request,
  }) => {
    await demoWithAnAutoApproval(request);
    await awayFor(page, 80);
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    await ask(page, 'what did I miss?');
    const say = page.locator('#veeSay');
    await expect(say).toContainText(
      /Since \d\d:\d\d \(1 h 20 min ago\): 1 approval was auto-approved\. 1 thing needs you now\./,
    );
    await expect(say.locator('[data-group="autoApproved"]')).toContainText('Atlas');
    await expect(say.locator('[data-group="needs"]')).toContainText('Mori');
    // Nothing was sent to an agent: no instruction was logged for it.
    const log = (await (
      await request.get('/api/activity?q=what%20did%20I%20miss')
    ).json()) as unknown[];
    expect(log).toEqual([]);
    // "catch me up" is the same recap, and "what's happening?" is still the status.
    await ask(page, 'catch me up');
    await expect(say).toContainText(/Since \d\d:\d\d \(1 h 20 min ago\)/);
    await ask(page, "what's happening?");
    await expect(say).toContainText(/\d+ of \d+ agents are working/);
    await expect(say.locator('.recap')).toHaveCount(0);
  });

  test('covers the last hour when the person has not been away', async ({ page, request }) => {
    await demoWithAnAutoApproval(request);
    await page.goto('/#home');
    await expect(page.locator('#homeSum')).toContainText('working');
    await ask(page, 'catch me up');
    await expect(page.locator('#veeSay')).toContainText(
      /Since \d\d:\d\d \(1 h ago\): 1 approval was auto-approved/,
    );
  });

  test('says plainly when nothing happened', async ({ page, request }) => {
    await request.post('/api/demo/load');
    await request.post('/api/demo/stop');
    await page.goto('/#home');
    await ask(page, 'what did I miss?');
    await expect(page.locator('#veeSay')).toContainText(
      /Nothing has happened since \d\d:\d\d \(1 h ago\), and nothing needs you\./,
    );
  });
});

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  return rows;
}

test.describe('export the log', () => {
  test('downloads a CSV and a JSON file of what the filters show, with a date in the name', async ({
    page,
    request,
  }) => {
    await demoWithAnAutoApproval(request);
    await page.goto('/#activity');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByLabel('Type').selectOption('Approval');
    const shown = await page.locator('tbody tr').count();
    expect(shown).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'Export' }).click();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/^mabari-activity-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCSV(readFileSync((await csv.path())!, 'utf8'));
    expect(rows[0]).toEqual(['Time', 'Agent', 'Type', 'Message', 'Outcome']);
    // The rows the filter shows, and only those.
    expect(rows.length - 1).toBe(shown);
    expect(rows.slice(1).every((row) => row[2] === 'Approval')).toBe(true);
    await expect(page.getByText(/Saved mabari-activity-.*\.csv/)).toBeVisible();

    // The agent filter is carried too, and JSON is the other choice.
    await page.getByLabel('Type').selectOption('all');
    await page.getByLabel('Agent', { exact: true }).selectOption('Atlas');
    const atlas = await page.locator('tbody tr').count();
    await page.getByRole('button', { name: 'Export' }).click();
    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download JSON' }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/^mabari-activity-\d{4}-\d{2}-\d{2}\.json$/);
    const entries = JSON.parse(readFileSync((await json.path())!, 'utf8')) as {
      agent: string;
      time: string;
    }[];
    expect(entries).toHaveLength(atlas);
    expect(entries.every((entry) => entry.agent === 'Atlas')).toBe(true);
    expect(Number.isNaN(Date.parse(entries[0]!.time))).toBe(false);
  });

  test('hides a secret and makes a formula text, in the file itself', async ({ page, request }) => {
    await request.post('/api/demo/load');
    const agents = (await (await request.get('/api/agents')).json()) as {
      id: string;
      name: string;
    }[];
    const atlas = agents.find((agent) => agent.name === 'Ledger')!;
    for (const text of [
      '=HYPERLINK("http://evil.test","click")',
      'deploy with sk-ant-api03-PLANTEDSECRETKEY123456',
      'x;=cmd()',
    ]) {
      const sent = await request.post('/api/messages', {
        data: { text, mode: 'instruct', target: atlas.id, projectId: 'all', teamId: '' },
      });
      expect(sent.ok()).toBe(true);
    }
    await page.goto('/#activity');
    await page.getByLabel('Agent', { exact: true }).selectOption('Ledger');
    await page.getByRole('button', { name: 'Export' }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    const text = readFileSync((await file.path())!, 'utf8');
    expect(text).not.toContain('PLANTEDSECRETKEY');
    expect(text).toContain('[redacted]');
    const rows = parseCSV(text);
    const cells = rows.flat();
    // No cell begins like a formula, and none would after a semicolon either.
    expect(cells.filter((cell) => /^[\s"]*[=+\-@]/.test(cell))).toEqual([]);
    expect(cells.filter((cell) => /[;,|\t]\s*"?\s*[=+\-@]/.test(cell))).toEqual([]);
    expect(cells.some((cell) => cell.startsWith(`'=HYPERLINK(`))).toBe(true);
    expect(cells.some((cell) => cell.includes(`x;'=cmd()`))).toBe(true);
  });

  test('closes with Escape and gives focus back to the button', async ({ page }) => {
    await page.goto('/#activity');
    const exportButton = page.getByRole('button', { name: 'Export' });
    await exportButton.click();
    await expect(exportButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(exportButton).toHaveAttribute('aria-expanded', 'false');
    await expect(exportButton).toBeFocused();
    await expect(page.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);
  });
});

test.describe("today's timeline", () => {
  test('draws a row for each agent in the demo, with a line at now', async ({ page, request }) => {
    await request.post('/api/demo/load');
    await page.goto('/#activity');
    const timeline = page.getByTestId('timeline');
    await expect(timeline.getByRole('heading', { name: "Today's timeline" })).toBeVisible();
    const rows = timeline.locator('[data-agent]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    await expect(timeline.getByTestId('tl-block').first()).toBeVisible();
    await expect(timeline.getByTestId('tl-now')).toBeVisible();
    // Blocks of each kind the demo has: work, and Atlas waiting on an approval, and Mori's error.
    await expect(timeline.locator('[data-kind="working"]').first()).toBeVisible();
    await expect(
      timeline.locator('[data-testid="tl-block"][data-kind="approval"]').first(),
    ).toBeVisible();
    await expect(timeline.locator('[data-kind="error"]').first()).toBeVisible();
    // And a mark for the approval, which is the red diamond.
    await expect(
      timeline.locator('[data-testid="tl-marker"][data-kind="approval"]').first(),
    ).toBeVisible();
    // The legend says what each one is.
    await expect(timeline.getByText('Waiting for your approval')).toBeVisible();
  });

  test('says in words what the picture says, one row at a time', async ({ page, request }) => {
    await request.post('/api/demo/load');
    await page.goto('/#activity');
    const atlas = page.getByRole('img', { name: /^Atlas: / });
    await expect(atlas).toBeVisible();
    const words = (await atlas.getAttribute('aria-label')) ?? '';
    // In the demo Atlas begins the day waiting on an approval, and is still waiting.
    expect(words).toMatch(
      /^Atlas: waiting for your approval from \d\d:\d\d to now\. approval at \d\d:\d\d: npm run db:migrate -- --env=staging, waiting\.$/,
    );
    await expect(page.getByTestId('timeline').locator('p.sr').first()).toContainText(
      /^Timeline for today: \d+ agents\./,
    );
    // The mouse hovers over a block to read it.
    const title = await page
      .getByTestId('timeline')
      .locator('[data-testid="tl-block"][data-kind="approval"]')
      .first()
      .getAttribute('title');
    expect(title).toMatch(/^Atlas was waiting for your approval from \d\d:\d\d to now$/);
  });

  test('opens the agent when its block, or its name, is clicked', async ({ page, request }) => {
    await request.post('/api/demo/load');
    await page.goto('/#activity');
    const timeline = page.getByTestId('timeline');
    await expect(timeline.getByTestId('tl-block').first()).toBeVisible();

    const atlas = timeline.locator('[data-agent]').filter({ hasText: 'Atlas' }).first();
    await atlas.locator('[data-testid="tl-block"]').first().click();
    await expect(page).toHaveURL(/#office\?agent=/);
    const id = new URL(page.url()).hash.split('agent=')[1]!;
    const agents = (await (await request.get('/api/agents')).json()) as {
      id: string;
      name: string;
    }[];
    expect(agents.find((agent) => agent.id === decodeURIComponent(id))?.name).toBe('Atlas');
    await expect(
      page
        .getByRole('complementary', { name: 'Agent details' })
        .getByRole('heading', { name: 'Atlas', exact: true }),
    ).toBeVisible();

    // From the keyboard, the name is the way in.
    await page.goto('/#activity');
    await timeline.getByRole('button', { name: 'Scout' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#office\?agent=/);
  });

  test('marks an instruction on the agent it was sent to', async ({ page, request }) => {
    await request.post('/api/demo/load');
    const agents = (await (await request.get('/api/agents')).json()) as {
      id: string;
      name: string;
    }[];
    const bolt = agents.find((agent) => agent.name === 'Bolt')!;
    await request.post('/api/messages', {
      data: {
        text: 'Check the build',
        mode: 'instruct',
        target: bolt.id,
        projectId: 'all',
        teamId: '',
      },
    });
    await page.goto('/#activity');
    const row = page.getByTestId('timeline').locator(`[data-agent="${bolt.id}"]`);
    const mark = row.locator('[data-testid="tl-marker"][data-kind="instruction"]');
    await expect(mark).toHaveCount(1);
    expect(await mark.getAttribute('title')).toMatch(
      /^Bolt: instruction at \d\d:\d\d: Check the build, /,
    );
  });

  test('goes back a day to a day with nothing in it, and cannot go past today', async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    await page.goto('/#activity');
    const timeline = page.getByTestId('timeline');
    await expect(timeline.getByTestId('tl-block').first()).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'Day after' })).toBeDisabled();
    await timeline.getByRole('button', { name: 'Day before' }).click();
    await expect(timeline.getByRole('heading', { level: 2 })).toHaveText(
      /^Timeline for \w{3} \d{1,2} \w{3}$/,
    );
    await expect(timeline.getByTestId('timeline-empty')).toHaveText('No agent worked on this day.');
    await timeline.getByRole('button', { name: 'Day after' }).click();
    await expect(timeline.getByRole('heading', { level: 2 })).toHaveText("Today's timeline");
    await expect(timeline.getByTestId('tl-block').first()).toBeVisible();
  });

  test('says nothing has happened when nothing has', async ({ page }) => {
    await page.goto('/#activity');
    await expect(page.getByTestId('timeline-empty')).toContainText('No agent has worked yet today');
  });

  test('picks up an agent that starts working while the page is open', async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    await request.post('/api/demo/stop');
    await page.goto('/#activity');
    await expect(page.getByTestId('timeline-empty')).toBeVisible();
    await request.post('/api/demo/load');
    await expect(page.getByTestId('timeline').locator('[data-agent]').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the card, the timeline and the export pass WCAG 2.1 AA in the ${theme} theme`, async ({
      page,
      request,
    }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
      await demoWithAnAutoApproval(request);
      const audit = async () =>
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze()
        ).violations.map(
          (violation) =>
            `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
        );
      await awayFor(page, 80);
      await expect(card(page)).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.waitForTimeout(500);
      expect(await audit(), 'Home with the card').toEqual([]);
      await page.goto('/#activity');
      await expect(page.getByTestId('timeline').getByTestId('tl-block').first()).toBeVisible();
      await page.getByRole('button', { name: 'Export' }).click();
      expect(await audit(), 'Activity with the timeline and the export open').toEqual([]);
    });
  }
});
