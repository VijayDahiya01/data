/**
 * A campaign that cannot be submitted must say why.
 *
 * This is here because it happened to real users, twice: they built a
 * campaign, reached the last step, and found "Submit for Partner review"
 * greyed out with nothing beside it -- or, later, "No Data Partner has been
 * added" with the way to add one folded away in a collapsed row. Then the
 * campaign did not appear in the Data Partner's queue, which is the same fact
 * seen from the other end: a campaign with no Partner request has nobody to
 * send it to.
 *
 * Screen 3 now lists every Partner that can reach the audience, ticked. What
 * is left to prove is that each way of having nobody to send to is said.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './lib/auth';
import { startCampaign } from './lib/campaign-builder';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

test('a campaign with nobody to send to says so instead of just greying out Submit', async ({
  page,
}) => {
  await signIn(page, 'buyer.admin@example.test');
  await startCampaign(page, PORTAL, `Submit gate ${Date.now()}`);

  // No audience yet: there is no Submit at all, and the way on is right there.
  await expect(page.getByRole('button', { name: /submit for partner review/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /who it is for/i })).toBeVisible();
  await expect(
    page
      .getByRole('button', { name: /link audience/i })
      .or(page.getByRole('link', { name: /build one/i })),
  ).toBeVisible();

  // An audience, but every Partner unticked: Submit is disabled, and says why.
  const options = page.locator('#audience_group_id option:not([value=""])');
  if ((await options.count()) === 0) return; // a fresh stack with no finished audience
  await page.getByLabel('Audience').selectOption(await options.first().getAttribute('value'));
  await page.getByRole('button', { name: /link audience/i }).click();

  const boxes = page.locator('input[name="partner_org_ids"]');
  if ((await boxes.count()) === 0) {
    // Nobody can reach it: said, with the Partners left out and why.
    await expect(page.getByText(/No Partner can reach this audience yet/i)).toBeVisible({
      timeout: 20_000,
    });
    return;
  }
  for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).uncheck();
  await expect(page.getByRole('button', { name: /submit for partner review/i })).toBeDisabled();
  await expect(page.getByText(/tick at least one partner/i)).toBeVisible();
});
