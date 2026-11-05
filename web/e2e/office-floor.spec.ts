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
          // Lines outside the Queued group that carry the amber "queued" cue.
          cued: document.querySelectorAll('#floorList .flgroup:not(.fl-queued) .flq').length,
        };
      });
      const count = (pattern: RegExp) => Number(pattern.exec(read.header)?.[1] ?? 0);
      const total = Object.values(read.sizes).reduce((sum, size) => sum + size, 0);
      return [
        total === count(/(\d+) agents?/),
        read.onTheFloor === total,
        read.sizes['Needs you'] === count(/(\d+) needs? you/),
        // RT-1: Sage works with an instruction queued and is counted once, as queued, so the
        // header's working is the Working group, and its queued is the Queued group plus any
        // line elsewhere that carries the cue (an agent that also needs you).
        (read.sizes['Working'] ?? 0) === count(/(\d+) working/),
        (read.sizes['Queued'] ?? 0) + read.cued === count(/(\d+) queued/),
      ];
    })
    .toEqual([true, true, true, true, true]);
});

// RT-1: an agent that needs you and also has an instruction waiting is listed once, under Needs
// you, with the amber cue on its line, and the header counts that instruction as queued. Atlas
// waits on an approval from the start, so an instruction sent to it waits too (FIRST-2).
test('an agent that needs you and has an instruction queued is listed once, with its queued cue', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  const agents = (await (await request.get('/api/agents')).json()) as {
    id: string;
    name: string;
  }[];
  const atlas = agents.find((agent) => agent.name === 'Atlas')!;
  const sent = await request.post('/api/messages', {
    data: { text: 'After the migration, seed the test data', mode: 'instruct', target: atlas.id },
  });
  expect(sent.ok()).toBe(true);
  await page.goto('/#office');
  await expect(list(page)).toBeVisible();

  const needs = list(page).getByRole('group', { name: /^Needs you/ });
  const row = needs.locator('.flrow', { hasText: /^Atlas/ });
  await expect(row).toBeVisible();
  await expect(row.locator('.flq')).toHaveText('1 queued');
  // One line for Atlas in the whole list.
  await expect(list(page).locator('.flrow', { hasText: /^Atlas/ })).toHaveCount(1);

  // Read at one instant: the groups add up to the agents, and the header's numbers are theirs.
  // Sage may still be waiting on its own message, in the Queued group, so the header's queued is
  // the Queued group plus the lines elsewhere that carry the cue.
  await expect
    .poll(async () => {
      const read = await page.evaluate(() => {
        const sizes: Record<string, number> = {};
        for (const group of document.querySelectorAll('#floorList .flgroup')) {
          sizes[group.querySelector('.mhead span')!.textContent!] = Number(
            group.querySelector('.mhead .num')!.textContent,
          );
        }
        return {
          sizes,
          header: document.querySelector('#officeClock')!.textContent!,
          cued: document.querySelectorAll('#floorList .flgroup:not(.fl-queued) .flq').length,
        };
      });
      const count = (pattern: RegExp) => Number(pattern.exec(read.header)?.[1] ?? 0);
      return [
        Object.values(read.sizes).reduce((sum, size) => sum + size, 0) === count(/(\d+) agents?/),
        read.sizes['Needs you'] === count(/(\d+) needs? you/),
        (read.sizes['Working'] ?? 0) === count(/(\d+) working/),
        (read.sizes['Queued'] ?? 0) + read.cued === count(/(\d+) queued/),
        read.cued >= 1,
      ];
    })
    .toEqual([true, true, true, true, true]);
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

// The wall bar has room for four projects. A fifth had no card and nothing to say it existed
// (NEW-11). The prototype only ever draws four, so this is quiet: a "+1" that opens Projects.
test('a fifth project is a quiet +1 on the wall bar, and it opens Projects', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#office');
  const bar = page.locator('#projWins');
  await expect(bar.locator('.pwin')).toHaveCount(4);
  // Four projects fill the bar, and nothing is left out, so nothing is said.
  await expect(bar.locator('.pwmore')).toHaveCount(0);

  await request.post('/api/projects', { data: { name: 'Side shop', color: '#48DBFB' } });
  const more = bar.getByRole('link', { name: /^\+1 ?more project$/ });
  await expect(more).toBeVisible();
  await expect(more).toHaveText('+1 more project');
  await expect(more).toHaveAttribute('title', '1 more project. Open Projects to see it.');
  // It is a real target, and it is not under anything.
  const hit = await more.evaluate((link) => {
    const box = link.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { covered: !link.contains(top), width: box.width, height: box.height };
  });
  expect(hit.covered).toBe(false);
  expect(hit.width).toBeGreaterThanOrEqual(24);
  expect(hit.height).toBeGreaterThanOrEqual(24);
  // The four cards are unchanged: the fifth project has no card of its own.
  await expect(bar.locator('.pwin')).toHaveCount(4);
  await expect(bar.locator('.pwin', { hasText: 'Side shop' })).toHaveCount(0);

  await request.post('/api/projects', { data: { name: 'Back office', color: '#FF9F43' } });
  await expect(bar.getByRole('link', { name: /^\+2 ?more projects$/ })).toBeVisible();
  await expect(bar.getByRole('link', { name: /more projects/ })).toHaveAttribute(
    'title',
    '2 more projects. Open Projects to see them.',
  );

  await bar.getByRole('link', { name: /more projects/ }).click();
  await expect(page).toHaveURL(/#projects$/);
  await expect(page.locator('main h1')).toHaveText('Projects');
  await expect(page.locator('main')).toContainText('Side shop');
  await expect(page.locator('main')).toContainText('Back office');
});

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

test('New agent sits next to New project in the header and opens the new agent dialog', async ({
  page,
}) => {
  await loadDemo(page);
  const head = page.locator('.ohead');
  const project = head.getByRole('button', { name: 'New project', exact: true });
  const agent = head.getByRole('button', { name: 'New agent', exact: true });
  await expect(agent).toBeVisible();
  // Side by side, on the same row.
  const [first, second] = [(await project.boundingBox())!, (await agent.boundingBox())!];
  expect(Math.abs(first.y - second.y)).toBeLessThan(4);
  expect(Math.abs(first.x + first.width - second.x)).toBeLessThan(24);
  await agent.click();
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
});

/** Whether the middle of an element is on screen and is what a click there would land on. */
function reachable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((css) => {
    const box = document.querySelector(css)!.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    return document.querySelector(css)!.contains(document.elementFromPoint(x, y));
  }, selector);
}

