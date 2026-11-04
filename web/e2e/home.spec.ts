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
  await page.getByLabel('Message Vee').fill(text);
  await page.getByLabel('Message Vee').press('Enter');
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
  await expect(page.locator('#veeSay')).toContainText("Hi, I'm Vee.");
});

test('an empty office says so', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('#homeSum')).toHaveText('No agents yet');
  await ask(page, "What's happening?");
  await expect(page.locator('#veeSay')).toContainText('The office is empty for now.');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.tag .nt').first()).toBeVisible();
});

test('Vee is drawn and a gesture moves it', async ({ page, request }) => {
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

test('the bubble sits at Vee and stays in view', async ({ page, request }) => {
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
  await expect(page.locator('#veeSay')).toContainText('Sent to Scout. It has it now.');
  await expect(page.getByText('Sent to Scout', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Activity log' }).click();
  // Delivered at once, and the demo agent answers straight away.
  await expect(page.locator('tr', { hasText: 'add the pricing pages' })).toContainText('Replied');
});

test('asking through Vee leaves the answer on the agent', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'ask Ledger how it is going');
  await expect(page.locator('#veeSay')).toContainText("so it won't be interrupted");
  await page.getByRole('link', { name: 'Agents' }).click();
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.locator('.answer')).toContainText('Ledger was not interrupted.');
});

test('offers the dispatcher for anything else', async ({ page, request }) => {
  await home(page, request);
  await ask(page, 'the invoice rounding is wrong');
  await page.getByRole('button', { name: 'Send to the team' }).click();
  await expect(page.locator('#veeSay')).toContainText('Done. I sent it to Ledger.');
});

test('asking Vee to approve changes nothing', async ({ page, request }) => {
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
  const box = page.getByLabel('Message Vee');
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

test('Vee opens the new agent form when asked', async ({ page, request }) => {
  await home(page, request);
  await page.getByLabel('Message Vee').fill('Create a new agent');
  await page.getByLabel('Message Vee').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Create a new agent' })).toBeVisible();
});
