/**
 * Every screen, as the all-access user (§34).
 *
 * `demo@example.test` belongs to four organizations, so one sign-in reaches
 * every persona — which is what §34 means by "role switching must not require a
 * second account". That makes it the right account to sweep the whole portal
 * with.
 *
 * The sweep is deliberately blunt: visit each route, assert it rendered rather
 * than erroring, and assert no page leaks a customer identifier. A screen that
 * throws on real data fails here even if nobody wrote a test for it.
 */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

/**
 * Routes are read from the RENDERED SIDEBAR rather than listed here.
 *
 * A hardcoded list is exactly how five dead links reached a user: the sweep
 * checked /network and /admin but never their children, so /network/members and
 * four others 404ed in the navigation while every test passed. Crawling what
 * the portal actually offers means a link without a page fails here instead.
 */

/** Switch the active organization through the sidebar, as a person would. */
async function switchOrg(page: Page, name: RegExp) {
  await page.goto(`${PORTAL}/dashboard`).catch(() => undefined);
  const select = page.locator('#org_id');
  if ((await select.count()) === 0) return false;

  const option = page.locator('#org_id option', { hasText: name });
  if ((await option.count()) === 0) return false;

  const label = (await option.first().textContent())?.trim() ?? '';
  await select.selectOption({ label });
  await page.getByRole('button', { name: /switch organization/i }).click();

  // Wait for the switch to be REFLECTED, not merely for the network to fall
  // quiet -- `networkidle` is unreliable in a Next app, which keeps connections
  // open. The sidebar naming the new organization is the actual signal.
  await expect(page.locator('.org-switch')).toContainText(label, { timeout: 20_000 });
  return true;
}

/** Every distinct in-app link the sidebar offers for the active organization. */
async function navLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator('nav a[href^="/"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs.filter((h) => h && !h.startsWith('//')))];
}

async function sweep(page: Page, routes: string[]) {
  expect(routes.length, 'the sidebar offered no links at all').toBeGreaterThan(0);

  for (const route of routes) {
    const response = await page.goto(`${PORTAL}${route}`, { waitUntil: 'domcontentloaded' });
    const status = response?.status();

    // 404 is the failure this sweep exists to catch: a link the navigation
    // offers that goes nowhere.
    expect(status, `${route} responded ${status}`).toBeLessThan(400);

    const body = page.locator('body');
    await expect(body, `${route} rendered Next's not-found page`).not.toContainText(
      /this page could not be found/i,
    );
    await expect(body, `${route} rendered an error page`).not.toContainText(
      /this page couldn.t load|a server error occurred/i,
    );

    // §54, §73: no screen, for any persona, shows a customer identifier.
    const html = await page.content();
    expect(html, `${route} leaked partner_user_id`).not.toContain('partner_user_id');
    expect(html, `${route} leaked a fixture identity`).not.toMatch(/U123|U456/);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('All screens, as the all-access user', () => {
  test('one login reaches four organizations (§34)', async ({ page }) => {
    await signIn(page, 'demo@example.test');

    // The switcher is the §34 mechanism: no second account, no re-login.
    const options = page.locator('#org_id option');
    await expect(options).toHaveCount(4);

    await expect(page.locator('.org-switch')).toContainText(/ABC Insurance/i);
  });

  test('every link the Buyer sidebar offers actually resolves', async ({ page }) => {
    await signIn(page, 'demo@example.test');
    await sweep(page, await navLinks(page));
  });

  test('every link the Data Partner sidebar offers actually resolves', async ({ page }) => {
    await signIn(page, 'demo@example.test');

    const switched = await switchOrg(page, /Travel A/);
    expect(switched, 'could not switch to the Data Partner organization').toBe(true);

    await sweep(page, await navLinks(page));
  });

  test('every link the Network sidebar offers actually resolves', async ({ page }) => {
    await signIn(page, 'demo@example.test');
    await switchOrg(page, /Meridian/);
    await sweep(page, await navLinks(page));
  });

  test('every link the platform sidebar offers actually resolves', async ({ page }) => {
    await signIn(page, 'demo@example.test');
    await switchOrg(page, /Oolix Platform/);
    await sweep(page, await navLinks(page));
  });

  test('switching organization changes what the navigation offers (§4.2)', async ({ page }) => {
    await signIn(page, 'demo@example.test');

    // As the Buyer: a campaign builder and the audience library, no approval
    // queue. v6 §18.1 makes Audiences the Buyer's primary route.
    await expect(page.getByRole('navigation')).toContainText('Campaigns');
    await expect(page.getByRole('navigation')).toContainText('Audiences');

    await switchOrg(page, /Travel A/);

    // As the Partner: supply and approvals appear, because the PERMISSIONS
    // changed — not because the portal recognised a role name (§4.2).
    await expect(page.getByRole('navigation')).toContainText('Campaign requests');
    // v6 §18.2: what a Partner publishes is now their CAPABILITIES — which
    // standardized attributes they can evaluate — with prebuilt segments kept
    // as the legacy path beside it.
    await expect(page.getByRole('navigation')).toContainText('Audience capabilities');
  });
});
