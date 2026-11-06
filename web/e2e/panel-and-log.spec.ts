// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { crowd, hub, hubToken } from './support/hubOffice.ts';
import { wipe } from './support/page.ts';

// Three things that were easy to miss or to lose: "Tell me when it's done" in a working agent's
// panel, the Activity log and its Export under a crowd's timeline, and the Changes dialog's top.

test.beforeEach(async ({ request }) => {
  await wipe(request);
});

test.describe("Tell me when it's done", () => {
  test('is the first thing under the tabs of a working agent, and works from there', async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    const office = (await (await request.get('/api/snapshot')).json()) as {
      agents: { id: string; name: string }[];
    };
    const ledger = office.agents.find((agent) => agent.name === 'Ledger')!;
    await page.goto(`/#office?agent=${ledger.id}`);
    const panel = page.getByRole('complementary', { name: 'Agent details' });
    const watch = panel.getByRole('checkbox', { name: "Tell me when it's done" });
    await expect(watch).toBeVisible();

    // It is above the conversation, the session and the task, and within sight of the tabs, not
    // under them below the fold.
    const body = (await panel.locator('.pbody').boundingBox())!;
    const at = (await watch.boundingBox())!;
    expect(at.y - body.y).toBeLessThan(80);
    for (const heading of ['Conversation', 'Session', 'Current task']) {
      const section = (await panel.getByRole('heading', { name: heading }).boundingBox())!;
      expect(section.y, `above ${heading}`).toBeGreaterThan(at.y);
    }
    // It is in the panel's first screen at a short window as well.
    await page.setViewportSize({ width: 1280, height: 640 });
    const short = (await watch.boundingBox())!;
    expect(short.y + short.height).toBeLessThan(640);

    // It is the same control: turned on, it says it is watching, and off again.
    await watch.check();
    await expect(panel).toContainText('Watching. You will be told once, when Ledger is done');
    // Once the server has the watch, as a person's next click would be, it can be turned off.
    const watching = async () =>
      ((await (await request.get('/api/snapshot')).json()) as { watches: unknown[] }).watches
        .length;
    await expect.poll(watching).toBe(1);
    await watch.uncheck();
    await expect(watch).not.toBeChecked();
    await expect.poll(watching).toBe(0);
    // And only one of it, not a second further down.
    await expect(panel.getByRole('checkbox', { name: "Tell me when it's done" })).toHaveCount(1);
  });
});

test.describe('the Activity log under a crowd', () => {
  test('keeps the log and Export on the first screen, and the chart scrolls', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const token = await hubToken(request);
    // Twenty five agents who have all worked today, so each has a lane.
    await crowd(request, token, 25, ['editing', 'thinking', 'running', 'reading', 'browsing']);
    await page.goto('/#activity');
    const chart = page.locator('.tlscroll');
    await expect(chart).toBeVisible();
    await expect(page.locator('.tlrow[data-agent]')).toHaveCount(25);

    // About eight lanes show: the chart is capped, and says there are more.
    const box = (await chart.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(340);
    expect(box.height).toBeGreaterThanOrEqual(250);
    expect(
      await chart.evaluate((element) => element.scrollHeight > element.clientHeight + 100),
    ).toBe(true);
    await expect(page.locator('.tlmore')).toContainText('25 agents');

    // The log and its Export are on the first screen, as they were not.
    const exportButton = page.getByRole('button', { name: /^Export/ });
    await expect(exportButton).toBeVisible();
    const at = (await exportButton.boundingBox())!;
    expect(at.y + at.height).toBeLessThanOrEqual(900);
    await expect(page.getByPlaceholder('Search by agent, message or outcome')).toBeInViewport();

    // The time scale stays above the lanes as they scroll, and the last lane can be reached.
    const axis = (await page.locator('.tlaxis').boundingBox())!;
    await chart.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    const last = page.locator('.tlrow[data-agent]').last();
    await expect(last).toBeInViewport();
    expect((await page.locator('.tlaxis').boundingBox())!.y).toBe(axis.y);
    // The line at now runs the whole length of the lanes, not just the part in view.
    const lanes = await page.locator('.tlinner').evaluate((element) => element.scrollHeight);
    const now = await page.getByTestId('tl-now').evaluate((element) => element.clientHeight);
    expect(now).toBeGreaterThanOrEqual(lanes - 2);
    // A scrolling region can be reached from the keyboard.
    await expect(chart).toHaveAttribute('tabindex', '0');
    await expect(chart).toHaveAccessibleName('Agents on the timeline');
  });

  test('does not cap a few agents, which have all the room they need', async ({
    page,
    request,
  }) => {
    const token = await hubToken(request);
    await crowd(request, token, 5, ['editing', 'thinking', 'running', 'reading', 'browsing']);
    await page.goto('/#activity');
    await expect(page.locator('.tlrow[data-agent]')).toHaveCount(5);
    const chart = page.locator('.tlscroll');
    expect(
      await chart.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    ).toBe(true);
    await expect(page.locator('.tlmore')).toHaveCount(0);
    await expect(chart).not.toHaveAttribute('tabindex', '0');
  });
});

