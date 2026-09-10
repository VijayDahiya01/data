/**
 * A disabled Submit button must say why it is disabled.
 *
 * This is here because it happened to a real user: they built a campaign,
 * linked an audience, reached Step 9, and found "Submit for Partner review"
 * greyed out with nothing beside it. Then the campaign did not appear in the
 * Data Partner's queue — which is the same fact seen from the other end, since
 * a campaign with no Partner request has nobody to send it to.
 *
 * `canSubmit` has four conditions and only two of them used to be explained.
 * The most common failure, no Partner added, was silent.
 */
import { expect, test, type Page } from '@playwright/test';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
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

test('a campaign with no Partner says so instead of just greying out Submit', async ({ page }) => {
  await signIn(page, 'buyer.admin@example.test');

  await page.goto(`${PORTAL}/campaigns/new`);
  await page.getByLabel('Campaign name').fill(`Submit gate ${Date.now()}`);
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

  // Straight to review with no Partner added — the exact state that stranded
  // the user.
  await page.goto(`${url}/review`);

  const submit = page.getByRole('button', { name: /submit for partner review/i });
  await expect(submit).toBeDisabled();

  // The reason, and a way to act on it.
  await expect(page.getByText(/No Data Partner has been added to this campaign/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /Partner matches/i })).toBeVisible();
});