const SMALL: [number, number][] = [
  [720, 450],
  [390, 844],
];
for (const [width, height] of SMALL) {
  test(`the whole floor, its toolbar and the project cards can be reached at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await loadDemo(page);
    await page.waitForTimeout(500);

    // The floor keeps a usable height instead of being squeezed, so the page is what scrolls.
    const stage = (await page.locator('#stage').boundingBox())!;
    expect(stage.height).toBeGreaterThanOrEqual(359);
    const scroll = () =>
      page.locator('main').evaluate((main) => {
        main.scrollTo(0, main.scrollHeight);
        return { max: main.scrollHeight - main.clientHeight, at: main.scrollTop };
      });
    const reached = await scroll();
    expect(reached.max).toBeGreaterThan(0);

    // At the bottom, the toolbar is on screen and clickable, and it stays so while the floor
    // updates (the header re-measures itself, which once threw the page back to the top).
    await page.waitForTimeout(2500);
    await scroll();
    expect(await reachable(page, '.ctools button[aria-label="Zoom in"]')).toBe(true);
    expect(
      await reachable(page, '.ctools button[aria-label="List of everyone on the floor"]'),
    ).toBe(true);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.locator('#zoomPct')).toHaveText('125%');

    // The wall bar scrolls sideways when its filters and project cards do not fit, so every card
    // can be brought into view and clicked.
    for (const place of [4, 1, 3, 2]) {
      const card = `#projWins .pwin:nth-child(${place})`;
      await page
        .locator(card)
        .evaluate((element) => element.scrollIntoView({ inline: 'center', block: 'nearest' }));
      expect(await reachable(page, card), `project card ${place}`).toBe(true);
    }
    // Nothing makes the page itself scroll sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

/**
 * What is wrong with the speech bubbles and name tags showing right now: a quiet bubble over a
 * name tag, two bubbles over each other, and a word broken across two lines.
 */
function bubbleProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const boxOf = (element: Element): Box => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const hit = (a: Box, b: Box) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const tags: { id: string; box: Box }[] = [];
    const bubbles: { id: string; pinned: boolean; text: string; box: Box; element: Element }[] = [];
    for (const wrap of document.querySelectorAll<HTMLElement>('#stage [data-o]')) {
      if (wrap.hidden) continue;
      const id = wrap.dataset.o!;
      const tag = wrap.querySelector('.tag')!;
      if (getComputedStyle(tag).display !== 'none') tags.push({ id, box: boxOf(tag) });
      const bubble = wrap.querySelector<HTMLElement>('.bub')!;
      if (!bubble.hidden && getComputedStyle(bubble).display !== 'none') {
        const pinned = bubble.classList.contains('pin');
        bubbles.push({
          id,
          pinned,
          text: bubble.textContent!,
          box: boxOf(bubble),
          element: bubble,
        });
      }
    }
    const problems: string[] = [];
    for (const bubble of bubbles) {
      // What needs you may sit over a tag when nothing else can be done. Quiet bubbles never do.
      if (bubble.pinned) continue;
      for (const tag of tags) {
        if (hit(bubble.box, tag.box)) problems.push(`"${bubble.text}" covers the tag of ${tag.id}`);
      }
    }
    for (let first = 0; first < bubbles.length; first++) {
      for (let second = first + 1; second < bubbles.length; second++) {
        if (hit(bubbles[first]!.box, bubbles[second]!.box)) {
          problems.push(
            `"${bubbles[first]!.text}" and "${bubbles[second]!.text}" cover each other`,
          );
        }
      }
    }
    for (const bubble of bubbles) {
      const node = bubble.element.firstChild;
      if (node?.nodeType !== Node.TEXT_NODE) continue;
      for (const word of node.textContent!.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        if (lines.size > 1)
          problems.push(`"${word[0]}" is broken across lines in "${bubble.text}"`);
      }
    }
    return problems;
  });
}

