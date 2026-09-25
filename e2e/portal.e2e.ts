/**
 * Portal end-to-end (§34, §35, §40, §41).
 *
 * This suite drives the real thing: a real sign-in, the real API, a
 * real Partner Agent's data. It is the proof that "sign in and run a campaign"
 * is actually possible rather than merely wired up.
 *
 * It is skipped unless the full local stack is running, because unlike the
 * Mock Partner suite it cannot start its own dependencies. Run:
 *
 *   pnpm infra:up && pnpm dev:api && pnpm --filter @oolix/web-portal start
 *   pnpm test:e2e:portal
 */
import { expect, test } from '@playwright/test';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

test.describe('Portal', () => {
  test('a Buyer signs in and sees Buyer navigation, not Partner navigation', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    await expect(page.getByRole('navigation')).toContainText('Campaigns');
    // v6 §18.1: Audiences is the Buyer's route to describing who they want.
    await expect(page.getByRole('navigation')).toContainText('Audiences');

    // And it is the ONLY route. The prebuilt-segment path is no longer offered
    // as an alternative way to do the same job — §19 still exists in the API
    // for campaigns already running on it, but a Buyer is not asked to choose
    // between describing an audience and shopping through someone else's list.
    await expect(page.getByRole('navigation').getByText(/Prebuilt/i)).toHaveCount(0);

    // §34: navigation is per persona. A Buyer must not be offered a Partner's
    // approval queue, and §4.2 means that follows from permissions rather than
    // from a hard-coded role check.
    await expect(page.getByRole('navigation')).not.toContainText('Campaign requests');
    await expect(page.getByRole('navigation')).not.toContainText('Payouts');
  });

  test('a Partner approver sees the review queue and no campaign builder', async ({ page }) => {
    await signIn(page, 'partner.approver@example.test');

    await expect(page.getByRole('navigation')).toContainText('Campaign requests');
    // §66: this role approves and nothing else. Both supply-publishing entries
    // need `segment:manage`, which an approver does not hold.
    //
    // Named against the CURRENT labels: this asserted 'Audience segments', a
    // label that no longer exists for any persona, so it had become a check
    // that could not fail.
    await expect(page.getByRole('navigation')).not.toContainText('Prebuilt segments');
    await expect(page.getByRole('navigation')).not.toContainText('Audience capabilities');
  });

  test('the access token never reaches the browser (§82)', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    // The session cookie is sealed and httpOnly, so document.cookie cannot see
    // it and no script on the page can lift a token and replay it.
    const readable = await page.evaluate(() => document.cookie);
    expect(readable).not.toContain('oolix_session');

    const storage = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);

    const html = await page.content();
    expect(html).not.toMatch(/eyJhbGciOi/);
  });

  test('the Buyer catalogue shows reach as a bucket and never sums it (§72)', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/discover`);

    await expect(page.getByRole('heading', { name: /audience discovery/i })).toBeVisible();
    // A bucket label, never a precise figure.
    await expect(page.locator('body')).toContainText(/–|under|over/i);
    await expect(page.locator('body')).toContainText(/not.*(added|summed|deduplicat)/i);
  });

  test('a Partner sees everything §41 requires before deciding', async ({ page }) => {
    await signIn(page, 'partner.approver@example.test');
    await page.goto(`${PORTAL}/partner/requests?status=APPROVED`);

    const firstRequest = page.locator('table a').first();
    if ((await firstRequest.count()) === 0) test.skip(true, 'no requests seeded yet');
    await firstRequest.click();

    const body = page.locator('body');
    // §41's checklist, in the order a decision actually needs it.
    await expect(body).toContainText(/who is advertising/i);
    await expect(body).toContainText(/purpose/i);
    await expect(body).toContainText(/frequency|cap/i);
    // The requirement is that a Partner knows their approval binds to ONE exact
    // creative. The screen used to prove that by printing a truncated SHA-256,
    // which a Partner cannot check against anything; it now says so in words.
    await expect(body).toContainText(/this exact creative/i);
    await expect(body).toContainText(/audience expansion/i);
    await expect(body).toContainText(/commercial basis/i);

    // §31 is stated on the screen where it applies. On an OPEN request that is
    // "this decision is yours"; on one already decided it is the standing right
    // to revoke, which §24 makes unilateral and immediate. Asserting whichever
    // applies keeps the test honest about which state it found.
    const open = await body.getByText(/decision is yours/i).count();
    if (open > 0) {
      await expect(body).toContainText(/decision is yours/i);
    } else {
      await expect(body).toContainText(/unilateral and immediate|stopped at any time/i);
    }
  });

  test('a Partner never sees another Partner in its own screens (§67)', async ({ page }) => {
    await signIn(page, 'partner.approver@example.test');
    await page.goto(`${PORTAL}/partner/requests?status=APPROVED`);

    // "Rewards B" is the OTHER seeded Data Partner. Travel A's queue must not
    // name it anywhere.
    await expect(page.locator('body')).not.toContainText('Rewards B');
  });

  test('no screen exposes a customer identifier (§54, §73)', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');

    for (const path of ['/partner', '/partner/requests', '/partner/segments']) {
      const response = await page.goto(`${PORTAL}${path}`);
      if (!response || response.status() >= 400) continue;

      const html = await page.content();
      expect(html).not.toContain('partner_user_id');
      // The §95 fixture identities live only inside the Partner's own systems.
      expect(html).not.toMatch(/\bU123\b/);
      expect(html).not.toMatch(/\bU456\b/);
    }
  });

  test('signing out ends the session', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');

    // Sign-out posts to the portal, which revokes the session at the API,
    // clears its cookie and lands on /login. Waiting for /login covers that
    // whole round trip; navigating before it completes would race the clear.
    await Promise.all([
      page.waitForURL(/\/login/, { timeout: 30_000 }),
      page.getByRole('button', { name: /sign out/i }).click(),
    ]);

    await page.goto(`${PORTAL}/dashboard`);
    // Back to login, not to a dashboard rendered from a stale cookie.
    await expect(page).toHaveURL(/\/login/);
  });
});
