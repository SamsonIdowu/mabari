// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Review the work: what an agent or a project changed in its folder, read by the server with Git,
// shown as a diff, with comments that go to the agent and a second opinion from another one.
// Real agents come from the hub API, with a real repository in a throwaway folder as their folder.

const apiPort = process.env.MABARI_API_PORT ?? '4327';
const hubUrl = `http://127.0.0.1:${apiPort}/hub/v1`;

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

function write(dir: string, name: string, text: string) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
}

const made: string[] = [];

/** A repository with an edited file, a new one and a deleted one: the changes an agent might leave. */
function repoWithChanges(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mabari-review-')));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/app.ts', 'one\ntwo\nthree\n');
  write(dir, 'old.txt', 'bye\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  write(dir, 'src/app.ts', 'one\nTWO\nthree\nfour\n');
  write(dir, 'new.txt', 'fresh\n');
  rmSync(join(dir, 'old.txt'));
  return dir;
}

test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function hubToken(request: APIRequestContext): Promise<string> {
  const { token } = (await (await request.post('/api/accounts/hub/token')).json()) as {
    token: string;
  };
  return token;
}

/** Seats an agent that reports to the hub, working in `folder`. */
async function seat(
  request: APIRequestContext,
  token: string,
  agent: string,
  name: string,
  folder: string,
) {
  const seated = await request.post(`${hubUrl}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { agent, name, state: 'editing', task: `Work on ${name}'s part`, folder },
  });
  expect(seated.status(), await seated.text()).toBe(200);
}

