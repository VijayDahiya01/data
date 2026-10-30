/**
 * The Buyer's view of an audience over its life.
 *
 * The backend versioning is unchanged and deliberately so: every set of saved
 * settings is kept, each with its own rule hash, and a campaign stays frozen to
 * the exact pair its Data Partners approved. What this covers is that none of
 * that machinery reaches the Buyer as machinery — they see Draft, Ready, In Use
 * and a dated change history, and never a version number or SUPERSEDED.
 *
 * The two are easy to let drift apart, because hiding a number is a one-line
 * change and re-exposing it is too.
 */
import { expect, test } from '@playwright/test';
import { buildShoeAudience } from './lib/audience-builder';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';
const AUDIENCE = `Lifecycle ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test.describe('An audience as the Buyer sees it', () => {
  test('a draft is finished in one press, in Buyer words throughout', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await buildShoeAudience(page, PORTAL, AUDIENCE);

    const body = page.locator('body');

    // Draft, said as "Draft" -- not DRAFT, and not "version 1".
    await expect(body).toContainText('Draft');
    await expect(page.getByText(/\bVersion \d|\bv\d\b/)).toHaveCount(0);
    await expect(page.getByText(/SUPERSEDED/i)).toHaveCount(0);

    // The structure a Buyer reads down: who, then who can reach them.
    await expect(page.getByRole('heading', { name: 'Who', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Partners who can reach them' })).toBeVisible();

    // Required conditions carry a tick; all four of this audience's do.
    await expect(page.locator('.rule-list .rule-tick')).toHaveCount(4);

    // A draft says no Partner sees it, and finishing it is one press -- which
    // also asks the Partners that can evaluate it, so there is no separate
    // page of checkboxes for that.
    await expect(body).toContainText(/no Partner sees it yet/i);
    await page.getByRole('button', { name: /finish and find partners/i }).click();
    await expect(page.getByRole('link', { name: /use in a campaign/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.reload();
    await expect(body).toContainText('Ready');
    await expect(page.getByText(/\bVersion \d|\bv\d\b/)).toHaveCount(0);
  });

  test('change history is dated settings, not a version list', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/audiences`);
    await page.getByRole('link', { name: AUDIENCE }).click();
    await page.waitForURL(/\/audiences\/[0-9a-f-]+$/, { timeout: 20_000 });

    // History lives under More rather than on the reading path.
    const history = page.getByText('Change history', { exact: true });
    await expect(history).toBeVisible();
    await history.click();

    await expect(page.locator('body')).toContainText('Current settings');
    await expect(page.getByText(/SUPERSEDED/)).toHaveCount(0);
  });

  test('an audience with nothing Required warns that it matches broadly', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    const name = `All optional ${Date.now()}`;
    await buildShoeAudience(page, PORTAL, name);

    // Reopen for editing and demote every condition to Optional. Required is
    // the default, so each condition's choice is folded until opened.
    await page.getByText('Edit conditions', { exact: true }).click();
    const folds = page.locator('details.advanced');
    for (let i = 0; i < (await folds.count()); i += 1) {
      await folds.nth(i).evaluate((d) => ((d as HTMLDetailsElement).open = true));
    }
    const optionalButtons = page.getByRole('button', { name: 'Optional', exact: true });
    const count = await optionalButtons.count();
    for (let i = 0; i < count; i += 1) {
      await optionalButtons.nth(i).click();
    }
    await page.getByRole('button', { name: /save rules/i }).click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(/Nothing is required, so almost any Partner matches/i)).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    // And the Required list really is empty, not merely captioned as such.
    await expect(page.locator('.rule-list .rule-tick')).toHaveCount(0);
  });

  test('the audiences list shows a Buyer status and no version number', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/audiences`);

    const row = page.locator('tr', { hasText: AUDIENCE }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Ready|In Use|Draft/);
    await expect(row.getByText(/\bv\d\b/)).toHaveCount(0);
  });
});
