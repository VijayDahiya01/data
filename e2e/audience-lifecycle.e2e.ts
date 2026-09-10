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
import { expect, test, type Page } from '@playwright/test';
import { buildShoeAudience } from './lib/audience-builder';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';
const AUDIENCE = `Lifecycle ${Date.now()}`;

async function signIn(page: Page, email: string) {
  await page.goto(`${PORTAL}/login`);
  await page.getByRole('link', { name: /continue to sign in/i }).click();
  await page.waitForURL(/\/realms\/oolix\//, { timeout: 20_000 });
  await page.locator('#username').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
  await page.waitForURL((url) => url.origin === new URL(PORTAL).origin, { timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('An audience as the Buyer sees it', () => {
  test('draft becomes ready through Finalize, in Buyer words throughout', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await buildShoeAudience(page, PORTAL, AUDIENCE);

    const body = page.locator('body');

    // Draft, said as "Draft" -- not DRAFT, and not "version 1".
    await expect(body).toContainText('Draft');
    await expect(page.getByText(/\bVersion \d|\bv\d\b/)).toHaveCount(0);
    await expect(page.getByText(/SUPERSEDED/i)).toHaveCount(0);

    // The structure a Buyer reads down.
    await expect(page.getByRole('heading', { name: 'Audience Conditions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Partner Matches' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reach Estimates' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Linked Campaigns' })).toBeVisible();

    // Required conditions carry a tick; all four of this audience's do.
    await expect(page.locator('.rule-list .rule-tick')).toHaveCount(4);

    // Finalize, with the wording that says what it actually does.
    await expect(body).toContainText(/Finalizing locks these audience settings/i);
    await page.getByRole('button', { name: /finalize audience/i }).click();
    await expect(body).toContainText(/audience finalized|can be used in a campaign/i, {
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

    // Reopen for editing and demote every condition to Optional.
    await page.getByText('Edit audience conditions', { exact: true }).click();
    const optionalButtons = page.getByRole('button', { name: 'Optional', exact: true });
    const count = await optionalButtons.count();
    for (let i = 0; i < count; i += 1) {
      await optionalButtons.nth(i).click();
    }
    await page.getByRole('button', { name: /save rules/i }).click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(/No Required conditions are configured/i)).toBeVisible({
      timeout: 20_000,
    });
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
