/**
 * The portal is light for everyone, including a viewer whose OS is dark.
 *
 * This exists because it happened: the stylesheet carried a
 * `prefers-color-scheme: dark` block, so anyone on a dark-mode machine saw a
 * fully dark product — while every screenshot and every other test ran in
 * light mode and looked correct. Half the team was reviewing a UI nobody had
 * designed, and nothing caught it.
 *
 * Playwright defaults to light, so asserting the light path proves nothing.
 * This runs with `colorScheme: 'dark'` on purpose.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

test.use({ colorScheme: 'dark' });

/** `rgb(r, g, b)` -> perceived lightness, 0 (black) to 255 (white). */
function lightness(colour: string): number {
  const [r, g, b] = (colour.match(/\d+/g) ?? ['0', '0', '0']).map(Number) as [
    number,
    number,
    number,
  ];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

test('the portal stays light on a dark-mode machine', async ({ page }) => {
  await signIn(page, 'demo@example.test');
  await page.goto(`${PORTAL}/dashboard`, { waitUntil: 'networkidle' });

  const body = await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightness(body), `body background is dark: ${body}`).toBeGreaterThan(200);

  // The navigation rail is the element that was most obviously dark, and it
  // paints its own background rather than inheriting the body's.
  const rail = await page
    .locator('nav.sidebar')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightness(rail), `navigation rail is dark: ${rail}`).toBeGreaterThan(200);

  // Text has to stay dark ON that light ground. Asserting only the background
  // would pass a light-on-light page nobody could read.
  const text = await page.locator('body').evaluate((el) => getComputedStyle(el).color);
  expect(lightness(text), `body text is not dark enough to read: ${text}`).toBeLessThan(120);

  // `color-scheme` is what stops the BROWSER painting scrollbars, form controls
  // and autofill dark, whatever the page's own colours say.
  const scheme = await page.locator(':root').evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toContain('light');

  // Kept so the light result on a dark machine can be seen, not just asserted.
  await page.screenshot({ path: 'screenshots/dark-mode-check.png' });
});