/** Setup runs Git on its own settings, never the person's. */
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: gitEnv, stdio: 'pipe' },
  );
}
const made: string[] = [];
function write(dir: string, name: string, text: string) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
}
/** A repository with a long list of changed files, so the dialog's diffs are taller than the window. */
function repoWithManyChanges(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mabari-changes-')));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  write(dir, 'a.txt', 'hello\nworld\n');
  for (let index = 0; index < 10; index++) write(dir, `extra${index}.txt`, 'line\n'.repeat(40));
  return dir;
}
test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

async function seat(request: APIRequestContext, token: string, name: string, folder: string) {
  await hub(request, token, {
    agent: `chg-${name}`,
    name,
    state: name === 'Kai' ? 'done' : 'editing',
    task: `Work for ${name}`,
    folder,
  });
}

test.describe('the Changes dialog', () => {
  test('keeps its top, and does not jump, when a second opinion is asked for', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const folder = repoWithManyChanges();
    const token = await hubToken(request);
    await seat(request, token, 'Atlas', folder);
    await seat(request, token, 'Kai', folder);
    await page.goto('/#office?agent=hub-chg-Atlas');
    await page
      .getByRole('complementary', { name: 'Agent details' })
      .getByRole('button', { name: 'Changes' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Changes by Atlas' });
    await expect(dialog.getByText('Modified').first()).toBeVisible();
    const heading = dialog.getByRole('heading', { name: 'Changes by Atlas' });

    // The page behind the dialog has nothing to scroll: it was a few thousand pixels tall, from
    // the screen reader words in the long diffs, and a scroll or a focus moved it.
    const scrim = () =>
      page.locator('.scrim').evaluate((element) => ({
        scrollable: element.scrollHeight - element.clientHeight,
        at: element.scrollTop,
      }));
    expect((await scrim()).scrollable).toBeLessThanOrEqual(1);
    const topBefore = (await heading.boundingBox())!.y;
    const bodyBefore = (await dialog.locator('.chbody').boundingBox())!.height;
    expect(topBefore).toBeGreaterThanOrEqual(0);

    // Ask for a second opinion: the section appears, and the status line says it was sent.
    await dialog
      .getByRole('combobox', { name: 'Second opinion from' })
      .selectOption({ label: 'Kai (Done)' });
    await dialog.getByRole('button', { name: 'Ask for a second opinion' }).click();
    await expect(dialog.getByRole('region', { name: 'Second opinions' })).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('Asked Kai');

    // The heading has not moved or gone out of view, and the body has not been pushed about.
    await page.waitForTimeout(500);
    expect((await scrim()).at).toBe(0);
    expect((await scrim()).scrollable).toBeLessThanOrEqual(1);
    expect((await heading.boundingBox())!.y).toBe(topBefore);
    expect(await heading.isVisible()).toBe(true);
    expect((await dialog.locator('.chbody').boundingBox())!.height).toBe(bodyBefore);

    // A scroll over the diffs scrolls the diffs and nothing else.
    await dialog.locator('.chfiles').hover();
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(300);
    expect((await scrim()).at).toBe(0);
    expect((await heading.boundingBox())!.y).toBe(topBefore);
  });
});
