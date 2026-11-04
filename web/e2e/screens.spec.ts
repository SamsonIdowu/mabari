// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

async function loadDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
}

const go = (page: Page, route: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash;
  }, route);

const SCREENS: [route: string, heading: string][] = [
  ['#welcome', 'See your AI agents at work, in a little office.'],
  ['#projects', 'Projects'],
  ['#conversations', 'Conversations'],
  ['#accounts', 'Accounts'],
  ['#activity', 'Activity log'],
  ['#preferences', 'Settings'],
  ['#components', 'Component sheet'],
  ['#states', 'Status screens'],
];

test('first run opens the office, and home is the start page after that', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('h1')).toHaveText('Agents');
  await expect(page.getByText('Demo office loaded.')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('#homeGreet')).toBeVisible();
});

test('every screen renders in both themes without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loadDemo(page);
  for (let click = 0; click < 2; click++) {
    await page.locator('.topright button.tbtn').click();
    for (const [route, heading] of SCREENS) {
      await go(page, route);
      await expect(page.locator('main h1')).toHaveText(heading);
    }
  }
  expect(errors).toEqual([]);
});

test('the nav badge counts agents that need you', async ({ page }) => {
  await loadDemo(page);
  await expect(page.locator('.rail .badge').first()).toHaveText('2');
});

test('projects show progress, estimates and completion from the server', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#projects');
  const card = page.locator('article', { hasText: 'Test coverage' });
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(card.getByText(/^Done around \d\d:\d\d/)).toBeVisible();
  const landing = page.locator('article', { hasText: 'Landing page' });
  await expect(landing.getByText('Completed 2 days ago')).toBeVisible();
  await expect(landing.getByText('Fixed 14 accessibility issues')).toBeVisible();

  await page.getByRole('button', { name: 'Completed 1' }).click();
  await expect(page.locator('main article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Landing page is open again')).toBeVisible();
  await expect(page.getByText('No completed projects yet')).toBeVisible();
});

test('the activity log searches and filters', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#activity');
  await expect(page.getByText('5 of 5 entries. Kept for 30 days.')).toBeVisible();
  await page.getByLabel('Search the log').fill('changelog');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Waiting for checkpoint')).toBeVisible();
  await page.getByLabel('Search the log').fill('');
  await page.getByLabel('Type').selectOption('Approval');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Search the log').fill('no such thing');
  await expect(page.getByText('Nothing matches. Try a different word or type.')).toBeVisible();
});

test('conversations list threads and open one', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#conversations');
  await page.getByRole('button', { name: /Ledger and Sage/ }).click();
  await expect(page.locator('.cmsg', { hasText: 'Yes, for pagination.' })).toBeVisible();
  await page.getByLabel('Search conversations').fill('rollback');
  await expect(page.getByRole('button', { name: /Atlas and Atlas scribe/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Ledger and Sage/ })).toBeHidden();
});

test('accounts show connections without pretending to connect', async ({ page }) => {
  await page.goto('/#accounts');
  await expect(page.locator('.chip', { hasText: 'Not connected' })).toHaveCount(3);
  // The test machine has no Codex CLI, so signing in explains what is missing.
  await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(page.getByText("the Codex CLI isn't installed")).toBeVisible();
});

test('API keys are checked, saved without being shown, and removed', async ({ page }) => {
  await page.goto('/#accounts');
  await page.getByText('API keys (optional)').click();
  const card = page.locator('.card', { hasText: 'Anthropic API key' });
  await card.getByLabel('Key').fill('not-a-key');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText("that doesn't look like an Anthropic API key")).toBeVisible();
  await card.getByLabel('Key').fill('sk-ant-api03-' + 'a'.repeat(40));
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('.chip')).toHaveText('Saved');
  await expect(card.getByLabel('Key')).toHaveValue('');
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.locator('.chip')).toHaveText('Not set');
});

test('a hub token is shown once and can be revoked', async ({ page }) => {
  await page.goto('/#accounts');
  await page.getByRole('button', { name: 'Generate a token' }).click();
  await expect(page.getByTestId('hubToken')).toContainText(/^mab_[0-9a-f]{48}$/);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('hubToken')).toHaveCount(0);
});

test('Attach Claude Code shows the real change first, and never runs from go run', async ({
  page,
}) => {
  await page.goto('/#accounts');
  const diff = page.getByTestId('claudeDiff');
  await expect(diff).toContainText('"PermissionRequest"');
  await expect(diff)
    .toContainText('"onFailure"', { timeout: 100 })
    .catch(() => undefined);
  await expect(diff).not.toContainText('onFailure');
  await expect(page.locator('.card', { hasText: 'Attach Claude Code' })).toContainText(
    '.mabari-backup',
  );
  // The test server runs under go run, so there is no binary for the hook to call.
  await page.getByRole('button', { name: 'Attach Claude Code', exact: true }).click();
  await expect(page.getByText('start Mabari from its built binary')).toBeVisible();
});

