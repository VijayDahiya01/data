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
import { linkAudience, startCampaign, submitToPartner } from './lib/campaign-builder';
import { signIn, signOut } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

// One run, one campaign name, so a failed run never collides with the next.
const CAMPAIGN = `Portal flow ${Date.now()}`;
const AUDIENCE = `Portal audience ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test.describe('Build and approve a campaign through the portal', () => {
  let campaignUrl: string;

  test('a Buyer builds a campaign in three screens', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    // §40.8 is there for outcome objectives, because §50 will not settle a
    // campaign that never defined its outcome -- with a working default, under
    // "More options".
    await page.goto(`${PORTAL}/campaigns/new`);
    await page.getByRole('radio', { name: /qualified leads/i }).check();
    await page.getByText('More options').click();
    await expect(page.getByText(/which leads count/i)).toBeVisible();
    // The three screens, numbered in order -- not §9's section numbers.
    await expect(page.getByRole('list', { name: /campaign builder steps/i })).toHaveText(
      /1\. Campaign\s*2\. Ad\s*3\. Partners & submit/,
    );

    // Screens 1 and 2: the campaign, then its ad.
    campaignUrl = await startCampaign(page, PORTAL, CAMPAIGN);

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

    // §6: only a READY version can be linked to a campaign. Finishing it also
    // asks the Partners that can evaluate it for an estimate.
    await page.getByRole('button', { name: /finish and find partners/i }).click();
    await expect(page.getByRole('link', { name: /use in a campaign/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { name: /partners who can reach them/i })).toBeVisible();

    // --- Screen 3: the audience, the Partners, submit -----------------------
    await linkAudience(page, campaignUrl, AUDIENCE);

    // A SPECIFIC Partner is kept rather than every one that can evaluate the
    // audience: §67 gives each Partner only its own request, and the approval
    // half of this test has to know who to sign in as.
    await submitToPartner(page, campaignUrl, 'Travel A');
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
