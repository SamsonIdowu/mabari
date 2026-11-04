// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function home(page: Page, request: Page['request']) {
  await request.post('/api/demo/load');
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toContainText('working');
}

async function ask(page: Page, text: string) {
  await page.getByLabel('Message Mabari').fill(text);
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(page.locator('#youSaid')).toHaveText(text);
  await expect(page.locator('#veeSay .typing')).toBeHidden();
}

test('home is the default page after the first run', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('See your AI agents at work');
  await request.post('/api/demo/load');
  await page.goto('/');
  await page.reload();
  await expect(page.locator('#homeGreet')).toHaveText(/^(Morning|Afternoon|Evening)$/);
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('home greets and sums up the live office', async ({ page, request }) => {
  await home(page, request);
  const summary = page.locator('#homeSum');
  await expect(summary).toContainText(/\d+ working/);
  await expect(summary).toContainText('need you');
  await expect(summary).toContainText(/done around \d\d:\d\d/);
  await expect(page.locator('#veeSay')).toContainText(
    "Hi, I'm Mabari, your office manager. Tell me what you need and I'll hand it to the right agent",
  );
});

test('an empty office says so', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toHaveText('No agents yet');
  await ask(page, "What's happening?");
  await expect(page.locator('#veeSay')).toContainText('The office is empty for now.');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
});

test('Mabari is drawn and a gesture moves it', async ({ page, request }) => {
  await home(page, request);
  const vee = page.locator('#veeHome');
  await expect(vee).toBeVisible();
  const painted = await vee.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    return data.some((value) => value !== 0);
  });
  expect(painted).toBe(true);
  const before = await vee.screenshot();
  await page.getByRole('button', { name: 'Gestures' }).click();
  const menu = page.locator('#gestMenu');
  await expect(menu.getByRole('button')).toHaveCount(13);
  await menu.getByRole('button', { name: 'Star jump' }).click();
  await expect(menu).toBeHidden();
  await page.waitForTimeout(700);
  expect(before.equals(await vee.screenshot())).toBe(false);
});

test('the bubble sits at Mabari and stays in view', async ({ page, request }) => {
  await home(page, request);
  const stage = (await page.locator('.h2stage').boundingBox())!;
  await expect
    .poll(async () => (await page.locator('#veeSay').boundingBox())!.x)
    .toBeGreaterThan(stage.x);
  const bubble = (await page.locator('#veeSay').boundingBox())!;
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(stage.x + stage.width);
  expect(bubble.y).toBeGreaterThanOrEqual(stage.y);
});

test('answers a question from live data and lets you review what needs you', async ({
  page,
  request,
}) => {
  await home(page, request);
  await ask(page, 'Who needs me?');
  const say = page.locator('#veeSay');
  await expect(say).toContainText('need you:');
  await expect(say).toContainText('npm run db:migrate -- --env=staging');
  await expect(say).toContainText('I never approve risky actions for you.');
  await say.getByRole('button', { name: 'Review' }).click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('Atlas wants to run a command');
  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toBeHidden();
});

test('says when the work will finish', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'When will everything be done?');
  const say = page.locator('#veeSay');
  await expect(say).toContainText(/Everything should be done in about \d+ min, around \d\d:\d\d/);
  await expect(say.locator('.hclist li')).toHaveCount(4);
});

test('opens an agent from the status answer', async ({ page, request }) => {
  await home(page, request);
  await ask(page, "What's happening?");
  await page.locator('#veeSay .linkbtn', { hasText: 'Ledger' }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
});

test('passes an instruction on through the normal route', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'Tell Scout to add the pricing pages');
  // Mabari says it was sent, then reads out Scout's reply without being asked.
  await expect(page.locator('#veeSay')).toContainText(
    /Scout \((Claude|ChatGPT|OpenAI|Custom AI)\) replied: /,
  );
  await page.getByRole('link', { name: 'Activity log' }).click();
  // Delivered at once, and the demo agent answers straight away.
  await expect(page.locator('tr', { hasText: 'add the pricing pages' })).toContainText('Replied');
});

test('asking through Mabari leaves the answer on the agent', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'ask Ledger how it is going');
  await expect(page.locator('#veeSay')).toContainText("so it won't be interrupted");
  await page.getByRole('link', { name: 'Agents' }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.locator('.answer')).toContainText('Ledger was not interrupted.');
});

test('dispatches anything else at once and relays the reply when it lands', async ({
  page,
  request,
}) => {
  await home(page, request);
  const box = page.getByLabel('Message Mabari');
  await box.fill('the invoice rounding is wrong');
  const started = Date.now();
  await box.press('Enter');
  const say = page.locator('#veeSay');
  await expect(say).toContainText('On it, sent to Ledger (Claude).');
  await expect(say).toContainText("I'll read you the reply the moment it lands.");
  // Generous for a browser round trip; the server's own budget is checked in Go.
  expect(Date.now() - started).toBeLessThan(1500);
  await expect(page.getByRole('button', { name: 'Send to the team' })).toHaveCount(0);
  // Ledger is mid step, so it takes the instruction at its next checkpoint and Mabari relays it.
  await expect(say).toContainText('Ledger (Claude) replied: Got it.', { timeout: 10000 });
  // Mabari already said it, so the toast doesn't repeat it.
  await expect(page.getByText('Ledger replied. Open Ledger to read it.')).toHaveCount(0);
});

