// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/api/wipe', { data: { confirm: true } });
});

const SCREENS = [
  '#home',
  '#office',
  '#projects',
  '#conversations',
  '#accounts',
  '#activity',
  '#preferences',
  '#states',
];

async function audit(page: Page) {
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
  test(`every screen passes WCAG 2.1 AA checks in the ${theme} theme`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('h1')).toHaveText('Agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const found: string[] = [];
    for (const route of SCREENS) {
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, route);
      await page.waitForTimeout(300);
      for (const violation of await audit(page)) found.push(`${route} ${violation}`);
    }
    expect(found, found.join('\n')).toEqual([]);
  });
}

test('the keyboard reaches the menu, shows where it is, and opens a page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
  const reached: string[] = [];
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      return {
        name:
          element.getAttribute('aria-label') ??
          (element.textContent?.trim() || `${element.tagName}#${element.id}.${element.className}`),
        // A ring on the field itself, or on the box around it (.cmdin, .composer).
        outline: [element, element.parentElement, element.parentElement?.parentElement]
          .filter((node): node is HTMLElement => !!node)
          .some((node) => {
            const style = getComputedStyle(node);
            return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
          })
          ? 'shown'
          : 'none',
      };
    });
    if (!focused) continue;
    expect(focused.outline, `no focus ring on ${focused.name}`).not.toBe('none');
    reached.push(focused.name);
    if (focused.name === 'Projects') break;
  }
  expect(reached).toContain('Projects');
  await page.keyboard.press('Enter');
  await expect(page.locator('main h1')).toHaveText('Projects');
});

for (const width of [1440, 1024]) {
  test(`no screen scrolls sideways at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('h1')).toHaveText('Agents');
    const wide: string[] = [];
    for (const route of SCREENS) {
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, route);
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) wide.push(`${route} is ${overflow} px too wide`);
    }
    expect(wide).toEqual([]);
  });
}
