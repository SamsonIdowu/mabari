// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { wipe } from './support/page.ts';

// The Chats screen in the demo office: With you, the thread, the message box, project chat, Hand
// to and Ask everyone. Streaming, "@" files and the session choices need a real session, so
// chat-session.spec.ts has those, against the fake claude.

interface Ids {
  agents: Record<string, string>;
  projects: Record<string, string>;
}

async function ids(request: APIRequestContext): Promise<Ids> {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    agents: { id: string; name: string }[];
    projects: { id: string; name: string }[];
  };
  return {
    agents: Object.fromEntries(snapshot.agents.map((agent) => [agent.name, agent.id])),
    projects: Object.fromEntries(snapshot.projects.map((project) => [project.name, project.id])),
  };
}

test.beforeEach(async ({ request }) => {
  await wipe(request);
  await request.post('/api/demo/load');
});

const thread = (page: Page, name: string) =>
  page.getByRole('log', { name: `Messages with ${name}` });
const box = (page: Page, name: string) => page.getByRole('textbox', { name: `Message ${name}` });

/** How many agents on a project an "Ask everyone" reaches: leads that are here and not in an error. */
async function askable(request: APIRequestContext, project: string): Promise<number> {
  const snapshot = (await (await request.get('/api/snapshot')).json()) as {
    projects: { id: string; name: string }[];
    agents: { projectId: string | null; leadId: string | null; state: string; leaving: boolean }[];
  };
  const id = snapshot.projects.find((entry) => entry.name === project)?.id;
  return snapshot.agents.filter(
    (agent) => agent.projectId === id && !agent.leadId && !agent.leaving && agent.state !== 'error',
  ).length;
}

async function open(page: Page, hash: string, name: string) {
  await page.goto(`/${hash}`);
  await expect(thread(page, name)).toBeVisible();
}

