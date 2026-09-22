/**
 * Signing in, once, for every portal suite (§34, §35, §64, §4.2).
 *
 * Every suite used to carry its own copy of this. That was harmless while a
 * login was a username and a password; it stopped being harmless when the
 * realm started requiring a second factor, because a copy that does not know
 * about the OTP step fails with "timed out waiting for the portal origin" --
 * which reads like the portal is broken rather than like the login grew a
 * page. One implementation means the next suite cannot be written without it.
 *
 * The realm's browser flow runs OTP at Level of Authentication 2, and the
 * portal asks for that level on every login (see apps/web-portal/src/lib/oidc
 * -- `acr_values`). The API then refuses the privileged roles unless the token
 * says MFA happened, so a suite that signs in as a Partner admin is exercising
 * the whole chain rather than just a form.
 */
import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

/**
 * The authenticator secret every seeded development identity carries.
 *
 * Fixed on purpose: Playwright workers are separate processes, so a secret
 * discovered by enrolling in one worker is unavailable in the next, and the
 * second worker would sit on an OTP page it cannot answer. Seeding the same
 * known secret for all of them makes the code a pure function of the clock.
 *
 * It never reaches a deployment: these identities are merged into the realm
 * only when KC_SEED_USERS is exactly "true", and `render-realm.mjs` refuses to
 * seed them at all into a realm that requires TLS.
 */
export const DEV_TOTP_SECRET = process.env.DEV_TOTP_SECRET ?? 'oolix-dev-totp-secret';

/**
 * RFC 6238 TOTP -- the six digits an authenticator app would be showing.
 *
 * The HMAC key is the secret's own bytes. Keycloak shows a base32 rendering of
 * those bytes for typing into a phone; feeding that rendering in as the key
 * instead produces six plausible digits that never validate.
 */
export function totpCode(secret: string = DEV_TOTP_SECRET, when: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(Math.floor(when / 1000 / 30)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const truncated =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(truncated % 1_000_000).padStart(6, '0');
}

/** The 30-second TOTP step a moment falls in. Steps are epoch-aligned. */
const stepAt = (when: number = Date.now()): number => Math.floor(when / 1000 / 30);

/**
 * Which step each account has already spent a code from.
 *
 * The realm sets `otpPolicyCodeReusable: false`, which is the correct setting
 * and is why this bookkeeping exists: Keycloak remembers the step a code came
 * from and refuses that step again. Suites sign the same user in repeatedly
 * and far faster than 30 seconds apart, so replaying the arithmetic without
 * this produces "Invalid authenticator code" on the second attempt -- and the
 * test then fails on a timeout waiting for the portal, pointing at the portal.
 *
 * Per worker rather than global, which is enough because this config runs
 * `workers: 1`. The retry below covers the rest anyway.
 */
const spentStep = new Map<string, number>();

/** Sleep to just past the next step boundary, so a fresh code is available. */
async function waitForFreshCode(page: Page): Promise<void> {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
}

/**
 * Answer the second factor, whichever form it takes.
 *
 * A seeded identity already carries an authenticator and is challenged for a
 * code. An account created some other way meets the realm's CONFIGURE_TOTP
 * required action and is asked to enrol instead; that page hands over the
 * secret it just generated, so the same code calculation finishes both.
 */
async function completeSecondFactor(page: Page, email: string): Promise<void> {
  const enrolmentSecret = page.locator('#totpSecret');
  if (await enrolmentSecret.count()) {
    const secret = (await enrolmentSecret.inputValue()).replace(/\s+/g, '');
    await page.locator('#totp').fill(totpCode(secret));
    const label = page.locator('#userLabel');
    if (await label.count()) await label.fill('e2e-authenticator');
    await page.locator('#saveTOTPBtn, input[type="submit"]').first().click();
    return;
  }

  if ((await page.locator('#otp').count()) === 0) return;

  // Three attempts spans a full step boundary twice, which is more than one
  // collision can survive.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (spentStep.get(email) === stepAt()) await waitForFreshCode(page);

    await page.locator('#otp').fill(totpCode());
    spentStep.set(email, stepAt());
    await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    // Gone from the OTP page means accepted. Still on it means refused, and
    // the only refusal worth retrying is a code this account already spent.
    if ((await page.locator('#otp').count()) === 0) return;
    await waitForFreshCode(page);
  }
}

/** Sign in through Keycloak as one of the §95 seeded users. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${PORTAL}/login`);
  await page.getByRole('link', { name: /continue to sign in/i }).click();

  // Keycloak's own login form. The portal never sees the password (§64), which
  // is the point of delegating identity at all.
  //
  // Targeted by id rather than by label: these ids are stable across Keycloak
  // themes, while the visible labels are localised.
  await page.waitForURL(/\/realms\/oolix\//, { timeout: 20_000 });
  await page.locator('#username').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();

  // §4.2: the realm asks for the second factor before it will issue a token
  // the API accepts for a privileged role.
  await page.waitForLoadState('domcontentloaded');
  await completeSecondFactor(page, email);

  await page.waitForURL((url) => url.origin === new URL(PORTAL).origin, { timeout: 20_000 });
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