test('settings are saved on the server', async ({ page, request }) => {
  await page.goto('/#preferences');
  await page.getByLabel('Keep events for').selectOption('90');
  await page.getByText('Read agent replies aloud').click();
  await page.getByText('Allow other devices on my network').click();
  await expect(page.getByText('Turn this off on shared or public networks.')).toBeVisible();
  await expect
    .poll(async () => (await (await request.get('/api/settings')).json()).retentionDays)
    .toBe(90);
  await page.reload();
  await expect(page.getByLabel('Keep events for')).toHaveValue('90');
  await expect(page.getByRole('checkbox', { name: 'Read agent replies aloud' })).toBeChecked();
});

test('the query model picker lists only connected accounts', async ({ page }) => {
  await page.goto('/#preferences');
  await expect(page.getByLabel('Model that answers queries')).toBeDisabled();
  await loadDemo(page);
  await go(page, '#preferences');
  await expect(page.getByLabel('Model that answers queries')).toBeEnabled();
});

test('wiping asks twice and returns to first run', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#preferences');
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  await page.getByRole('button', { name: 'Yes, wipe all data' }).click();
  await expect(page.getByText('All data wiped')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('See your AI agents at work, in a little office.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Explore a demo office' })).toBeVisible();
});

test('live updates reach the page', async ({ page }) => {
  await loadDemo(page);
  await go(page, '#activity');
  await expect(page.getByText('5 of 5 entries.')).toBeVisible();
  await page.request.patch('/api/settings', { data: { retentionDays: 7 } });
  await expect(page.getByText('Kept for 7 days.')).toBeVisible();
});

test('the approval sound has a switch and can be played', async ({ page }) => {
  await page.addInitScript(() => {
    const started: number[] = [];
    Object.assign(window, { notesPlayed: started });
    class FakeAudio {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator() {
        return {
          frequency: { value: 0 },
          connect: () => undefined,
          start: (at: number) => started.push(at),
          stop: () => undefined,
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: () => undefined,
            linearRampToValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
          },
          connect: () => undefined,
        };
      }
    }
    Object.assign(window, { AudioContext: FakeAudio });
  });
  await loadDemo(page);
  await go(page, '#preferences');
  const box = page.getByLabel('Ding when an approval needs you');
  await expect(box).toBeChecked();
  await page.getByRole('button', { name: 'Play it' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { notesPlayed: number[] }).notesPlayed.length),
    )
    .toBe(4); // two notes, each with its overtone
  await box.click();
  await expect(box).not.toBeChecked();
  await page.reload();
  await expect(page.getByLabel('Ding when an approval needs you')).not.toBeChecked();
});

test('a wipe forgets the filtered view, so the next demo shows everyone', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .locator('article', { hasText: 'Test coverage' })
    .getByRole('link', { name: 'Open in office' })
    .click();
  await expect(page.locator('.dd').first()).toContainText('Test coverage');
  await go(page, '#preferences');
  await page.getByRole('button', { name: 'Wipe all data…' }).click();
  await page.getByRole('button', { name: 'Yes, wipe all data' }).click();
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('.dd').first()).toContainText('All projects');
  await expect(page.locator('.tag .nt:visible')).toHaveCount(10);
});

test('All projects opens the whole office, even after a project was opened', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .locator('article', { hasText: 'Test coverage' })
    .getByRole('link', { name: 'Open in office' })
    .click();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page
    .locator('article', { hasText: 'All projects' })
    .getByRole('link', { name: 'Open in office' })
    .click();
  await expect(page.locator('.dd').first()).toContainText('All projects');
});

test('a fresh install starts with My first project', async ({ page }) => {
  await page.goto('/#projects');
  await expect(page.locator('article', { hasText: 'My first project' })).toContainText(
    'No agents yet. Start one and choose this project.',
  );
});

test('the status screens open New agent and show Mori on the floor', async ({ page }) => {
  await page.goto('/#states');
  await page.getByRole('button', { name: 'New agent' }).click();
  await expect(page.getByRole('dialog')).toContainText('Create a new agent');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See Mori on the floor' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
  const panel = page.getByRole('complementary', { name: 'Agent details' });
  await expect(panel.getByRole('heading', { name: 'Mori', exact: true })).toBeVisible();
});