test('With you lists who needs you first, and opens a thread beside the list', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await page.goto('/#conversations');
  await expect(page.locator('h1')).toHaveText('Conversations');
  await expect(page.getByRole('button', { name: 'With you' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const list = page.getByRole('navigation', { name: 'Who to talk to' });
  const agents = list.getByRole('region', { name: /^Agents/ });
  // Approvals and errors first, then what works, then the rest: the order of who needs you.
  const names = await agents.locator('.wyname').allTextContents();
  expect(names.slice(0, 2)).toEqual(['Atlas', 'Mori']);
  expect(names.indexOf('Pixel')).toBeGreaterThan(names.indexOf('Bolt'));
  await expect(list.getByRole('status')).toHaveText('2 need you, listed first.');
  // Only an approval or an error is red: a quiet agent's row has nothing red in it.
  await expect(list.getByRole('link', { name: /^Pixel/ }).locator('.chip.red')).toHaveCount(0);
  await expect(list.getByRole('link', { name: /^Atlas/ }).locator('.chip.red')).toHaveCount(1);
  await expect(list.getByRole('region', { name: /^Projects/ })).toContainText('Checkout revamp');

  // Wide, the thread of the first one is already beside the list.
  await expect(thread(page, 'Atlas')).toBeVisible();
  const [at, over] = await Promise.all([list.boundingBox(), thread(page, 'Atlas').boundingBox()]);
  expect(at!.x + at!.width).toBeLessThanOrEqual(over!.x + 1);
  expect(Math.abs(at!.y - over!.y)).toBeLessThan(80);

  // Picking another changes the address, so Back comes back.
  await list.getByRole('link', { name: /^Pixel/ }).click();
  await expect(thread(page, 'Pixel')).toBeVisible();
  expect(page.url()).toContain(`#conversations?agent=${known.agents.Pixel}`);
  await expect(list.getByRole('link', { name: /^Pixel/ })).toHaveAttribute('aria-current', 'true');
  await list.getByRole('link', { name: /^Rune/ }).click();
  await expect(thread(page, 'Rune')).toBeVisible();
  await page.goBack();
  await expect(thread(page, 'Pixel')).toBeVisible();
  // A link opens one, and it survives a reload.
  await page.reload();
  await expect(thread(page, 'Pixel')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Pixel' })).toBeVisible();
  // A project opens by link too.
  await page.goto(`/#conversations?project=${known.projects['Docs site']}`);
  await expect(thread(page, 'Docs site')).toBeVisible();
  // Someone who has left isn't an error: the list shows, and the address drops them.
  await page.goto('/#conversations?agent=nobody-here');
  await expect.poll(() => new URL(page.url()).hash).toBe('#conversations');
});

test('Between agents is the screen it was, one tab over', async ({ page }) => {
  await page.goto('/#conversations');
  await page.getByRole('button', { name: 'Between agents' }).click();
  await expect(page.getByRole('button', { name: 'Between agents' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(page.url()).toContain('#conversations?tab=between');
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  await expect(page.getByTestId('convBody')).toBeVisible();
  await expect(page.getByRole('button', { name: 'All projects' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  await page.getByRole('button', { name: 'With you' }).click();
  await expect(page.getByRole('navigation', { name: 'Who to talk to' })).toBeVisible();
  // An agent's panel still opens a thread between agents, where it always did.
  await page.goto('/#office');
  await page.locator('.tag', { hasText: 'Ledger' }).first().click({ force: true });
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await panel.getByRole('button', { name: 'Conversations' }).click();
  await panel.locator('.btn.sm', { hasText: '·' }).first().click();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  expect(page.url()).toContain('tab=between');
});

test('the agent panel has an Open chat link', async ({ page, request }) => {
  const known = await ids(request);
  await page.goto(`/#office?agent=${known.agents.Bolt}`);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  const link = panel.getByRole('link', { name: 'Open chat' });
  await expect(link).toHaveAttribute('href', `#conversations?agent=${known.agents.Bolt}`);
  await link.click();
  await expect(thread(page, 'Bolt')).toBeVisible();
});

test('the thread shows what was said, one line for each tool call, and what it is doing now', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Bolt}`, 'Bolt');
  const messages = thread(page, 'Bolt');
  await expect(messages.getByTestId('chatYou').first()).toContainText('Run the full test suite');
  await expect(messages.getByTestId('chatAgent').first()).toContainText(
    "I'll look at what's there first",
  );
  // A tool call is one calm line with its state, open to what went in.
  const line = messages.getByTestId('chatTool').first();
  await expect(line).toContainText('read_file');
  await expect(line).toContainText('Done');
  const toggle = line.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const height = (await line.boundingBox())!.height;
  expect(height).toBeLessThan(40);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(line.locator('.mtooldetail')).toBeVisible();
  // What it is doing now is its own line, and says the step.
  await expect(page.getByTestId('doingNow')).toContainText('Running tests');
  // A message from the demo agent arrives live: send to it and the answer joins the thread.
  const before = await messages.getByTestId('chatAgent').count();
  await box(page, 'Bolt').fill('Also check the footer');
  await box(page, 'Bolt').press('Enter');
  await expect(box(page, 'Bolt')).toHaveValue('');
  await expect
    .poll(() => messages.getByTestId('chatAgent').count(), { timeout: 20_000 })
    .toBeGreaterThan(before);
});

test('an approval is answered in the thread, with a click, and nothing else answers it', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Atlas}`, 'Atlas');
  const card = thread(page, 'Atlas').getByTestId('chatApproval');
  await expect(card).toContainText('npm run db:migrate -- --env=staging');
  await expect(card).toContainText('Risky');
  await expect(card.locator('.chip.red').first()).toBeVisible();
  await expect(page.getByTestId('doingNow')).toHaveText('Waiting for your approval');
  // Typing "allow" is only a message: the approval is still waiting after it lands.
  await box(page, 'Atlas').fill('yes, allow it');
  await box(page, 'Atlas').press('Enter');
  await page.waitForTimeout(1500);
  await expect(card).toBeVisible();
  const state = async () =>
    (
      (await (await request.get('/api/snapshot')).json()) as {
        agents: { name: string; state: string }[];
      }
    ).agents.find((agent) => agent.name === 'Atlas')!.state;
  expect(await state()).toBe('approval');
  // The message waits, queued, and says so.
  await expect(thread(page, 'Atlas').getByTestId('chatPending')).toContainText(
    'Waiting for its next checkpoint',
  );
  await expect(page.getByTestId('deliveryNote')).toContainText('Atlas is waiting for you');
  // One click answers it.
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(state).not.toBe('approval');
});

test('a question is answered in the thread, and is not red', async ({ page, request }) => {
  const known = await ids(request);
  const id = known.agents.Pixel!;
  // The demo asks its question after half a minute, so this one is put in the snapshot.
  const question = {
    id: 'q-thread',
    agentId: id,
    time: Date.now(),
    items: [
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
  };
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { agents: { id: string; question?: unknown }[] };
    const pixel = snapshot.agents.find((agent) => agent.id === id);
    if (pixel) pixel.question = question;
    await route.fulfill({ response, json: snapshot });
  });
  const answered: unknown[] = [];
  await page.route(`**/api/agents/${id}/answer`, async (route) => {
    answered.push(route.request().postDataJSON());
    await route.fulfill({ json: { answered: true } });
  });
  await open(page, `#conversations?agent=${id}`, 'Pixel');
  const form = thread(page, 'Pixel').getByRole('form', { name: 'Pixel is asking you a question' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('One file, no server');
  await expect(page.getByTestId('doingNow')).toHaveText('Asking you a question');
  // Nothing about a question is red: not the card, not the list row, not the live line.
  await expect(form.locator('.red')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Who to talk to' })
      .getByRole('link', { name: /^Pixel/ })
      .locator('.chip.red'),
  ).toHaveCount(0);
  await expect(page.getByTestId('doingNow')).not.toHaveClass(/error/);
  const send = form.getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await form.getByRole('radio', { name: /SQLite/ }).check();
  await send.click();
  await expect.poll(() => answered.length).toBe(1);
  expect(answered[0]).toEqual({ questionId: 'q-thread', answers: [{ picked: [1], other: '' }] });
});

const HOSTILE = [
  '# Result <img src=x onerror="window.pwned=1">',
  '',
  'Open [the docs](https://example.com/docs) or [this](javascript:window.pwned=1) or [that](JaVaScRiPt:window.pwned=1)',
  'or [data](data:text/html,<script>window.pwned=1</script>) or ![tracker](https://tracker.example/pixel.png).',
  '',
  '<script>window.pwned=1</script> <iframe src="https://evil.example"></iframe> <b onclick="window.pwned=1">raw</b>',
  '',
  '```html',
  '<script>window.pwned=1</script>',
  '```',
  '',
  '- one **bold** and `code`',
  '  - nested',
  '',
  '| a | b |',
  '|---|---|',
  '| [x](vbscript:y) | 2 |',
  '',
  '> a quotation',
].join('\n');

function conversation(agentId: string, items: object[], hasMore = false) {
  return { agentId, items, hasMore };
}

function item(agentId: string, seq: number, kind: string, text: string, extra: object = {}) {
  return {
    id: `fake-${seq}`,
    agentId,
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    kind,
    text,
    streaming: false,
    tool: null,
    from: kind === 'user' ? 'mabari' : '',
    parent: '',
    clipped: false,
    ...extra,
  };
}

test('a hostile message is shown as text: no script, no image, no link that can run', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const known = await ids(request);
  const id = known.agents.Pixel!;
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const requested: string[] = [];
  page.on('request', (call) => requested.push(call.url()));
  await page.route(
    (url) => url.pathname === `/api/agents/${id}/conversation`,
    (route: Route) =>
      route.fulfill({
        json: conversation(id, [item(id, 1, 'user', 'show me'), item(id, 2, 'assistant', HOSTILE)]),
      }),
  );
  await open(page, `#conversations?agent=${id}`, 'Pixel');
  const reply = thread(page, 'Pixel').getByTestId('chatAgent').last();
  await expect(reply).toContainText('Result');
  // It is text: the tags are there as characters, and none of them became elements.
  await expect(reply).toContainText('<script>window.pwned=1</script>');
  await expect(reply).toContainText('<iframe src="https://evil.example"></iframe>');
  for (const selector of [
    'script',
    'iframe',
    'img',
    'object',
    'embed',
    'form',
    '[onerror]',
    '[onclick]',
    '[srcdoc]',
  ]) {
    await expect(reply.locator(selector), selector).toHaveCount(0);
  }
  const anchors = await reply.locator('a').evaluateAll((links) =>
    links.map((link) => ({
      href: (link as HTMLAnchorElement).href,
      rel: link.getAttribute('rel'),
      target: link.getAttribute('target'),
    })),
  );
  // Only addresses that were written out become links. The one inside the iframe's text is a link
  // too, which goes nowhere until it is clicked: the frame itself was never made.
  expect(anchors.map((link) => link.href).sort()).toEqual([
    'https://evil.example/',
    'https://example.com/docs',
    'https://tracker.example/pixel.png',
  ]);
  for (const link of anchors) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
  }
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  expect(dialogs).toEqual([]);
  // The picture was never fetched: it is only a link.
  expect(requested.filter((url) => url.includes('tracker.example'))).toEqual([]);
  // Real markdown still reads as markdown.
  await expect(reply.locator('strong')).toHaveText('bold');
  await expect(reply.locator('li code')).toHaveText('code');
  await expect(reply.locator('blockquote')).toContainText('a quotation');
  await expect(reply.locator('table th')).toHaveCount(2);
  // A code block has a Copy button that copies exactly the code.
  const block = reply.locator('.mdcode');
  await expect(block.locator('.mdlang')).toHaveText('html');
  await block.getByRole('button', { name: 'Copy this html block' }).click();
  await expect(page.locator('.toast').last()).toContainText('Code copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '<script>window.pwned=1</script>',
  );
});

test('a thread of thousands of messages draws a few at a time and scrolls without a stall', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const known = await ids(request);
  const id = known.agents.Pixel!;
  const total = 4000;
  const all = Array.from({ length: total }, (_, index) => {
    const seq = index + 1;
    if (seq % 5 === 0) {
      return item(id, seq, 'tool', '', {
        tool: {
          name: 'Read',
          summary: `Read file-${seq}.ts`,
          input: '{}',
          output: 'ok',
          state: 'done',
        },
      });
    }
    return seq % 2
      ? item(id, seq, 'user', `message ${seq}`)
      : item(id, seq, 'assistant', `**reply ${seq}**\n\nSome words about ${seq}.`);
  });
  let served = 0;
  await page.route(
    (url) => url.pathname === `/api/agents/${id}/conversation`,
    (route: Route) => {
      const before = Number(new URL(route.request().url()).searchParams.get('before') ?? Infinity);
      const older = all.filter((entry) => entry.seq < before);
      const page_ = older.slice(-500);
      served += page_.length;
      return route.fulfill({ json: conversation(id, page_, older.length > page_.length) });
    },
  );
  const started = Date.now();
  await open(page, `#conversations?agent=${id}`, 'Pixel');
  await expect(thread(page, 'Pixel').getByText(`Some words about ${total - 2}.`)).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);
  const drawn = () =>
    page.locator('[data-testid="thread"] > .mrow, [data-testid="thread"] > .mtool').count();
  // Of the 500 the page holds, only the newest rows are drawn.
  expect(await drawn()).toBeLessThanOrEqual(130);
  // One page of 500 was asked for (twice in development, where a page mounts its effects twice).
  expect(served).toBeGreaterThanOrEqual(500);
  expect(served).toBeLessThanOrEqual(1000);
  await expect(page.locator('.mearlier')).toBeVisible();
  // Asking for earlier ones draws more, and keeps what was in view where it was: the row at the
  // top of the screen stays there while the rows above it are added.
  // A plain selector from here on: working out roles and names for four thousand rows is slow.
  const pane = page.getByTestId('thread');
  const settle = async () => {
    let last = -1;
    for (let stable = 0; stable < 3;) {
      await page.waitForTimeout(300);
      const now = await drawn();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
    return last;
  };
  await pane.evaluate((element) => {
    element.scrollTop = 0;
  });
  const drawnBefore = await settle();
  // The first row that is on screen, and how far from the top of the thread it is.
  const topRow = await pane.evaluateHandle((element) => {
    const edge = element.getBoundingClientRect().top;
    return [...element.querySelectorAll(':scope > .mrow, :scope > .mtool')].find(
      (node) => node.getBoundingClientRect().bottom > edge + 4,
    )!;
  });
  const offset = () =>
    pane.evaluate(
      (element, node) =>
        (node as Element).getBoundingClientRect().y - element.getBoundingClientRect().y,
      topRow,
    );
  const before = await offset();
  const more = page.locator('.mearlier');
  if (await more.count()) await more.evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(drawn).toBeGreaterThan(drawnBefore);
  const drawnAfter = await settle();
  // More are drawn, not all of them: loading above is paced, whether it was a click or the top.
  expect(drawnAfter).toBeGreaterThan(drawnBefore);
  expect(drawnAfter).toBeLessThan(total);
  expect(Math.abs((await offset()) - before)).toBeLessThan(200);
  // Scrolling to the top keeps loading until everything is there, without the page hanging.
  for (let round = 0; round < 160; round++) {
    await pane.evaluate(async (element) => {
      element.scrollTop = 600;
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      element.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    if (!(await page.locator('.mearlier').count())) break;
  }
  await expect(pane.getByText('message 1', { exact: true })).toBeAttached();
  expect(served).toBeGreaterThanOrEqual(total - 1);
  // With all of it drawn, a scroll from the top to the bottom keeps frames short.
  const frames = await page.evaluate(async () => {
    const element = document.querySelector('[data-testid="thread"]')!;
    const times: number[] = [];
    let last = performance.now();
    const end = element.scrollHeight - element.clientHeight;
    for (let step = 0; step <= 60; step++) {
      element.scrollTop = (end * step) / 60;
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    return times;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  // Median frame under 50 ms and nothing over a second: a thread that stalls would fail both.
  expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(50);
  expect(sorted[sorted.length - 1]!).toBeLessThan(1000);
  // And the message box still takes typing at once.
  const typed = Date.now();
  await box(page, 'Pixel').fill('x'.repeat(2000));
  expect(Date.now() - typed).toBeLessThan(2000);
});

test('a project chat is the same thread, sent to the project, and each reply says who answered', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  const docs = known.projects['Docs site']!;
  // The card's Chat link opens it here, and the old drawer's address lands here too.
  await page.goto('/#projects');
  await page
    .locator('article', { hasText: 'Docs site' })
    .getByRole('link', { name: 'Chat' })
    .click();
  await expect(thread(page, 'Docs site')).toBeVisible();
  expect(page.url()).toContain(`#conversations?project=${docs}`);
  await expect(page.getByRole('complementary', { name: 'Chat with Docs site' })).toHaveCount(0);
  await page.goto(`/#projects?chat=${docs}`);
  await expect(thread(page, 'Docs site')).toBeVisible();
  expect(page.url()).toContain(`#conversations?project=${docs}`);
  // The same message box as an agent's: nothing is missing from it, and one thing is added.
  const form = page.getByRole('form', { name: 'Message Docs site' });
  const asked = await askable(request, 'Docs site');
  expect(asked).toBeGreaterThan(1);
  for (const name of ['Attach', 'Saved', 'Plan first', 'Hold to talk', `Ask everyone (${asked})`]) {
    await expect(form.getByRole('button', { name })).toBeVisible();
  }
  await expect(page.getByTestId('deliveryNote')).toContainText(
    'Mabari sends it to whoever on Docs site can take it',
  );
  // The thread holds the project's agents together, each reply with its agent's name.
  const replies = thread(page, 'Docs site').getByTestId('chatAgent');
  await expect(replies.first()).toBeVisible();
  const who = await replies.locator('.mwho').allTextContents();
  expect(new Set(who).size).toBeGreaterThan(1);
  // A message goes to the project and Mabari routes it.
  await box(page, 'Docs site').fill('Fix the typo in the install guide');
  await box(page, 'Docs site').press('Enter');
  const mine = thread(page, 'Docs site')
    .getByTestId('chatYou')
    .filter({ hasText: 'Fix the typo in the install guide' });
  await expect(
    mine.or(
      thread(page, 'Docs site').getByTestId('chatPending').filter({ hasText: 'Fix the typo' }),
    ),
  ).toHaveCount(1, { timeout: 15_000 });
  await expect(mine).toContainText(/ to \w+/, { timeout: 15_000 });
  // A reply shows who answered, as a link to their chat.
  await expect
    .poll(() => thread(page, 'Docs site').getByTestId('chatAgent').locator('.mwho').count(), {
      timeout: 20_000,
    })
    .toBeGreaterThan(who.length);
});

test('Hand to… sends a reply to another agent with where it came from', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Rune}`, 'Rune');
  const reply = thread(page, 'Rune').getByTestId('chatAgent').last();
  const trigger = reply.getByRole('button', { name: 'Hand to…' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: "Hand Rune's reply to…" });
  await expect(dialog).toBeVisible();
  // Not to itself, and focus is held in the dialog.
  await expect(dialog.getByRole('radio', { name: /^Rune/ })).toHaveCount(0);
  await dialog.getByRole('radio', { name: /Pixel/ }).check();
  await dialog.getByLabel('Add a note (optional)').fill('please review this');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('radio', { name: /Pixel/ }).check();
  await dialog.getByLabel('Add a note (optional)').fill('please review this');
  await dialog.getByRole('button', { name: 'Hand over' }).click();
  await expect(page.locator('.toast').last()).toContainText('Handed to Pixel.');
  await expect(thread(page, 'Rune').getByTestId('chatNotice').last()).toContainText(
    'Handed this reply to Pixel.',
  );
  // Pixel was sent it, and its thread says where it came from.
  await page
    .getByRole('navigation', { name: 'Who to talk to' })
    .getByRole('link', { name: /^Pixel/ })
    .click();
  const got = thread(page, 'Pixel').getByTestId('chatYou').last();
  await expect(got).toContainText('Handed over from Rune');
  await expect(got).toContainText('please review this');
});

test('Ask everyone puts one message to all the agents on a project and shows the replies side by side', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const known = await ids(request);
  const docs = known.projects['Docs site']!;
  await open(page, `#conversations?project=${docs}`, 'Docs site');
  await box(page, 'Docs site').fill('status in one line?');
  const asked = await askable(request, 'Docs site');
  await page.getByRole('button', { name: `Ask everyone (${asked})` }).click();
  const round = thread(page, 'Docs site').getByTestId('chatRound');
  await expect(round).toBeVisible();
  await expect(round).toContainText('status in one line?');
  await expect(round).toContainText('Asked everyone');
  const columns = round.locator('.mcol');
  await expect(columns).toHaveCount(asked);
  // Side by side: in one row, left to right.
  const boxes = await columns.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y, width } = node.getBoundingClientRect();
      return { x, y, width };
    }),
  );
  expect(
    Math.max(...boxes.map((entry) => entry.y)) - Math.min(...boxes.map((entry) => entry.y)),
  ).toBeLessThan(4);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 2);
  if (boxes[2]) expect(boxes[2].x).toBeGreaterThan(boxes[1]!.x + boxes[1]!.width - 2);
  // Replies come in, each in its agent's column, and the message isn't repeated in the thread.
  await expect
    .poll(() => round.locator('.mcol .mcolbody').count(), { timeout: 40_000 })
    .toBeGreaterThan(0);
  await expect(
    thread(page, 'Docs site').getByTestId('chatYou').filter({ hasText: 'status in one line?' }),
  ).toHaveCount(0);
  await expect(round.getByRole('link', { name: 'Docs site' })).toHaveCount(0);
  // It is still there after a reload.
  await page.reload();
  await expect(thread(page, 'Docs site').getByTestId('chatRound')).toContainText(
    'status in one line?',
  );
  await expect(thread(page, 'Docs site').getByTestId('chatRound').locator('.mcol')).toHaveCount(
    asked,
  );
});

test('Up brings back what was sent, and the draft comes back after', async ({ page, request }) => {
  test.setTimeout(60_000);
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Pixel}`, 'Pixel');
  const field = box(page, 'Pixel');
  for (const text of ['first note', 'second note']) {
    await field.fill(text);
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(
      thread(page, 'Pixel').getByTestId('chatYou').filter({ hasText: text }),
    ).toHaveCount(1);
  }
  await field.focus();
  await field.press('ArrowUp');
  await expect(field).toHaveValue('second note');
  await field.press('ArrowUp');
  await expect(field).toHaveValue('first note');
  await field.press('ArrowDown');
  await expect(field).toHaveValue('second note');
  await field.press('ArrowDown');
  await expect(field).toHaveValue('');
  // Up never takes the arrow from someone writing.
  await field.fill('half a thought');
  await field.press('ArrowUp');
  await expect(field).toHaveValue('half a thought');
  await field.fill('');
  // What was sent is read from the conversation, so it comes back after a reload.
  await page.reload();
  await box(page, 'Pixel').focus();
  await box(page, 'Pixel').press('ArrowUp');
  await expect(box(page, 'Pixel')).toHaveValue('second note');
});

test('a message can be saved as an instruction, found with a slash, and deleted', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Pixel}`, 'Pixel');
  const name = `Risk summary ${Date.now()}`;
  const field = box(page, 'Pixel');
  try {
    await field.fill('Summarise the open risks in one line');
    await field.press('Enter');
    const sent = thread(page, 'Pixel')
      .getByTestId('chatYou')
      .filter({ hasText: 'Summarise the open risks' });
    await expect(sent).toHaveCount(1);
    await sent.getByRole('button', { name: 'Save as instruction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save as an instruction' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast').last()).toContainText('Saved.');
    // A name already taken says so, in the dialog.
    await sent.getByRole('button', { name: 'Save as instruction' }).click();
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toContainText('already have an instruction');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // A slash lists it, with the commands, and choosing it puts its words in the box.
    await field.focus();
    await field.pressSequentially('/Risk');
    await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible();
    await field.press('Enter');
    await expect(field).toHaveValue('Summarise the open risks in one line');
    await field.fill('');
    // The Saved list shows it, and deleting takes it out of the slash list.
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    const saved = page.getByRole('dialog', { name: 'Saved instructions' });
    await expect(saved).toContainText(name);
    await saved.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(saved).not.toContainText(name);
    await saved.getByRole('button', { name: 'Close' }).click();
    await field.pressSequentially('/Risk');
    await expect(page.getByRole('option', { name: new RegExp(name) })).toHaveCount(0);
  } finally {
    // Saved instructions outlive a wipe, so none is left behind for another test.
    const left = (await (await request.get('/api/saved-instructions')).json()) as {
      id: string;
      name: string;
    }[];
    for (const entry of left.filter((one) => one.name === name))
      await request.delete(`/api/saved-instructions/${entry.id}`);
  }
});

test('@ pulls in another agent’s latest reply, and Plan first asks for a plan first', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Pixel}`, 'Pixel');
  const field = box(page, 'Pixel');
  await field.click();
  await field.pressSequentially('@Ru');
  const option = page.getByRole('option', { name: /@Rune/ });
  await expect(option).toContainText("Add Rune's latest reply");
  await field.press('Enter');
  await expect(field).toHaveValue('@Rune ');
  await field.pressSequentially('what do you make of that?');
  await page.getByRole('button', { name: 'Plan first' }).click();
  await expect(page.getByTestId('deliveryNote')).toContainText('request, not a lock');
  await field.press('Enter');
  const sent = thread(page, 'Pixel')
    .getByTestId('chatYou')
    .filter({ hasText: 'what do you make of that?' });
  await expect(sent).toHaveCount(1);
  // The additions are shown apart from the words: a chip, and the reply folded away.
  await expect(sent.locator('.chip', { hasText: 'Plan first' })).toBeVisible();
  const context = sent.locator('details');
  await expect(context).toContainText("Included Rune's latest reply");
  await context.locator('summary').click();
  await expect(context.locator('p')).not.toBeEmpty();
  await expect(sent.locator('.mtext')).toHaveText('@Rune what do you make of that?');
  // The agent really got the whole thing.
  const items = (await (
    await request.get(`/api/agents/${known.agents.Pixel}/conversation`)
  ).json()) as {
    items: { kind: string; text: string }[];
  };
  const got = items.items.filter((entry) => entry.kind === 'user').at(-1)!.text;
  expect(got.startsWith('Plan first.')).toBe(true);
  expect(got).toContain("Context, Rune's latest reply:");
});

test('a demo agent can have its model switched with a message', async ({ page, request }) => {
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Pixel}`, 'Pixel');
  const model = page.getByLabel('Model for this message');
  await expect(model).toBeEnabled();
  const current = await model.inputValue();
  const options = await model.locator('option').allTextContents();
  const other = options.find((entry) => entry !== current)!;
  await model.selectOption(other);
  await box(page, 'Pixel').fill('carry on');
  await box(page, 'Pixel').press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Pixel' }).locator('..')).toContainText(
    other,
    { timeout: 10_000 },
  );
  await expect(model).toHaveValue(other);
});

