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
  '#builder',
  '#components',
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
  // The page has a few dozen stops before the menu: the header's, the floor's tools and list, and
  // then the top bar, whose Jump to button and the header's Pause everyone are two of them.
  for (let step = 0; step < 60; step++) {
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

test('a waiting approval is said aloud on every page, and the board is a named region', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
  // A polite live region, always on the page, that says what is waiting and for what.
  const live = page.locator('#approvalLive');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText(/^\d+ approvals? waiting: Atlas, \S/);
  // The board is a region with a name, so it shows as a landmark rather than a bare box.
  await expect(page.getByRole('region', { name: 'Approvals' })).toBeVisible();
  // The board belongs to the Agents page, but the message does not.
  await page.evaluate(() => {
    window.location.hash = '#projects';
  });
  await expect(page.locator('h1')).toHaveText('Projects');
  await expect(page.getByRole('region', { name: 'Approvals' })).toHaveCount(0);
  await expect(live).toHaveText(/waiting: Atlas, \S/);
});

// The small attention badges, which axe does not always reach, and the ticks on project cards:
// text 9 to 11 px high that has to pass 4.5:1 against what it sits on.
const BADGES = '.badge, .bcount, .pws b, .pwin.done .pws, .fbubble.red';

for (const theme of ['light', 'dark'] as const) {
  test(`the small badges and ticks have 4.5:1 contrast in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('h1')).toHaveText('Agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The demo starts with an approval waiting and a finished project, so there are red badges
    // on the rail and the board and a tick on a card.
    await expect(page.locator('.rail .badge').first()).toBeVisible();
    await expect(page.locator('#board .badge')).toBeVisible();
    await expect(page.locator('.pwin.done .pws')).toBeVisible();

    const measured = await page.evaluate((selector) => {
      type Colour = { r: number; g: number; b: number; a: number };
      const parse = (css: string): Colour => {
        const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
        return { r, g, b, a };
      };
      const mix = (top: Colour, below: Colour): Colour => ({
        r: top.r * top.a + below.r * (1 - top.a),
        g: top.g * top.a + below.g * (1 - top.a),
        b: top.b * top.a + below.b * (1 - top.a),
        a: 1,
      });
      const light = (c: Colour) => {
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      };
      // What is painted behind an element: its own background over its ancestors', up to one that
      // is solid.
      const behind = (element: Element): Colour => {
        const layers: Colour[] = [];
        for (let at: Element | null = element; at; at = at.parentElement) {
          const colour = parse(getComputedStyle(at).backgroundColor);
          if (colour.a > 0) layers.push(colour);
          if (colour.a === 1) break;
        }
        return layers.reduceRight((below, top) => mix(top, below), {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        });
      };
      return [...document.querySelectorAll(selector)]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
          );
        })
        .map((element) => {
          const style = getComputedStyle(element);
          const back = behind(element);
          const text = mix(parse(style.color), back);
          const [high, low] = [light(text), light(back)].sort((a, b) => b - a);
          return {
            what: `${element.className} "${(element.textContent ?? '').trim()}"`,
            ratio: ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05),
          };
        });
    }, BADGES);

    // An instrument that measures nothing is no check: the badges and the tick must be in it.
    expect(measured.length).toBeGreaterThanOrEqual(5);
    expect(measured.some((item) => item.what.includes('pws'))).toBe(true);
    const failing = measured.filter((item) => item.ratio < 4.5);
    expect(
      failing.map((item) => `${item.what} is ${item.ratio.toFixed(2)}:1`),
      'under 4.5:1',
    ).toEqual([]);
  });
}

test('every control is a target of at least 24 by 24 px', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
  // The board's Minimise is on this page while an approval waits.
  await expect(page.locator('#board .bx')).toBeVisible();
  const small: string[] = [];
  let measured = 0;
  for (const route of SCREENS.filter((name) => name !== '#components')) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, route);
    await page.waitForTimeout(300);
    const found = await page.evaluate(() => {
      const label = (element: Element) =>
        element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 24) || '';
      const targets = [
        ...document.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [role="button"]',
        ),
      ].filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== 'hidden' &&
          !element.classList.contains('sr') &&
          !element.closest('.sr, canvas, [hidden]')
        );
      });
      return targets.map((element) => {
        // A box you tick or choose is hit through its label, which is part of the target.
        const ticked =
          element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type);
        const labelled = ticked ? element.labels?.[0] : undefined;
        const box = (labelled ?? element).getBoundingClientRect();
        return {
          name: `${element.tagName.toLowerCase()} "${label(element)}"`,
          width: box.width,
          height: box.height,
        };
      });
    });
    measured += found.length;
    for (const item of found) {
      if (item.width < 24 || item.height < 24) {
        small.push(
          `${route} ${item.name} is ${item.width.toFixed(1)} by ${item.height.toFixed(1)} px`,
        );
      }
    }
  }
  expect(measured, 'something was measured').toBeGreaterThan(50);
  expect(small).toEqual([]);
});

test('only red and amber ask for attention: the live badge is neutral, question chips outlined', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');

  // The Chats link says "live" for a few seconds after agents talk. That is not a queued
  // instruction, so it is not amber.
  const live = page.locator('.rail .badge', { hasText: 'live' });
  await expect(live).toBeVisible({ timeout: 30_000 });
  const badge = await live.evaluate((element) => getComputedStyle(element).backgroundColor);
  const amber = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--amber)';
    document.body.append(probe);
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  });
  await expect(live).not.toHaveClass(/amber/);
  expect(badge).not.toBe(amber);

  // A question, from either side, is a ring and not a solid fill; the receiver of anything
  // else keeps the prototype's fill.
  const classes = {
    questionIn: new Set<string>(),
    questionOut: new Set<string>(),
    otherIn: new Set<string>(),
  };
  await expect
    .poll(
      async () => {
        const chips = await page.evaluate(() =>
          [...document.querySelectorAll('.mchip:not([hidden])')].map((chip) => ({
            text: chip.textContent ?? '',
            className: chip.className,
          })),
        );
        for (const { text, className } of chips) {
          const incoming = text.startsWith('✉ From');
          if (text.includes('Question'))
            (incoming ? classes.questionIn : classes.questionOut).add(className);
          else if (incoming) classes.otherIn.add(className);
        }
        return classes.questionIn.size > 0 && classes.otherIn.size > 0;
      },
      { timeout: 40_000 },
    )
    .toBe(true);
  expect([...classes.questionIn]).toEqual(['mchip mc-out']);
  expect([...classes.otherIn]).toEqual(['mchip mc-in']);
  for (const className of classes.questionOut) expect(className).toBe('mchip mc-out');
});

// The quick switcher (Ctrl K) is a dialog like the others: focus goes in, Tab stays in, the page
// behind cannot be reached, and Escape puts focus back. Its list is announced with its count.
for (const theme of ['light', 'dark'] as const) {
  test(`the quick switcher passes WCAG 2.1 AA checks in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((name) => window.localStorage.setItem('mabari.theme', name), theme);
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a demo office' }).click();
    await expect(page.locator('h1')).toHaveText('Agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Jump to' });
    await expect(dialog).toBeVisible();
    // With everything listed, with a query that narrows it, and with one that finds nothing.
    await expect(dialog.getByRole('option').first()).toBeVisible();
    expect(await audit(page), 'everything listed').toEqual([]);
    await page.keyboard.type('docs');
    await expect(dialog.getByRole('group', { name: 'Projects' })).toBeVisible();
    expect(await audit(page), 'a query').toEqual([]);
    await page.keyboard.type('zzzz');
    await expect(dialog.getByRole('status')).toContainText('No results');
    expect(await audit(page), 'no results').toEqual([]);
  });
}