for (const extra of [0, 9]) {
  test(`speech bubbles keep name tags readable and never break a word, with ${10 + extra} agents`, async ({
    page,
    request,
  }) => {
    await request.post('/api/demo/load');
    for (let n = 0; n < extra; n++) {
      const made = await request.post('/api/agents', {
        data: {
          name: `Extra${n}`,
          account: 'claude_code',
          model: 'claude-sonnet-4-5',
          task: 'Work through the backlog',
          projectId: '',
          folder: '~/code/extra',
          dailyCostCap: 0,
          allowedTools: [],
        },
      });
      expect(made.ok()).toBe(true);
    }
    await page.goto('/#office');
    await expect(page.locator('#stage .tag .nt')).toHaveCount(10 + extra);
    // Bubbles come and go as the agents work, so it is looked at for several seconds.
    const seen = new Set<string>();
    for (let look = 0; look < 12; look++) {
      for (const problem of await bubbleProblems(page)) seen.add(problem);
      await page.waitForTimeout(500);
    }
    expect([...seen], [...seen].join('\n')).toEqual([]);
    // Something is still being said: the rule hides some bubbles, not all of them.
    expect(await page.locator('#stage .bub:visible').count()).toBeGreaterThan(2);
  });
}

test('a long list on a project card says how many rows are out of view, and fades the cut one', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  for (let n = 0; n < 9; n++) {
    await request.post('/api/agents', {
      data: {
        name: `Extra${n}`,
        account: 'claude_code',
        model: 'claude-sonnet-4-5',
        task: 'Work through the backlog',
        projectId: '',
        folder: '~/code/extra',
        dailyCostCap: 0,
        allowedTools: [],
      },
    });
  }
  await page.goto('/#projects');
  const card = page.locator('article', { hasText: 'All projects' }).first();
  const list = card.getByLabel('Agents on every project');
  const more = card.getByRole('button', { name: /more agents, show them/ });
  await expect(more).toBeVisible();
  // The rows in view and the rows the cue counts make up the whole list.
  const rows = await list.evaluate((box) => {
    const edge = box.getBoundingClientRect().bottom;
    const all = [...box.querySelectorAll(':scope > .subrow')].map((row) =>
      row.getBoundingClientRect(),
    );
    return { total: all.length, out: all.filter((row) => row.top >= edge - 1).length };
  });
  expect(rows.total).toBe(19);
  expect(await more.textContent()).toBe(`+${rows.out} more`);
  // A row cut by the edge fades out, so it reads as the start of more.
  await expect(list).toHaveClass(/fades/);
  // At the end of the list there is nothing more to say.
  await list.evaluate((box) => box.scrollTo(0, box.scrollHeight));
  await expect(more).toBeHidden();
  await expect(list).not.toHaveClass(/fades/);
});

test('a completed project counts who worked on it, and the office menu says it is completed', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#projects');
  const landing = page.locator('article', { hasText: 'Landing page' });
  await expect(landing.locator('.cnt', { hasText: 'Agents involved' })).toContainText('3');
  // On the floor nobody is on it now, so the Project menu does not claim "0 agents".
  await page.goto('/#office');
  await page.getByRole('button', { name: /^Project/ }).click();
  const item = page.getByRole('menuitemradio', { name: /Landing page/ });
  await expect(item).toContainText('completed');
  await expect(item).not.toContainText('0 agents');
});