/** What the app would collect: each instruction once, as the agent gets it. */
async function collect(
  request: APIRequestContext,
  token: string,
  agent: string,
): Promise<string[]> {
  const got = await request.get(`${hubUrl}/agents/${agent}/instructions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ((await got.json()) as { instructions: string[] }).instructions;
}

async function idOf(request: APIRequestContext, name: string): Promise<string> {
  const office = (await (await request.get('/api/snapshot')).json()) as {
    agents: { id: string; name: string }[];
  };
  const found = office.agents.find((agent) => agent.name === name);
  if (!found) throw new Error(`no agent called ${name}`);
  return found.id;
}

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
}

/** Opens an agent's panel from its link, then its Changes. */
async function openChanges(page: Page, request: APIRequestContext, name: string) {
  const id = await idOf(request, name);
  await page.goto(`/#office?agent=${id}`);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  // An agent waiting on approval opens its card first.
  const card = page.getByRole('dialog', { name: /approval|Review/i });
  if (await card.isVisible().catch(() => false))
    await card.getByRole('button', { name: 'Close' }).click();
  await panel.getByRole('button', { name: 'Changes' }).click();
  const dialog = page.getByRole('dialog', { name: `Changes by ${name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Picks the agent whose name starts with `name` to give a second opinion. */
async function chooseReviewer(dialog: Locator, name: string) {
  const reviewers = dialog.getByRole('combobox', { name: 'Second opinion from' });
  const label = await reviewers
    .locator('option', { hasText: new RegExp(`^${name}`) })
    .first()
    .textContent();
  await reviewers.selectOption({ label: label ?? '' });
}

/** The first row of the diff holding this text, matched exactly: a plain string would ignore case. */
const row = (dialog: Locator, text: string) =>
  dialog
    .locator('tr.chl', {
      has: dialog
        .page()
        .locator('code', { hasText: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }),
    })
    .first();

async function comment(dialog: Locator, text: string, words: string) {
  await row(dialog, text)
    .getByRole('button', { name: /^Comment on/ })
    .click();
  const box = dialog.getByRole('textbox', { name: /^Comment on/ });
  await expect(box).toBeFocused();
  await box.fill(words);
  await dialog.getByRole('button', { name: 'Add comment' }).click();
}

test('the demo office has changes to review, made up and marked as made up', async ({
  page,
  request,
}) => {
  await demo(page);
  const dialog = await openChanges(page, request, 'Ledger');
  await expect(dialog.getByTestId('changesDemo')).toHaveText('Demo');
  await expect(dialog).toContainText('made up to show how the view works');
  await expect(dialog.getByRole('heading', { name: /Changes by Ledger/ })).toBeVisible();

  // The files, with true counts, and each file's change in the diff style.
  const files = dialog.getByRole('navigation', { name: 'Changed files' });
  await expect(files.getByRole('listitem')).toHaveCount(3);
  await expect(files).toContainText('totals.ts');
  const added = dialog.locator('tr.chl.add', { hasText: 'return adjustTotals(sum);' });
  await expect(added).toHaveCount(1);
  const totals = dialog.getByRole('region', { name: 'Changes in src/billing/totals.ts' });
  await expect(
    totals.locator('tr.chl.del', { hasText: 'sum += line.price * line.quantity;' }),
  ).toHaveCount(1);
  const summary = dialog.locator('.chsub');
  const lines = await dialog.locator('tr.chl.add').count();
  const removed = await dialog.locator('tr.chl.del').count();
  await expect(summary).toContainText(`+${lines}`);
  await expect(summary).toContainText(`−${removed}`);
  await expect(summary).toContainText('3 files');
  // Nothing in the diff can be changed from here: there is no commit, push or discard anywhere.
  for (const word of ['Commit', 'Push', 'Checkout', 'Discard changes', 'Revert']) {
    await expect(dialog.getByRole('button', { name: new RegExp(`^${word}`) })).toHaveCount(0);
  }
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  // Focus goes back to the button that opened it.
  await expect(
    page
      .getByRole('complementary', { name: 'Agent details' })
      .getByRole('button', { name: 'Changes' }),
  ).toBeFocused();
});

test('comments on lines go to the agent as one review, with the file and the line', async ({
  page,
  request,
}) => {
  await demo(page);
  const dialog = await openChanges(page, request, 'Ledger');
  await comment(
    dialog,
    'if (line.quantity <= 0) continue;',
    'Skip empty lines in the invoice too.',
  );
  await expect(dialog.getByTestId('reviewComment')).toContainText(
    'Skip empty lines in the invoice too.',
  );
  // A comment can be on a line that was removed.
  await comment(
    dialog,
    'sum += line.price * line.quantity;',
    'Why drop the plain sum?\nKeep a test for it.',
  );
  await expect(dialog.getByTestId('reviewCount')).toHaveText('2 comments');
  // The list says which file has comments.
  await expect(dialog.getByRole('navigation', { name: 'Changed files' })).toContainText(
    '2 comments',
  );

  const before = (await (await request.get('/api/activity')).json()) as { message: string }[];
  await dialog.getByRole('button', { name: 'Send review to Ledger' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Sent your 2 comments to Ledger.' }),
  ).toBeVisible();
  await expect(dialog.getByTestId('reviewCount')).toHaveCount(0);
  await expect(dialog.getByTestId('reviewComment')).toHaveCount(0);

  // One instruction went out, and it names each file and line, quotes the code and keeps both comments.
  const after = (await (await request.get('/api/activity')).json()) as {
    message: string;
    type: string;
  }[];
  const sent = after.filter((entry) => entry.message.startsWith('Review of the changes in'));
  expect(
    sent.length -
      before.filter((entry) => entry.message.startsWith('Review of the changes in')).length,
  ).toBe(1);
  const [text] = sent.map((entry) => entry.message);
  expect(text).toContain('Review of the changes in ~/code/shop. 2 comments:');
  expect(text).toMatch(
    /1\. src\/billing\/totals\.ts, line \d+ \(`if \(line\.quantity <= 0\) continue;`\): Skip empty lines/,
  );
  expect(text).toMatch(
    /2\. src\/billing\/totals\.ts, line \d+ of the old version \(removed: `sum \+= line\.price \* line\.quantity;`\): Why drop the plain sum\?\n {3}Keep a test for it\./,
  );
});

test('a single comment goes as a sentence, and a discarded review sends nothing', async ({
  page,
  request,
}) => {
  await demo(page);
  const dialog = await openChanges(page, request, 'Ledger');
  await comment(dialog, 'return adjustTotals(sum);', 'Name the discount in a constant.');
  await dialog.getByRole('button', { name: 'Send comment to Ledger' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Sent your comment to Ledger.' }),
  ).toBeVisible();
  const log = (await (await request.get('/api/activity')).json()) as { message: string }[];
  expect(log.map((entry) => entry.message)).toContain(
    'Review comment on src/billing/totals.ts, line 19 (`return adjustTotals(sum);`): Name the discount in a constant.',
  );

  await comment(dialog, 'return adjustTotals(sum);', 'This one is thrown away.');
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog.getByTestId('reviewCount')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Send (comment|review)/ })).toBeDisabled();
});

test('a second opinion sends the changes to another agent, whose answer shows in the view and its panel', async ({
  page,
  request,
}) => {
  await demo(page);
  const dialog = await openChanges(page, request, 'Ledger');
  const ask = dialog.getByRole('button', { name: 'Ask for a second opinion' });
  await expect(ask).toBeDisabled();
  const reviewers = dialog.getByRole('combobox', { name: 'Second opinion from' });
  // Not the agent whose changes these are.
  await expect(reviewers.locator('option', { hasText: /^Ledger/ })).toHaveCount(0);
  await chooseReviewer(dialog, 'Scout');
  await ask.click();
  const opinions = dialog.getByRole('region', { name: 'Second opinions' });
  await expect(opinions).toContainText('Scout');
  // It is an ordinary instruction: it waits for a checkpoint or is delivered, and Scout answers.
  await expect(opinions.locator('.chip').first()).toHaveText(
    /Waiting for its next checkpoint|Delivered|Replied/,
  );
  await expect(opinions.getByTestId('opinionReply')).toContainText('Got it', { timeout: 40_000 });
  await expect(opinions.locator('.chip.ok')).toHaveText('Replied');
  // The same reply is in Scout's own panel.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.goto(`/#office?agent=${await idOf(request, 'Scout')}`);
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByTestId('agentReply').first()).toContainText('Got it');
});

test('a second opinion can never settle an approval', async ({ page, request }) => {
  await demo(page);
  const pending = async () =>
    ((await (await request.get('/api/approvals?pending=1')).json()) as { id: string }[]).map(
      (item) => item.id,
    );
  const before = await pending();
  expect(before.length).toBeGreaterThan(0);
  const dialog = await openChanges(page, request, 'Ledger');
  await chooseReviewer(dialog, 'Atlas');
  await dialog.getByRole('button', { name: 'Ask for a second opinion' }).click();
  await expect(dialog.getByRole('region', { name: 'Second opinions' })).toContainText(
    'Waiting for its next checkpoint',
  );
  expect(await pending()).toEqual(before);
  const settings = (await (await request.get('/api/settings')).json()) as {
    autoApprove: { on: boolean };
  };
  expect(settings.autoApprove.on).toBe(false);
});

test('a real agent shows the real changes in its folder, and they stay live', async ({
  page,
  request,
}) => {
  const repo = repoWithChanges();
  const token = await hubToken(request);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Worker');
  await expect(dialog.getByTestId('changesDemo')).toHaveCount(0);
  await expect(dialog.locator('.chsub')).toContainText('3 files');
  await expect(dialog.locator('.chsub')).toContainText('+3');
  await expect(dialog.locator('.chsub')).toContainText('−2');
  await expect(dialog.locator('.chsub .mono').first()).toHaveText('main');
  await expect(dialog.locator('.chfolder')).toHaveText(repo);

  const files = dialog.getByRole('navigation', { name: 'Changed files' });
  await expect(files.getByRole('listitem')).toHaveCount(3);
  await expect(files.getByRole('listitem').filter({ hasText: 'new.txt' })).toContainText('New');
  await expect(files.getByRole('listitem').filter({ hasText: 'old.txt' })).toContainText('Deleted');
  await expect(files.getByRole('listitem').filter({ hasText: 'app.ts' })).toContainText('Modified');
  await expect(dialog.locator('tr.chl.del', { hasText: 'two' })).toHaveCount(1);
  await expect(dialog.locator('tr.chl.add', { hasText: 'TWO' })).toHaveCount(1);

  // The agent keeps working: the next lines show up without reloading anything.
  appendFileSync(join(repo, 'src/app.ts'), 'five\nsix\n');
  await expect(dialog.locator('tr.chl.add', { hasText: 'six' })).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(dialog.locator('.chsub')).toContainText('+5');
  write(repo, 'brand-new.txt', 'just made\n');
  await expect(files.getByRole('listitem')).toHaveCount(4, { timeout: 15_000 });

  // The comment becomes an instruction to this agent, as the agent collects it.
  await comment(dialog, 'TWO', 'Keep the lower case spelling.');
  await dialog.getByRole('button', { name: 'Send comment to Worker' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Sent your comment to Worker.' }),
  ).toBeVisible();
  const got = await collect(request, token, 'review-worker');
  expect(got).toEqual([
    'Review comment on src/app.ts, line 2 (`TWO`): Keep the lower case spelling.',
  ]);
});

test('the diff goes to a chosen agent in full, with secrets masked, and its place in the queue shows', async ({
  page,
  request,
}) => {
  const repo = repoWithChanges();
  write(repo, 'config.env', 'API_KEY=sk-ant-api03-abcdefghijklmnop\nPORT=80\n');
  const token = await hubToken(request);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await seat(
    request,
    token,
    'review-checker',
    'Checker',
    mkdtempSync(join(tmpdir(), 'mabari-checker-')),
  );
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Worker');
  await expect(dialog.locator('tr.chl.add', { hasText: 'PORT=80' })).toHaveCount(1);
  // The page never has the secret either.
  await expect(dialog).not.toContainText('sk-ant-api03-abcdefghijklmnop');
  await expect(dialog.locator('tr.chl.add', { hasText: 'API_KEY=[redacted]' })).toHaveCount(1);

  await chooseReviewer(dialog, 'Checker');
  await dialog.getByRole('button', { name: 'Ask for a second opinion' }).click();
  const opinions = dialog.getByRole('region', { name: 'Second opinions' });
  await expect(opinions).toContainText('Waiting for its next checkpoint');

  // The reviewer collects it as it would any instruction: the diff, whole, and no secret in it.
  const [text] = await collect(request, token, 'review-checker');
  expect(text).toContain(
    `Second opinion wanted: review the changes Worker made in ${repo} (4 files, +5 -2).`,
  );
  expect(text).toContain('--- src/app.ts (modified, +2 -1)');
  expect(text).toContain('-two\n+TWO');
  expect(text).toContain('--- old.txt (deleted, +0 -1)');
  expect(text).toContain('API_KEY=[redacted]');
  expect(text).not.toContain('sk-ant-api03-abcdefghijklmnop');
  await expect(opinions).toContainText('Delivered, no reply yet');
});

test('a folder that is not a repository, or is gone, says so', async ({ page, request }) => {
  const token = await hubToken(request);
  const plain = mkdtempSync(join(tmpdir(), 'mabari-plain-'));
  made.push(plain);
  await seat(request, token, 'review-plain', 'Plain', plain);
  await seat(request, token, 'review-gone', 'Gone', join(plain, 'not-there'));
  await seat(request, token, 'review-none', 'Nowhere', '');
  await page.goto('/#home');
  const notRepo = await openChanges(page, request, 'Plain');
  await expect(notRepo.getByTestId('changesProblem')).toContainText("isn't a Git repository");
  await expect(notRepo.getByRole('button', { name: 'Ask for a second opinion' })).toBeDisabled();
  await notRepo.getByRole('button', { name: 'Close' }).click();
  const gone = await openChanges(page, request, 'Gone');
  await expect(gone.getByTestId('changesProblem')).toContainText('There is no folder at');
  await gone.getByRole('button', { name: 'Close' }).click();
  const none = await openChanges(page, request, 'Nowhere');
  await expect(none.getByTestId('changesProblem')).toContainText("doesn't know which folder");
});

test('a clean folder says nothing has changed', async ({ page, request }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'mabari-clean-')));
  made.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'a.txt', 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const token = await hubToken(request);
  await seat(request, token, 'review-clean', 'Tidy', repo);
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Tidy');
  await expect(dialog.getByTestId('changesEmpty')).toContainText('Nothing has changed');
  // And the moment something changes, it shows without reloading.
  write(repo, 'a.txt', 'one\ntwo\n');
  await expect(dialog.locator('tr.chl.add', { hasText: 'two' })).toHaveCount(1, {
    timeout: 15_000,
  });
});