test('a queued message waits in the thread, amber, and can be taken back', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Sage}`, 'Sage');
  // The demo's Sage already has one waiting.
  const pending = thread(page, 'Sage').getByTestId('chatPending').first();
  await expect(pending).toContainText('Also add a changelog entry');
  await expect(pending).toContainText('Waiting for its next checkpoint');
  await expect(page.getByTestId('chatSend')).toHaveText('Queue');
  await expect(page.getByTestId('deliveryNote')).toContainText(
    'Sage is working. This is queued and read at its next checkpoint.',
  );
  await pending.getByRole('button', { name: /^Remove “Also add a changelog entry/ }).click();
  await expect(thread(page, 'Sage').getByTestId('chatPending')).toHaveCount(0);
});

test('the mic puts what it hears in the box, to read before it is sent', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    class FakeSpeech {
      declare processLocally: boolean;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { say: (text: string) => void }).say = (text) =>
          this.onresult?.({ results: [[{ transcript: text }]] });
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    FakeSpeech.prototype.processLocally = false;
    Object.assign(window, { SpeechRecognition: FakeSpeech });
  });
  const known = await ids(request);
  await open(page, `#conversations?agent=${known.agents.Pixel}`, 'Pixel');
  const mic = page.getByRole('button', { name: 'Hold to talk' });
  await mic.hover();
  await page.mouse.down();
  await expect(page.locator('#vTitle')).toHaveText('Listening… take your time, release when done');
  await page.evaluate(() =>
    (window as unknown as { say: (text: string) => void }).say('check the footer spacing'),
  );
  await expect(page.locator('#vText')).toContainText('check the footer spacing');
  await page.mouse.up();
  await expect(page.locator('.voice')).toContainText('Goes into the message box');
  await page.locator('.voice').getByRole('button', { name: 'Use' }).click();
  await expect(box(page, 'Pixel')).toHaveValue('check the footer spacing');
  // Nothing was sent: it waits for the Send button.
  await expect(
    thread(page, 'Pixel').getByTestId('chatYou').filter({ hasText: 'check the footer spacing' }),
  ).toHaveCount(0);
});

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n    ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join('\n    ')}`,
  );
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 1024, 390]) {
    test(`Chats passes the accessibility checks in the ${theme} theme at ${width} px`, async ({
      page,
      request,
    }) => {
      test.setTimeout(90_000);
      const known = await ids(request);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const found: string[] = [];
      const check = async (label: string) => {
        for (const problem of await violations(page)) found.push(`${label}: ${problem}`);
      };
      // The list, and at 390 the list alone.
      await page.goto('/#conversations');
      await expect(page.getByRole('navigation', { name: 'Who to talk to' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await check('the list');
      // An agent's thread, with its approval and its message box.
      await page.goto(`/#conversations?agent=${known.agents.Atlas}`);
      await expect(thread(page, 'Atlas').getByTestId('chatApproval')).toBeVisible();
      await check('an agent thread with an approval');
      // A project's thread, with a round of replies.
      await page.goto(`/#conversations?project=${known.projects['Docs site']}`);
      await expect(thread(page, 'Docs site')).toBeVisible();
      const ask = page.getByRole('button', { name: /Ask everyone/ });
      // Typed until it takes: a page that has only just opened the thread can drop the first try.
      await expect(async () => {
        await box(page, 'Docs site').fill('one line please', { timeout: 3000 });
        await expect(ask).toBeEnabled({ timeout: 1000 });
      }).toPass({ timeout: 20_000 });
      await ask.click();
      await expect(thread(page, 'Docs site').getByTestId('chatRound')).toBeVisible();
      await check('a project thread with a round');
      // Between agents.
      await page.goto('/#conversations?tab=between');
      await expect(page.getByLabel('Search conversations')).toBeVisible();
      await check('between agents');
      expect(found, found.join('\n')).toEqual([]);
      // Nothing scrolls sideways, and the page's controls can be reached.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}

test('at 390 px the list and the thread take turns, and Send can be clicked', async ({
  page,
  request,
}) => {
  const known = await ids(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#conversations');
  await expect(page.getByRole('navigation', { name: 'Who to talk to' })).toBeVisible();
  await expect(page.getByRole('log', { name: /^Messages with/ })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Who to talk to' })
    .getByRole('link', { name: /^Pixel/ })
    .click();
  await expect(thread(page, 'Pixel')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Who to talk to' })).toBeHidden();
  await box(page, 'Pixel').fill('hello');
  const send = page.getByTestId('chatSend');
  const { x, y, width, height } = (await send.boundingBox())!;
  const topmost = await page.evaluate(
    ([px, py]) =>
      document.elementFromPoint(px!, py!)?.closest('[data-testid]')?.getAttribute('data-testid'),
    [x + width / 2, y + height / 2],
  );
  expect(topmost).toBe('chatSend');
  await page.getByRole('link', { name: 'All chats' }).click();
  await expect(page.getByRole('navigation', { name: 'Who to talk to' })).toBeVisible();
  expect(page.url()).toContain(`#conversations`);
  expect(known.agents.Pixel).toBeTruthy();
});