test('the quick switcher holds focus, shuts the page out, and gives focus back', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore a demo office' }).click();
  await expect(page.locator('h1')).toHaveText('Agents');
  const opener = page.getByRole('link', { name: 'Projects', exact: true });
  await opener.focus();
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog', { name: 'Jump to' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Focus is in the box without a click, and the page behind is inert.
  await expect(dialog.getByRole('combobox')).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(
    true,
  );
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  // The live regions stay outside what is inert.
  expect(await page.evaluate(() => !!document.querySelector('.toasts')?.closest('[inert]'))).toBe(
    false,
  );
  // Tab and Shift+Tab go round, more times than there are stops, and never get out.
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press(key);
      expect(
        await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
        `${key} ${step + 1} left the dialog`,
      ).toBe(true);
    }
  }
  // The list is a listbox of options with a count, and the box points at the one the arrows are on.
  await dialog.getByRole('combobox').focus();
  const list = dialog.getByRole('listbox', { name: 'Results' });
  await expect(list).toBeVisible();
  const total = await list.getByRole('option').count();
  await expect(dialog.getByRole('status')).toHaveText(`${total} results`);
  const pointed = await dialog.getByRole('combobox').getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${pointed}"]`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(
    false,
  );
  await expect(opener).toBeFocused();
});
