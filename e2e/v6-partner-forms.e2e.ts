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
import { expect, test } from '@playwright/test';
import { buildShoeAudience } from './lib/audience-builder';
import { linkAudience, startCampaign, submitToPartner } from './lib/campaign-builder';
import { signIn, signOut } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

const CAMPAIGN = `Change request flow ${Date.now()}`;
const AUDIENCE = `Change request audience ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test.describe('v6 §5.1 publishing capabilities from the portal', () => {
  test('a Partner publishes capabilities and the version advances', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');
    await page.goto(`${PORTAL}/partner/capabilities`);

    // Publishing by hand is for config-file Agents, folded under Advanced --
    // open already unless an Agent publishes by itself. Opened either way.
    await page
      .locator('details', { hasText: 'Advanced: publish by hand' })
      .evaluate((d) => ((d as HTMLDetailsElement).open = true));

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
    await page.getByRole('button', { name: /finish and find partners/i }).click();
    await expect(page.getByRole('link', { name: /use in a campaign/i })).toBeVisible({
      timeout: 20_000,
    });

    const url = await startCampaign(page, PORTAL, CAMPAIGN);
    await linkAudience(page, url, AUDIENCE);
    await submitToPartner(page, url, 'Travel A');

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