test('a project card has Changes too, for its folder or its agents', async ({ page, request }) => {
  await demo(page);
  await page.goto('/#projects');
  const card = page.locator('article.card', { hasText: 'Checkout revamp' }).first();
  await card.getByRole('button', { name: 'Changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Changes in Checkout revamp' });
  await expect(dialog.getByTestId('changesDemo')).toBeVisible();
  // Every agent's files in one list.
  const listed = dialog.getByRole('navigation', { name: 'Changed files' }).getByRole('listitem');
  await expect.poll(() => listed.count()).toBeGreaterThanOrEqual(6);
  await comment(dialog, 'return adjustTotals(sum);', 'Project wide: no magic numbers.');
  await dialog.getByRole('button', { name: 'Send comment to the Checkout revamp team' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Sent your comment to the Checkout revamp team.',
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByRole('button', { name: 'Changes' })).toBeFocused();

  // A project with a real folder shows that folder.
  const repo = repoWithChanges();
  const project = (await (
    await request.post('/api/projects', { data: { name: 'Real shop', color: '#48DBFB' } })
  ).json()) as { id: string };
  const attached = await request.patch(`/api/projects/${project.id}`, { data: { folder: repo } });
  expect(attached.status(), await attached.text()).toBe(200);
  await page.goto('/#projects');
  await page
    .locator('article.card', { hasText: 'Real shop' })
    .getByRole('button', { name: 'Changes' })
    .click();
  const real = page.getByRole('dialog', { name: 'Changes in Real shop' });
  await expect(
    real.getByRole('navigation', { name: 'Changed files' }).getByRole('listitem'),
  ).toHaveCount(3);
  await expect(real.getByTestId('changesDemo')).toHaveCount(0);
});

test('a project whose agents work in different folders asks for one folder, and shows none', async ({
  page,
  request,
}) => {
  const token = await hubToken(request);
  const repo = repoWithChanges();
  const other = mkdtempSync(join(tmpdir(), 'mabari-other-'));
  made.push(other);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await seat(request, token, 'review-other', 'Other', other);
  const project = (await (
    await request.post('/api/projects', { data: { name: 'Split shop', color: '#FF6B9A' } })
  ).json()) as { id: string };
  for (const name of ['Worker', 'Other']) {
    const id = await idOf(request, name);
    const placed = await request.patch(`/api/agents/${id}`, { data: { projectId: project.id } });
    expect(placed.status(), await placed.text()).toBe(200);
  }
  await page.goto('/#projects');
  await page
    .locator('article.card', { hasText: 'Split shop' })
    .getByRole('button', { name: 'Changes' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Changes in Split shop' });
  await expect(dialog.getByTestId('changesProblem')).toContainText('work in different folders');
  await expect(dialog.getByTestId('changesProblem')).toContainText('Attach one folder');
  await expect(dialog.getByRole('navigation', { name: 'Changed files' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Ask for a second opinion' })).toBeDisabled();
});

test('a comment on a line the agent has since changed is kept apart, and still goes out', async ({
  page,
  request,
}) => {
  const repo = repoWithChanges();
  const token = await hubToken(request);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Worker');
  await comment(dialog, 'TWO', 'Keep the lower case spelling.');
  await expect(dialog.getByTestId('orphanComments')).toHaveCount(0);
  // The agent rewrites that very line.
  write(repo, 'src/app.ts', 'one\nsomething else\nthree\nfour\n');
  const apart = dialog.getByTestId('orphanComments');
  await expect(apart).toContainText('Keep the lower case spelling.', { timeout: 15_000 });
  await expect(apart).toContainText('src/app.ts, line 2');
  await expect(dialog.getByTestId('reviewCount')).toHaveText('1 comment');
  // It still goes with the review, as it was written.
  await dialog.getByRole('button', { name: 'Send comment to Worker' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Sent your comment to Worker.' }),
  ).toBeVisible();
  expect(await collect(request, token, 'review-worker')).toEqual([
    'Review comment on src/app.ts, line 2 (`TWO`): Keep the lower case spelling.',
  ]);
  await expect(apart).toHaveCount(0);

  // One that is taken back before sending isn't sent.
  await comment(dialog, 'something else', 'Another thought.');
  write(repo, 'src/app.ts', 'one\nchanged again\nthree\nfour\n');
  await expect(apart).toContainText('Another thought.', { timeout: 15_000 });
  await apart.getByRole('button', { name: /^Remove your comment/ }).click();
  await expect(apart).toHaveCount(0);
  await expect(dialog.getByTestId('reviewCount')).toHaveCount(0);
});

test('the keyboard does it all: lines, comments, Escape, and back to where it was', async ({
  page,
  request,
}) => {
  const repo = repoWithChanges();
  const token = await hubToken(request);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Worker');
  const code = dialog.getByRole('region', { name: 'Changes in src/app.ts' });
  await expect(code).toBeVisible();
  // The region scrolls, so it is a stop of its own; a diff has one tab stop for its lines.
  await code.focus();
  await page.keyboard.press('Tab');
  const first = code.getByRole('button', { name: /^Comment on/ }).first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const third = code.getByRole('button', { name: /^Comment on/ }).nth(2);
  await expect(third).toBeFocused();
  await page.keyboard.press('Enter');
  const box = dialog.getByRole('textbox', { name: /^Comment on/ });
  await expect(box).toBeFocused();
  await box.fill('Typed with the keyboard');
  // Escape closes the comment being written first, not the view, and focus returns to the line.
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(third).toBeFocused();
  await page.keyboard.press('Enter');
  await dialog.getByRole('textbox', { name: /^Comment on/ }).fill('Sent with the keyboard');
  await page.keyboard.press('Control+Enter');
  await expect(dialog.getByTestId('reviewComment')).toContainText('Sent with the keyboard');
  await expect(third).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole('complementary', { name: 'Agent details' })
      .getByRole('button', { name: 'Changes' }),
  ).toBeFocused();
});

test('a comment that cannot be sent stays, with the reason, and sending can be tried again', async ({
  page,
  request,
}) => {
  const repo = repoWithChanges();
  const token = await hubToken(request);
  await seat(request, token, 'review-worker', 'Worker', repo);
  await page.goto('/#home');
  const dialog = await openChanges(page, request, 'Worker');
  await comment(dialog, 'TWO', 'Try again later.');
  await page.route('**/api/messages', (route) => route.abort());
  await dialog.getByRole('button', { name: 'Send comment to Worker' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    "Can't reach Mabari. Your message was not sent.",
  );
  await expect(dialog.getByTestId('reviewCount')).toHaveText('1 comment');
  await page.unroute('**/api/messages');
  await dialog.getByRole('button', { name: 'Send comment to Worker' }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Sent your comment to Worker.' }),
  ).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the review view passes the accessibility checks in the ${theme} theme`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
    const repo = repoWithChanges();
    write(repo, 'long.txt', `${'a long line '.repeat(40)}\n`);
    const token = await hubToken(request);
    await seat(request, token, 'review-worker', 'Worker', repo);
    await seat(request, token, 'review-checker', 'Checker', repo);
    await page.goto('/#home');
    const dialog = await openChanges(page, request, 'Worker');
    await comment(dialog, 'TWO', 'A comment, so a comment card is on the page.');
    await chooseReviewer(dialog, 'Checker');
    await dialog.getByRole('button', { name: 'Ask for a second opinion' }).click();
    await expect(dialog.getByRole('region', { name: 'Second opinions' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Comment on line 1' }).first().click();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const found = results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help}\n  ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join('\n  ')}`,
    );
    expect(found, found.join('\n')).toEqual([]);
  });
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`the review view fits at ${size.width} px and its controls can be reached`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(size);
    const repo = repoWithChanges();
    const token = await hubToken(request);
    await seat(request, token, 'review-worker', 'Worker', repo);
    await page.goto('/#home');
    const dialog = await openChanges(page, request, 'Worker');
    const dialogBox = (await dialog.boundingBox())!;
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(size.width);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(size.height);
    // The page behind doesn't scroll sideways, and the bar's buttons are on screen.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const name of ['Ask for a second opinion', 'Send comment to Worker', 'Close']) {
      const control = dialog.getByRole('button', { name });
      await control.scrollIntoViewIfNeeded();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    }
  });
}
