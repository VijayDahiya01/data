/**
 * Signing in, once, for every portal suite (§34, §35).
 *
 * Every suite used to carry its own copy of this, and each copy broke the
 * same way whenever the sign-in page changed: "timed out waiting for the
 * portal", which reads like the portal is broken rather than like the login
 * grew a step. One implementation means the next suite cannot be written
 * without it.
 *
 * It drives the portal's own sign-in form, exactly as a person does: the
 * password goes to a server action, the API checks it, and the tokens come
 * back sealed into an httpOnly cookie the page cannot read.
 */
import { expect, type Page } from '@playwright/test';

export const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

/** Every seeded account shares it (oolix/packages/db/prisma/seed/index.ts). */
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'password';

/**
 * Sign in as one of the §95 seeded users.
 *
 * The API allows ten sign-in attempts a minute per address, and a suite signs
 * in from one address far more often than that. The form then says "Try again
 * in N seconds" -- so this waits N seconds and tries again, rather than
 * failing a test for a reason that has nothing to do with what it tests.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  const portalOrigin = new URL(PORTAL).origin;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${PORTAL}/login`);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(SEED_PASSWORD);

    const left = page.waitForURL(
      (url) => url.origin === portalOrigin && !url.pathname.startsWith('/login'),
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // The form's own error. Scoped to the form because Next.js keeps a route
    // announcer on every page that also has role="alert".
    const refusal = page.locator('form [role="alert"]').first();
    const outcome = await Promise.race([
      left.then(() => 'signed-in' as const),
      refusal.waitFor({ timeout: 20_000 }).then(() => 'refused' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'signed-in') return;

    const message = (await refusal.textContent().catch(() => '')) ?? '';
    const wait = /try again in (\d+) seconds/i.exec(message);
    if (!wait || attempt === 3) {
      throw new Error(`sign-in as ${email} failed: ${message.trim() || outcome}`);
    }
    await page.waitForTimeout((Number(wait[1]) + 1) * 1000);
  }
}

/** Sign out and drop the session cookies, so the next sign-in is a real one. */
export async function signOut(page: Page): Promise<void> {
  await page.goto(`${PORTAL}/dashboard`).catch(() => undefined);
  const button = page.getByRole('button', { name: /sign out/i });
  if (await button.count()) await button.first().click();
  await page.context().clearCookies();
}

/** Assert the portal is reachable before a suite tries to drive it. */
export async function expectPortalUp(page: Page): Promise<void> {
  const res = await page.request.get(`${PORTAL}/login`).catch(() => null);
  expect(res?.ok(), `the portal is not answering at ${PORTAL}`).toBe(true);
}
