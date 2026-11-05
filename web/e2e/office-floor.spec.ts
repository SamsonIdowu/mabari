// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The office floor: one meaning of "needs you" everywhere, the groups in the list, and the
// controls and cards that must stay reachable and readable.

const apiPort = process.env.MABARI_API_PORT ?? '4327';
const env = {
  ...process.env,
  MABARI_DATA_DIR: process.env.MABARI_E2E_DATA_DIR!,
  CLAUDE_CONFIG_DIR: process.env.MABARI_E2E_CLAUDE_DIR!,
  MABARI_SECRETS: 'encrypted-file',
  MABARI_MASTER_KEY: process.env.MABARI_E2E_MASTER_KEY!,
};
const binary = join(mkdtempSync(join(tmpdir(), 'mabari-e2e-floor-bin-')), 'mabari');

test.beforeAll(() => {
  // `mabari connect claude` refuses to run under `go run`, so the tests build the binary.
  execFileSync('go', ['build', '-o', binary, './cmd/mabari'], { cwd: resolve('..'), env });
});

test.afterAll(() => {
  execFileSync(binary, ['disconnect', 'claude'], { env });
});

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page, hash = '') {
  await page.goto(`/${hash}`);
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

const list = (page: Page) => page.getByRole('complementary', { name: 'Everyone on the floor' });

/** The number on a list group's heading, such as the 3 of "Needs you 3". */
async function groupCount(page: Page, name: RegExp): Promise<number> {
  const heading = list(page).getByRole('group', { name }).locator('.mhead .num');
  return Number(await heading.textContent());
}

/** Claude Code asks a question through the real hook, as it would. */
function askFromClaudeCode(): Promise<string> {
  const hook = spawn(binary, ['hook', '--port', apiPort, 'PreToolUse'], { env });
  let printed = '';
  hook.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  hook.stdin.end(
    JSON.stringify({
      session_id: 'e2e-floor-question',
      cwd: '/tmp/quizshop',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which database should the shop use?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Runs as its own server' },
              { label: 'SQLite', description: 'One file, no server' },
            ],
          },
        ],
      },
    }),
  );
  return new Promise((done) => hook.on('close', () => done(printed)));
}

/** Asks until the page shows it: a hook that comes before the page's connection is sent again. */
async function askOnceLive(page: Page, asking: Locator): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const printed = askFromClaudeCode();
    const outcome = await Promise.race([
      printed.then(() => 'left to Claude Code'),
      asking.waitFor({ timeout: 10_000 }).then(
        () => 'shown',
        () => 'not shown',
      ),
    ]);
    if (outcome === 'shown') return;
    await page.waitForTimeout(300);
  }
  throw new Error('the question never showed');
}

async function connectClaude(request: APIRequestContext) {
  await request.post('/api/wipe', { data: { confirm: true } });
  execFileSync(binary, ['disconnect', 'claude'], { env });
  execFileSync(binary, ['connect', 'claude', '--yes'], { env });
}

