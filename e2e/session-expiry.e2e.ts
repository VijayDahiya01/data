/**
 * An expired session must never leave a user stranded on a form.
 *
 * A page load already handles this: `requireContext()` turns a dead session
 * into a redirect to login. A form submit did not — it fell through to the
 * generic error branch and printed the raw Error text, "No active portal
 * session.", into the red notice above the form. Nothing said what had
 * happened, nothing said what to do, and the page could never succeed again
 * however many times it was submitted.
 *
 * Sessions expire constantly in a real portal, so this is an ordinary path,
 * not an edge case.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

test('a session that dies mid-form sends the user to sign in, not to an error', async ({
  page,
  context,
}) => {
  await signIn(page, 'buyer.admin@example.test');

  await page.goto(`${PORTAL}/campaigns/new`);
  await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();

  // Fill the form while signed in, so the submit itself is valid and the ONLY
  // thing wrong is the session.
  await page.getByLabel('Campaign name').fill(`Session expiry ${Date.now()}`);
  await page.getByLabel(/what should this campaign achieve/i).selectOption('QUALIFIED_LEADS');

  // Drop the session cookie without touching the page — exactly what an expired
  // or revoked session looks like to the next server action.
  await context.clearCookies();

  await page.getByRole('button', { name: /create draft/i }).click();

  await page.waitForURL(/\/login/, { timeout: 20_000 });
  await expect(page.getByText(/your session ended/i)).toBeVisible();

  // The words that used to appear here are the ones a Buyer cannot act on.
  await expect(page.getByText(/no active portal session/i)).toHaveCount(0);
});