test('commands that look like questions or gestures are dispatched', async ({ page, request }) => {
  await home(page, request);
  for (const text of ['update the README', 'finish the login page', 'Point the API to staging']) {
    await ask(page, text);
    await expect(page.locator('#veeSay')).toContainText('On it, sent to ');
  }
});

test('a reply that lands while you are elsewhere shows on the Home badge', async ({
  page,
  request,
}) => {
  await home(page, request);
  await ask(page, 'the invoice rounding is wrong');
  await page.getByRole('link', { name: 'Agents' }).click();
  // The prompt tray on the floor shows who it went to.
  const tray = page.locator('#promptTray');
  await expect(tray).toContainText('Mabari → Ledger');
  await expect(tray).toContainText('Claude ·');
  const badge = page.locator('.rail a.nav[href="#home"] .badge');
  await expect(badge).toHaveText('1', { timeout: 10000 });
  await expect(tray).toContainText('Replied');
  await page.locator('.rail a.nav[href="#home"]').click();
  await expect(badge).toHaveCount(0);
  await expect(page.locator('#veeSay')).toContainText('Ledger (Claude) replied: Got it.');
});

test('the message bar is one slim line that grows and shrinks back', async ({ page, request }) => {
  await home(page, request);
  const bar = (await page.locator('#hcForm').boundingBox())!;
  expect(bar.height).toBeGreaterThanOrEqual(44);
  expect(bar.height).toBeLessThanOrEqual(56);
  const order = await page
    .locator('#hcForm')
    .evaluate((form) =>
      [...form.querySelectorAll('button.h2ic, textarea')].map(
        (node) => node.getAttribute('aria-label') ?? node.id,
      ),
    );
  expect(order).toEqual(['Gestures', 'hcText', 'Hold to talk', 'Spoken replies']);
  const box = page.getByLabel('Message Mabari');
  await expect(box).toHaveAttribute('rows', '1');
  await box.fill('line\n'.repeat(12));
  const tall = (await box.boundingBox())!.height;
  expect(tall).toBeGreaterThan(60);
  expect(tall).toBeLessThanOrEqual(121);
  await box.fill('what is happening');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  expect((await box.boundingBox())!.height).toBeLessThan(40);
});

test('the top bar shows the wordmark only and links home', async ({ page, request }) => {
  await home(page, request);
  const brand = page.locator('.brandmark');
  await expect(brand).toHaveText('Mabari');
  await expect(brand.locator('svg')).toHaveCount(0);
  await expect(brand).toHaveAttribute('href', '#home');
  const name = brand.locator('.bm-name');
  await expect(name).toHaveCSS('font-size', '22px');
  await expect(name).toHaveCSS('font-weight', '800');
});

test('asking Mabari to approve changes nothing', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'approve it');
  await expect(page.locator('#veeSay')).toContainText('I never approve risky actions for you.');
  const pending = await request.get('/api/approvals');
  expect(JSON.stringify(await pending.json())).toContain('db:migrate');
  await page.getByRole('link', { name: 'Agents' }).click();
  await expect(page.locator('.board')).toContainText('Atlas');
});

test('shift enter starts a new line and an empty box sends nothing', async ({ page, request }) => {
  await home(page, request);
  const box = page.getByLabel('Message Mabari');
  await box.press('Enter');
  await expect(page.locator('#youSaid')).toBeHidden();
  await box.fill('one');
  await box.press('Shift+Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
});

test('the reply is one bubble with no chat history', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'hello');
  await ask(page, 'thanks');
  await expect(page.locator('#veeSay')).toContainText('Any time.');
  await expect(page.locator('#veeSay')).not.toContainText('Good to see you');
  await expect(page.locator('#youSaid')).toHaveText('thanks');
});

test('spoken replies can be switched on and read the reply aloud', async ({ page, request }) => {
  await home(page, request);
  await page.evaluate(() => {
    const said: string[] = [];
    Object.assign(window, { said });
    window.speechSynthesis.speak = (utterance) => void said.push(utterance.text);
  });
  const voice = page.getByRole('button', { name: 'Spoken replies' });
  await expect(voice).toHaveAttribute('aria-pressed', 'false');
  await voice.click();
  await expect(voice).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#voiceLbl')).toHaveText('Voice on');
  await ask(page, 'thanks');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said))
    .toEqual(['Any time. Keeping an eye on things is my favourite job.']);
  await voice.click();
  await expect(page.locator('#voiceLbl')).toHaveText('Voice off');
});

test('Mabari opens the new agent form when asked', async ({ page, request }) => {
  await home(page, request);
  await page.getByLabel('Message Mabari').fill('Create a new agent');
  await page.getByLabel('Message Mabari').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
});