test('every count of who needs you agrees, with an approval, an error, a question and a queued instruction', async ({
  page,
  request,
}) => {
  await connectClaude(request);
  await request.post('/api/demo/load');
  await page.goto('/#office');
  // The demo has Atlas waiting on an approval, Mori stopped by an error and Sage with an
  // instruction queued. Quizshop adds a question.
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await askOnceLive(page, page.locator('.bub.ask', { hasText: 'Asking you a question' }));

  const needsMeBadge = page.getByRole('button', { name: /^Needs me/ }).locator('.badge');
  await expect(needsMeBadge).toHaveText('3');

  // The floor header: three need you, and the queued instruction is counted apart, in amber.
  const header = page.locator('#officeClock');
  await expect(header).toContainText('3 need you');
  await expect(header).toContainText('1 queued');
  await expect(header.locator('.queuedn')).toHaveText('1 queued');

  // The list: Needs you has the same three, and Sage waits in its own Queued group.
  await expect(list(page)).toBeVisible();
  expect(await groupCount(page, /^Needs you/)).toBe(3);
  expect(await groupCount(page, /^Queued/)).toBe(1);
  const needs = list(page).getByRole('group', { name: /^Needs you/ });
  for (const name of ['Atlas', 'Mori', 'Quizshop']) {
    await expect(needs.locator('.flname', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  }
  const queued = list(page).getByRole('group', { name: /^Queued/ });
  await expect(queued.locator('.flname')).toHaveText(['Sage']);

  // The Needs me filter shows the same three on the floor.
  await page.getByRole('button', { name: /^Needs me/ }).click();
  await expect(page.locator('.tag .nt:visible')).toHaveCount(3);
  await page.getByRole('button', { name: 'Everyone', exact: true }).click();

  // The rail badge, on another page: three, red because an approval and an error wait.
  await page.goto('/#projects');
  const badge = page.locator('.rail a.nav[href="#office"] .badge');
  await expect(badge).toHaveText('3');
  await expect(badge).not.toHaveClass(/calm/);

  // Home says three, and so does Mabari.
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('3 need you');
  if (!(await page.locator('#hcForm').isVisible())) await page.locator('#hcType').click();
  const box = page.getByLabel('Message Mabari');
  await box.fill('status?');
  await box.press('Enter');
  await expect(page.locator('#veeSay')).toContainText('and 3 need you');
  await box.fill('Who needs me?');
  await box.press('Enter');
  await expect(page.locator('#veeSay')).toContainText('3 things need you');
});

test('finished agents are listed under Done, and the header and the groups add up', async ({
  page,
}) => {
  await loadDemo(page);
  await expect(list(page)).toBeVisible();
  // Rune finished its task: it is Done, not Working.
  const done = list(page).getByRole('group', { name: /^Done/ });
  await expect(done.locator('.flname', { hasText: /^Rune$/ })).toBeVisible();
  const working = list(page).getByRole('group', { name: /^Working/ });
  await expect(working.locator('.flname', { hasText: /^Rune$/ })).toHaveCount(0);

  // The header's counts come from the same agents as the groups, read at one instant.
  await expect
    .poll(async () => {
      const read = await page.evaluate(() => {
        const sizes: Record<string, number> = {};
        for (const group of document.querySelectorAll('#floorList .flgroup')) {
          const label = group.querySelector('.mhead span')!.textContent!;
          sizes[label] = Number(group.querySelector('.mhead .num')!.textContent);
        }
        return {
          sizes,
          header: document.querySelector('#officeClock')!.textContent!,
          onTheFloor: Number(document.querySelector('#floorList .flhead .num')!.textContent),
        };
      });
      const count = (pattern: RegExp) => Number(pattern.exec(read.header)?.[1] ?? 0);
      const total = Object.values(read.sizes).reduce((sum, size) => sum + size, 0);
      return [
        total === count(/(\d+) agents?/),
        read.onTheFloor === total,
        read.sizes['Needs you'] === count(/(\d+) needs? you/),
        // Sage works with an instruction queued, so it is in Queued and counts as working too.
        (read.sizes['Working'] ?? 0) + (read.sizes['Queued'] ?? 0) === count(/(\d+) working/),
      ];
    })
    .toEqual([true, true, true, true]);
});

/** A project that starts with the lead's plan waiting for approval: a second approval. */
async function startProjectWaitingForItsPlan(request: APIRequestContext) {
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
}

/** The project cards on the wall bar, as boxes, and whether a click at the middle of each lands on it. */
async function projectCards(page: Page) {
  return page.locator('#projWins .pwin:not(.empty)').evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        name: card.querySelector('.pwn')!.textContent!,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        clickable: card.contains(hit),
      };
    }),
  );
}

const WINDOWS: [number, number][] = [
  [1280, 720],
  [1440, 900],
];
for (const [width, height] of WINDOWS) {
  test(`the approval stack leaves the project cards readable and clickable at ${width} px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height });
    await request.post('/api/demo/load');
    await page.goto('/#office');
    const stack = page.locator('#board:not(.is-mini)');
    await expect(stack.locator('.bitem')).toHaveCount(1);

    for (const approvals of [1, 2]) {
      if (approvals === 2) {
        await startProjectWaitingForItsPlan(request);
        await expect(stack.locator('.bitem')).toHaveCount(2, { timeout: 15_000 });
      }
      const board = (await stack.boundingBox())!;
      const cards = await projectCards(page);
      expect(cards.map((card) => card.name)).toEqual([
        'Checkout revamp',
        'Docs site',
        'Test coverage',
        'Landing page',
      ]);
      for (const card of cards) {
        const apart =
          card.box.x + card.box.width <= board.x ||
          board.x + board.width <= card.box.x ||
          card.box.y + card.box.height <= board.y ||
          board.y + board.height <= card.box.y;
        expect(apart, `${card.name} is covered by ${approvals} approval(s)`).toBe(true);
        expect(card.clickable, `${card.name} can be clicked`).toBe(true);
      }
    }
  });
}

test('starting a project leaves the office filters alone and still says it started', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#office');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  // Looking at one project, with the Needs me filter on.
  await page.getByRole('button', { name: /^Project/ }).click();
  await page.getByRole('menuitemradio', { name: /Docs site/ }).click();
  await page.getByRole('button', { name: /^Needs me/ }).click();
  // Only Mori, stopped by an error, in Docs site.
  await expect(page.locator('.tag .nt:visible')).toHaveCount(1);

  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Start right away' }).click();
  await dialog
    .locator('#briefText')
    .fill('Build an internal dashboard that shows weekly sales by region');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog
    .locator('.plancard')
    .getByRole('button', { name: /Start project with 3 agents/ })
    .click();
  await expect(dialog).toBeHidden();

  // The server's toast still says it started.
  await expect(
    page.locator('.toast').filter({ hasText: ' created. ' }).filter({ hasText: 'is walking in' }),
  ).toBeVisible();
  // The filters are as they were.
  await expect(page.locator('.dd').first()).toContainText('Docs site');
  await expect(page.getByRole('button', { name: /^Needs me/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.tag .nt:visible')).toHaveCount(1);
});
