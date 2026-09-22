#!/usr/bin/env node
/**
 * Can a privileged role actually sign in and use this deployment? (§4.2, §82)
 *
 * This exists because the answer was silently "no" for six of the nine roles,
 * and everything else looked fine. `auth.guard.ts` refuses PARTNER_ADMIN,
 * PARTNER_SECURITY_ADMIN, PARTNER_CAMPAIGN_APPROVER, FINANCE, BUYER_ADMIN and
 * OOLIX_ADMIN unless the access token carries MFA evidence -- and only when
 * APP_ENV is exactly `production`, which is the one configuration no test
 * suite runs under. A deployment can pass preflight, serve HTTPS, report every
 * service healthy, sign a Partner admin in successfully, and then answer
 * AUTH_001 to every request they make.
 *
 * Two things have to agree for that not to happen, and they live in different
 * places: the realm has to run an OTP step at the level its `acr.loa.map`
 * calls `mfa`, and the login has to ASK for that level. Unit tests pin each
 * half. Only a real login proves they meet.
 *
 * Run it after the first deployment, and after any change to the realm or to
 * the portal's authorization request:
 *
 *   node scripts/verify-mfa.mjs \
 *     --api https://api.yourdomain.com \
 *     --keycloak https://auth.yourdomain.com \
 *     --portal https://app.yourdomain.com \
 *     --user someone@yourdomain.com --password '...'
 *
 * The account may be brand new: the realm requires enrolment on first sign-in,
 * and this walks that page, reporting the secret it enrolled so the account
 * stays usable. An account that already has an authenticator needs its secret
 * passed with --totp-secret, since there is no way to derive one.
 *
 * Locally, the defaults point at the dev stack and the seeded identities:
 *
 *   node scripts/verify-mfa.mjs
 */
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.API_PUBLIC_URL ?? 'http://localhost:4000' },
    keycloak: {
      type: 'string',
      default: process.env.KEYCLOAK_PUBLIC_URL ?? 'http://localhost:8081',
    },
    portal: { type: 'string', default: process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000' },
    realm: { type: 'string', default: 'oolix' },
    'client-id': { type: 'string', default: process.env.OIDC_CLIENT_ID ?? 'oolix-web' },
    'client-secret': { type: 'string', default: process.env.OIDC_CLIENT_SECRET ?? '' },
    user: { type: 'string', default: 'buyer.admin@example.test' },
    password: { type: 'string', default: 'password' },
    'totp-secret': { type: 'string', default: process.env.DEV_TOTP_SECRET ?? '' },
  },
});

const API = values.api.replace(/\/$/, '');
const KC = values.keycloak.replace(/\/$/, '');
const REDIRECT = `${values.portal.replace(/\/$/, '')}/api/auth/callback`;

if (!values['client-secret']) {
  console.error('--client-secret is required (or set OIDC_CLIENT_SECRET).');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('This check drives a real browser and needs @playwright/test.');
  console.error('Run it from a checkout with `pnpm install`, not from the droplet.');
  process.exit(2);
}

const b64url = (b) => b.toString('base64url');
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

/**
 * RFC 6238 TOTP. The HMAC key is the secret's own bytes -- Keycloak shows a
 * base32 rendering of those bytes for typing into a phone, and using that
 * rendering as the key yields six plausible digits that never validate.
 */
