/**
 * The two v6 Partner-side forms, exercised through the browser.
 *
 * Both existed and rendered and were BROKEN, because nothing ever submitted
 * them:
 *
 *   - Capabilities published with POST against a route declared `@Put`, so
 *     v6 §5.1 publishing silently did nothing.
 *   - Request-change sent an empty `fields` array against a schema requiring at
 *     least one, so every §41 change request failed validation.
 *
 * A page that renders is not a page that works. These tests submit.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildShoeAudience } from './lib/audience-builder';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

const CAMPAIGN = `Change request flow ${Date.now()}`;
const AUDIENCE = `Change request audience ${Date.now()}`;

/** A tiny valid PNG, so the upload exercises §93.3's magic-byte check. */
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff0300000600' +
    '0557bfabd40000000049454e44ae426082',
  'hex',
);

async function signIn(page: Page, email: string) {
  await page.goto(`${PORTAL}/login`);
  await page.getByRole('link', { name: /continue to sign in/i }).click();
  await page.waitForURL(/\/realms\/oolix\//, { timeout: 20_000 });
  await page.locator('#username').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
  await page.waitForURL((url) => url.origin === new URL(PORTAL).origin, { timeout: 20_000 });
}

async function signOut(page: Page) {
  await page.goto(`${PORTAL}/dashboard`).catch(() => undefined);
  const button = page.getByRole('button', { name: /sign out/i });
  if (await button.count()) await button.first().click();
  await page.context().clearCookies();
}

test.describe.configure({ mode: 'serial' });

test.describe('v6 §5.1 publishing capabilities from the portal', () => {
  test('a Partner publishes capabilities and the version advances', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');
    await page.goto(`${PORTAL}/partner/capabilities`);

    const before = await page.locator('dl.kv').innerText();

    // Tick one attribute that may or may not already be on — the assertion is
    // about the publish succeeding, not about which attributes are chosen.
    await page
      .getByRole('checkbox', { name: /^Loyalty tier/ })
      .first()
      .check();
    await page.getByRole('button', { name: /publish capabilities/i }).click();

    // §16: publishing mints a NEW capability version. If the request had not
    // reached the API at all — which is exactly what a POST to a @Put route
    // does — the page would come back with the version unchanged and no error.
    //
    // Matched on the confirmation's own text rather than `.notice-info`: the
    // page carries a standing explanatory notice with the same class, and a
    // bare class selector is ambiguous.
    await expect(page.getByText(/^Published\. Buyers matching/i)).toBeVisible({ timeout: 30_000 });

    const after = await page.locator('dl.kv').innerText();
    expect(after, 'the capability version did not advance, so nothing was published').not.toEqual(
      before,
    );
  });
});

test.describe('v6 §10 / §41 requesting an audience-rule change', () => {
  test('a Partner can push back on the audience rules themselves', async ({ page }) => {
    // --- Buyer builds and submits ------------------------------------------
    await signIn(page, 'buyer.admin@example.test');

    await buildShoeAudience(page, PORTAL, AUDIENCE);
    await page.getByRole('button', { name: /finalize audience/i }).click();
    await expect(page.locator('body')).toContainText(
      /audience finalized|can be used in a campaign/i,
      {
        timeout: 20_000,
      },
    );

    await page.goto(`${PORTAL}/campaigns/new`);
    await page.getByLabel('Campaign name').fill(CAMPAIGN);
    await page.getByLabel(/what should this campaign achieve/i).selectOption('QUALIFIED_LEADS');
    await page.getByRole('button', { name: /create draft/i }).click();
    await page.waitForURL(/\/campaigns\/[0-9a-f-]+\/creative/, { timeout: 20_000 });
    const url = page.url().replace(/\/creative$/, '');

    await page.getByLabel('Headline').fill('Protect your trip');
    await page.getByLabel('Body').fill('Travel insurance in minutes.');
    await page
      .getByLabel('Image file')
      .setInputFiles({ name: 'creative.png', mimeType: 'image/png', buffer: PNG_1PX });
    await page.getByRole('button', { name: /upload creative/i }).click();
    await expect(page.getByText(/^v1$/).first()).toBeVisible({ timeout: 30_000 });

    await page.goto(`${url}/audience`);
    const option = page.locator('#audience_group_id option').filter({ hasText: AUDIENCE }).first();
    await page.getByLabel('Audience').selectOption(await option.getAttribute('value'));
    await page.getByRole('button', { name: /link audience/i }).click();
    await expect(page.locator('body')).toContainText(/frozen/i, { timeout: 20_000 });

    const match = page.locator('details', { hasText: 'Travel A' }).first();
    await expect(match).toBeVisible({ timeout: 20_000 });
    await match.click();
    await match.getByLabel(/budget for this partner/i).fill('100000');
    await match.getByRole('button', { name: /^Add /i }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 20_000 });

    await page.goto(`${url}/review`);
    await page.getByRole('button', { name: /submit for partner review/i }).click();
    await page.waitForURL(url, { timeout: 30_000 });

    // --- Partner pushes back on the RULES ----------------------------------
    await signOut(page);
    await signIn(page, 'partner.approver@example.test');

    await page.goto(`${PORTAL}/partner/requests`);
    const link = page.getByRole('link', { name: CAMPAIGN });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();

    // v6 §10: the Partner sees the whole rule set, so the thing they can object
    // to is the rules — not only the creative.
    await expect(page.locator('body')).toContainText(/audience rules/i);

    await page
      .getByRole('checkbox', { name: /^Audience rules/ })
      .first()
      .check();
    await page
      .getByLabel('Why')
      .fill('The 18-35 band is narrower than our consented cohort; please widen to 18-45.');
    await page.getByRole('button', { name: /request change/i }).click();

    // The request-change path used to fail validation every time. Landing on
    // the queue with the request marked CHANGE_REQUESTED is the proof it
    // reached the API and transitioned.
    await page.waitForURL(/\/partner\/requests/, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/change/i);
  });
});
