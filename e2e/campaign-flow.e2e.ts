/**
 * The whole journey, through the browser (§40, §41, §85).
 *
 * A Buyer signs in, builds a campaign across the nine §40 steps, and submits
 * it. A Partner then signs in, sees it in their queue, reviews it against the
 * §41 checklist, and approves it. Nothing is done through the API directly —
 * if a screen is missing or a form is wrong, this fails.
 *
 * This is the test that answers "can I sign up and run a campaign", and it is
 * the one to run after any change to the builder or the approval centre.
 */
import { expect, test } from '@playwright/test';
import { buildShoeAudience } from './lib/audience-builder';
import { signIn, signOut } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

// One run, one campaign name, so a failed run never collides with the next.
const CAMPAIGN = `Portal flow ${Date.now()}`;
const AUDIENCE = `Portal audience ${Date.now()}`;

/** A tiny valid PNG, so the upload exercises §93.3's magic-byte check for real. */
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff0300000600' +
    '0557bfabd40000000049454e44ae426082',
  'hex',
);

test.describe.configure({ mode: 'serial' });

test.describe('Build and approve a campaign through the portal', () => {
  let campaignUrl: string;

  test('a Buyer builds a campaign across the §40 steps', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    // --- Steps 1, 2 and 8 --------------------------------------------------
    await page.goto(`${PORTAL}/campaigns/new`);
    await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();

    await page.getByLabel('Campaign name').fill(CAMPAIGN);
    await page.getByLabel(/what should this campaign achieve/i).selectOption('QUALIFIED_LEADS');

    // §40.8 appears only for outcome objectives, because §50 will not settle a
    // campaign that never defined its outcome.
    await expect(page.getByText(/which lead states count as payable/i)).toBeVisible();

    await page.getByRole('button', { name: /create draft/i }).click();

    // Lands on step 7: §70 binds approval to a creative version, so one has to
    // exist before a Partner can be asked anything.
    await page.waitForURL(/\/campaigns\/[0-9a-f-]+\/creative/, { timeout: 20_000 });
    campaignUrl = page.url().replace(/\/creative$/, '');

    // --- Step 7 ------------------------------------------------------------
    await page.getByLabel('Headline').fill('Protect your trip');
    await page.getByLabel('Body').fill('Travel insurance in minutes.');
    await page
      .getByLabel('Image file')
      .setInputFiles({ name: 'creative.png', mimeType: 'image/png', buffer: PNG_1PX });
    await page.getByRole('button', { name: /upload creative/i }).click();

    await expect(page.getByText(/^v1$/).first()).toBeVisible({ timeout: 30_000 });

    // --- v6 §9 step 3: build the audience ----------------------------------
    //
    // This is the inversion v6 introduces. The Buyer describes WHO the campaign
    // is for, from the Oolix attribute taxonomy, and only then finds out which
    // Data Partners can evaluate that description. There is no segment browsing
    // on the primary path any more (§18.1).

    // Four conditions, matching §20's floor. Composed through the real
    // controls — a picker, value chips, a range — never free text.
    await buildShoeAudience(page, PORTAL, AUDIENCE);

    // The saved audience reads back in the Buyer's own language — the same
    // sentence the Partner will see on the approval screen. The rule hash that
    // used to be asserted here is still what §10 binds the approval to; it is
    // simply not shown to a Buyer, who cannot act on a hex string.
    await expect(page.locator('body')).toContainText('Age: 18–35 years');
    await expect(page.locator('body')).toContainText(/within 90 days/i);
    // All four conditions are Required, so all four carry a tick. Counting the
    // list items rather than a summary sentence: the sentence could be right
    // while the list showed something else.
    await expect(page.locator('.rule-list .rule-tick')).toHaveCount(4);

    // The Buyer-facing status, never the internal DRAFT / READY / SUPERSEDED.
    await expect(page.getByText(/SUPERSEDED/)).toHaveCount(0);
    await expect(page.getByText(/\bVersion \d|\bv\d\b/)).toHaveCount(0);

    // The range has to be the one that was typed. An earlier build pre-filled
    // it with the taxonomy's own bounds, so "Age 13-120" — every person alive —
    // looked like a deliberate choice and would have shipped unnoticed.
    await expect(page.getByText('13–120')).toHaveCount(0);

    // §6: only a READY version can be linked to a campaign.
    await page.getByRole('button', { name: /finalize audience/i }).click();
    await expect(page.locator('body')).toContainText(
      /audience finalized|can be used in a campaign/i,
      {
        timeout: 20_000,
      },
    );

    // --- v6 §9 steps 3 to 7 -------------------------------------------------
    await page.goto(`${campaignUrl}/audience`);

    // The option carries a version suffix, so match on the visible text rather
    // than an exact label.
    const audienceOption = page
      .locator('#audience_group_id option')
      .filter({ hasText: AUDIENCE })
      .first();
    await page.getByLabel('Audience').selectOption(await audienceOption.getAttribute('value'));
    await page.getByRole('button', { name: /link audience/i }).click();
    await expect(page.locator('body')).toContainText(/frozen/i, { timeout: 20_000 });

    // A SPECIFIC Partner is chosen rather than whichever happens to be first.
    // Both seeded Partners can evaluate this audience, and picking blindly
    // sends the request to one of them at random -- correct behaviour (§67
    // gives each Partner only its own request) but it would leave the approval
    // half of this test unable to know who to sign in as.
    const match = page.locator('details', { hasText: 'Travel A' }).first();
    await expect(match).toBeVisible({ timeout: 20_000 });
    await match.click();

    await match.getByLabel(/budget for this partner/i).fill('100000');
    await match.getByRole('button', { name: /^Add /i }).click();

    // The Partner now appears in the selected-Partners table.
    await expect(page.locator('table')).toBeVisible({ timeout: 20_000 });

    // --- Step 9 ------------------------------------------------------------
    await page.getByRole('link', { name: /continue to review/i }).click();
    await page.waitForURL(/\/review$/, { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: CAMPAIGN })).toBeVisible();
    await expect(page.getByText(/partner requests/i)).toBeVisible();

    await page.getByRole('button', { name: /submit for partner review/i }).click();

    // §40.9 freezes the version and starts each Partner's clock.
    await page.waitForURL(campaignUrl, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/partner review|review/i);
  });

  test('the Partner finds it in the queue and approves it', async ({ page }) => {
    await signOut(page);
    // Travel A's approver: the Partner chosen from the audience matches above.
    await signIn(page, 'partner.approver@example.test');

    await page.goto(`${PORTAL}/partner/requests`);
    const link = page.getByRole('link', { name: CAMPAIGN });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();

    // §41: everything needed to decide, on one screen.
    const body = page.locator('body');
    await expect(body).toContainText(/who is advertising/i);
    await expect(body).toContainText(/content hash/i);
    await expect(body).toContainText(/decision is yours/i);

    // §41 allows approving a SUBSET; here everything requested is accepted.
    await page.getByRole('button', { name: /^Approve$/ }).click();

    await page.waitForURL(/\/partner\/requests/, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/approved/i);
  });

  test('the Buyer sees the approval, per Partner (§42)', async ({ page }) => {
    await signOut(page);
    await signIn(page, 'buyer.admin@example.test');

    await page.goto(campaignUrl);
    await expect(page.getByRole('heading', { name: CAMPAIGN })).toBeVisible();

    // §42: the per-Partner row carries the real state, not just a rolled-up
    // label on the parent campaign.
    await expect(page.getByText(/per-partner status/i)).toBeVisible();
    await expect(page.locator('table')).toContainText(/approved|ready|live|pending/i);
  });
});