test('the Colour key describes what the floor shows now, and fits or shows that it scrolls', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#office');
  await expect(page.locator('.tag .nt').first()).toBeVisible();
  await page.getByRole('button', { name: 'Colour key' }).click();
  const key = page.getByRole('region', { name: 'Colour key' });
  await expect(key).toBeVisible();

  // It says what the floor shows: message chips and the dashed links, not the curves and
  // envelopes decision 37 took away, and it counts as the rest of the app does.
  await expect(key).toContainText('↗ To');
  await expect(key).toContainText('✉ From');
  await expect(key).toContainText('Dashed curve: a lead and one of its subagents');
  await expect(key).not.toContainText('Dashed curve and envelope');
  await expect(key).toContainText('Only red and amber ask for attention');
  await expect(key).toContainText('It counts as needing you');
  await expect(key).toContainText('a question');
  await expect(key).toContainText('it is not counted as needing you');

  // On a tall window it fits whole, with nothing to scroll.
  const fits = () => key.evaluate((menu) => ({ all: menu.scrollHeight, shown: menu.clientHeight }));
  const tall = await fits();
  expect(tall.all).toBeLessThanOrEqual(tall.shown);

  // On a short one it scrolls, can be reached with the keyboard, and shows a shadow at the edge
  // that says there is more, and the last row can be brought into view.
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(async () => (await fits()).all > (await fits()).shown).toBe(true);
  await expect(key).toHaveAttribute('tabindex', '0');
  expect(await key.evaluate((menu) => getComputedStyle(menu).backgroundImage)).toContain(
    'radial-gradient',
  );
  await key.evaluate((menu) => menu.scrollTo(0, menu.scrollHeight));
  const last = key.locator('.keyrow').last();
  await expect(last).toContainText('Time the agent thinks it has left');
  const [menuBox, rowBox] = [(await key.boundingBox())!, (await last.boundingBox())!];
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height + 1);
});

test('a finished agent has nothing to interrupt, and can still be given work or ended', async ({
  page,
}) => {
  await loadDemo(page);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  const row = (name: string) =>
    list(page).locator('.flrow', {
      has: page.locator('.flname', { hasText: new RegExp(`^${name}$`) }),
    });

  // An agent at work can be interrupted and stopped.
  await row('Scout').click();
  await expect(panel.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Interrupt' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  // Rune has finished: nothing to interrupt, and "Stop" says what it does to a finished agent.
  await row('Rune').click();
  await expect(panel.getByRole('heading', { name: 'Rune', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  // It can still be given new work, which restarts it.
  await expect(panel.getByRole('group', { name: 'Message type' })).toBeVisible();
  // And its session can be ended, after asking.
  await panel.getByRole('button', { name: 'End session' }).click();
  await expect(panel).toContainText("End Rune's session? It has nothing running.");
  await panel.getByRole('button', { name: 'Keep it' }).click();
  await expect(panel.getByRole('button', { name: 'End session' })).toBeVisible();
  await panel.getByRole('button', { name: 'End session' }).click();
  await panel.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('Rune stopped and left the office')).toBeVisible();
  await expect(panel).toBeHidden();
});

test('"Any free agent" in the project question looks like the project choices beside it', async ({
  page,
  request,
}) => {
  await request.post('/api/demo/load');
  await page.goto('/#home');
  if (!(await page.locator('#hcForm').isVisible())) await page.locator('#hcType').click();
  const box = page.getByLabel('Message Mabari');
  await box.fill('fix it');
  await box.press('Enter');
  const choices = page.locator('.pickproj');
  await expect(choices.getByRole('button', { name: 'Any free agent' })).toBeVisible();

  // The same look as the others: its own outline and fill, not bare text.
  const look = (name: string | RegExp) =>
    choices
      .getByRole('button', { name })
      .first()
      .evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
          background: style.backgroundColor,
          radius: style.borderTopLeftRadius,
          height: style.height,
          dot: button.querySelector('.pdot') !== null,
        };
      });
  const project = await look(/^(?!Any free agent)/);
  const any = await look('Any free agent');
  expect(any).toEqual(project);
  expect(any.border).not.toContain('0px');
  expect(any.background).not.toBe('rgba(0, 0, 0, 0)');
});