function totp(secret, when = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(Math.floor(when / 1000 / 30)));
  const d = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = d[d.length - 1] & 0x0f;
  const code =
    ((d[o] & 0x7f) << 24) |
    ((d[o + 1] & 0xff) << 16) |
    ((d[o + 2] & 0xff) << 8) |
    (d[o + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/** One complete browser login. Returns the access token and what it took. */
async function login(browser, { requestMfa }) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const authorize = new URL(`${KC}/realms/${values.realm}/protocol/openid-connect/auth`);
  authorize.searchParams.set('client_id', values['client-id']);
  authorize.searchParams.set('redirect_uri', REDIRECT);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid profile email');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', b64url(randomBytes(8)));
  if (requestMfa) authorize.searchParams.set('acr_values', 'mfa');

  // A fresh context per login: an SSO cookie would reuse the level the last
  // login reached, and both runs would report the same answer.
  const context = await browser.newContext();
  const page = await context.newPage();

  let redirected = null;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.url().startsWith(REDIRECT)) redirected = req.url();
  });

  let enrolled = null;
  try {
    await page.goto(authorize.href, { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(values.user);
    await page.locator('#password').fill(values.password);
    await page.locator('#kc-login, input[type=submit]').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    // A new account meets the CONFIGURE_TOTP required action and is asked to
    // enrol; the page hands over the secret it just generated.
    if (await page.locator('#totpSecret').count()) {
      enrolled = (await page.locator('#totpSecret').inputValue()).replace(/\s+/g, '');
      await page.locator('#totp').fill(totp(enrolled));
      const label = page.locator('#userLabel');
      if (await label.count()) await label.fill('oolix-verify-mfa');
      await page.locator('#saveTOTPBtn, input[type=submit]').first().click();
    } else if (await page.locator('#otp').count()) {
      const secret = values['totp-secret'];
      if (!secret) {
        throw new Error(
          'this account already has an authenticator; pass its secret with --totp-secret, ' +
            'or run against a freshly created account',
        );
      }
      await page.locator('#otp').fill(totp(secret));
      await page.locator('#kc-login, input[type=submit]').first().click();
    }

    for (let i = 0; i < 60 && !redirected; i += 1) await page.waitForTimeout(250);
  } finally {
    await context.close();
  }

  if (!redirected) throw new Error(`the login did not complete (acr_values=${requestMfa})`);
  const code = new URL(redirected).searchParams.get('code');
  if (!code) throw new Error(`the redirect carried no authorization code`);

  const res = await fetch(`${KC}/realms/${values.realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: values['client-id'],
      client_secret: values['client-secret'],
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return { token: (await res.json()).access_token, enrolled };
}

async function callApi(token) {
  const res = await fetch(`${API}/v1/me/context`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  let code = '';
  try {
    const parsed = JSON.parse(body);
    code = parsed?.error?.code ?? parsed?.code ?? '';
  } catch {
    /* a non-JSON body is itself informative; it is printed on failure */
  }
  return { status: res.status, code, body: body.slice(0, 200) };
}

console.log(`\nMFA sign-in check -- ${API}\n`);

const ready = await fetch(`${API}/readyz`)
  .then((r) => r.json())
  .catch(() => null);
if (!ready) {
  console.error(`  FAIL  the API is not answering at ${API}`);
  process.exit(1);
}
if (ready.environment !== 'production') {
  // Not a failure of the sign-in path, but the result would mean nothing: the
  // guard's MFA branch does not run outside production.
  console.log(`  SKIP  APP_ENV is "${ready.environment}", not production`);
  console.log('        The MFA requirement is not enforced here, so this check');
  console.log('        cannot tell you whether a real deployment would work.\n');
  process.exit(0);
}

const browser = await chromium.launch();
let failures = 0;
try {
  const withMfa = await login(browser, { requestMfa: true });
  const acrWith = decode(withMfa.token).acr;
  const resWith = await callApi(withMfa.token);
  if (withMfa.enrolled) {
    console.log(`  NOTE  enrolled a new authenticator, secret: ${withMfa.enrolled}`);
    console.log('        Add it to an authenticator app or the account cannot sign in again.');
  }
  if (resWith.status === 200) {
    console.log(`  PASS  ${values.user} can use the product  acr=${acrWith}`);
  } else {
    console.log(
      `  FAIL  ${values.user} is locked out  acr=${acrWith}, API ${resWith.status} ${resWith.code}`,
    );
    console.log(`        ${resWith.body}`);
    failures += 1;
  }

  const withoutMfa = await login(browser, { requestMfa: false });
  const acrWithout = decode(withoutMfa.token).acr;
  const resWithout = await callApi(withoutMfa.token);
  if (resWithout.status !== 200) {
    console.log(
      `  PASS  a login without MFA is still refused  acr=${acrWithout}, ${resWithout.code || resWithout.status}`,
    );
  } else {
    console.log(`  FAIL  a login without MFA was ACCEPTED  acr=${acrWithout}`);
    console.log('        The §4.2 requirement is not being enforced.');
    failures += 1;
  }
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures += 1;
} finally {
  await browser.close();
}

console.log();
if (failures > 0) {
  console.log(
    `${failures} failure(s). Do not demo or onboard a Partner against this deployment.\n`,
  );
  process.exit(1);
}
console.log('MFA sign-in works and is enforced.\n');
