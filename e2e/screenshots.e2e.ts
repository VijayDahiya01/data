/**
 * Capture the main screens as images.
 *
 * Not an assertion suite — a way to LOOK at the portal after a visual change,
 * because a stylesheet that compiles and a stylesheet that reads well are
 * different claims. Run it, open `screenshots/`, and judge.
 *
 *   pnpm exec playwright test --config playwright.portal.config.ts e2e/screenshots.e2e.ts
 */
import { test, type Page } from '@playwright/test';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';
const OUT = 'screenshots';

async function signIn(page: Page, email: string) {
  await page.goto(`${PORTAL}/login`);
  await page.getByRole('link', { name: /continue to sign in/i }).click();
  await page.waitForURL(/\/realms\/oolix\//, { timeout: 20_000 });
  await page.locator('#username').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
  await page.waitForURL((url) => url.origin === new URL(PORTAL).origin, { timeout: 20_000 });
}

const shoot = async (page: Page, path: string, name: string) => {
  await page.goto(`${PORTAL}${path}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};

test.describe.configure({ mode: 'serial' });

test('capture the Buyer screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, 'demo@example.test');

  await shoot(page, '/dashboard', '01-dashboard');
  await shoot(page, '/audiences', '02-audiences');
  await shoot(page, '/audiences/new', '03-audience-builder');
  await shoot(page, '/campaigns', '04-campaigns');
  await shoot(page, '/discover', '05-prebuilt');
});

test('capture the Partner screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, 'partner.admin@example.test');

  await shoot(page, '/partner', '06-partner-dashboard');
  await shoot(page, '/partner/capabilities', '07-capabilities');
  await shoot(page, '/partner/requests', '08-requests');
});
