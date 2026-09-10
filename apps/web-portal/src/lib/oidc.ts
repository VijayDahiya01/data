/**
 * OIDC authorization-code flow with PKCE (§64, §82).
 *
 * The portal is a CONFIDENTIAL client: the code exchange happens on this
 * server with a client secret, and the resulting tokens never reach the
 * browser. PKCE is used anyway -- it costs nothing and removes the code
 * interception attack entirely, which matters because the redirect passes
 * through the user's browser either way.
 */
import 'server-only';
import * as client from 'openid-client';
import { callbackUrl, env } from './env';

let cached: Promise<client.Configuration> | undefined;

export function oidcConfig(): Promise<client.Configuration> {
  // Discovery is cached for the process lifetime: re-fetching the issuer
  // metadata on every login would add a round trip to a page the user is
  // already waiting on.
  const issuer = new URL(env().OIDC_ISSUER_URL);

  // openid-client refuses plain HTTP by default, which is the right default:
  // an unencrypted token endpoint hands every session to anyone on the path.
  // The local Keycloak (§64's compose stack) is http://localhost, so the
  // exception is scoped to exactly that -- loopback, outside production. A
  // real deployment reaching this branch would be a misconfiguration worth
  // failing on.
  const isLoopback = issuer.hostname === 'localhost' || issuer.hostname === '127.0.0.1';
  const insecureAllowed =
    issuer.protocol === 'http:' && isLoopback && env().APP_ENV !== 'production';

  cached ??= client
    .discovery(
      issuer,
      env().OIDC_CLIENT_ID,
      env().OIDC_CLIENT_SECRET,
      undefined,
      insecureAllowed ? { execute: [client.allowInsecureRequests] } : undefined,
    )
    // Only a SUCCESSFUL discovery is worth keeping. Caching the promise itself
    // means a single failure — the identity provider restarting, a network
    // blip — is remembered for the lifetime of the process, and every login
    // after it fails with the original error until someone restarts the
    // portal. Dropping the cache on rejection makes the next attempt retry.
    .catch((err: unknown) => {
      cached = undefined;
      throw err;
    });

  return cached;
}

export interface LoginChallenge {
  authorizationUrl: string;
  codeVerifier: string;
  state: string;
}

export async function beginLogin(): Promise<LoginChallenge> {
  const config = await oidcConfig();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const authorizationUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(),
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    // §67: the API validates the audience on the access token, so it has to be
    // requested here rather than assumed.
    audience: process.env.OIDC_AUDIENCE ?? 'oolix-api',
  }).href;

  return { authorizationUrl, codeVerifier, state };
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  subject: string;
  email?: string;
  idToken?: string;
}

export async function completeLogin(
  currentUrl: URL,
  checks: { codeVerifier: string; state: string },
): Promise<ExchangedTokens> {
  const config = await oidcConfig();

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: checks.codeVerifier,
    expectedState: checks.state,
  });

  const claims = tokens.claims();
  if (!claims?.sub) {
    // §4.2: the subject is the only identity claim Oolix stores. Without it
    // there is nothing to bind the local user record to.
    throw new Error('The identity provider returned no subject claim.');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    // 30 seconds of headroom so a request that starts just before expiry does
    // not arrive just after it.
    expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000 - 30_000,
    subject: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email : undefined,
    idToken: tokens.id_token,
  };
}

export async function refresh(refreshToken: string): Promise<ExchangedTokens> {
  const config = await oidcConfig();
  const tokens = await client.refreshTokenGrant(config, refreshToken);
  const claims = tokens.claims();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000 - 30_000,
    subject: String(claims?.sub ?? ''),
    email: typeof claims?.email === 'string' ? claims.email : undefined,
    idToken: tokens.id_token,
  };
}

/**
 * RP-initiated logout, so the Keycloak session ends too rather than only ours.
 *
 * Identified by `client_id` rather than `id_token_hint`: the ID token is not
 * kept in the session, because access + refresh + id together overflow the
 * 4 KB cookie limit and browsers discard an oversized cookie in silence.
 */
export async function endSessionUrl(): Promise<string | null> {
  try {
    const config = await oidcConfig();
    return client.buildEndSessionUrl(config, {
      post_logout_redirect_uri: env().WEB_PUBLIC_URL,
      client_id: env().OIDC_CLIENT_ID,
    }).href;
  } catch {
    // An issuer without an end-session endpoint is not a failure worth showing
    // the user -- the local session is already gone.
    return null;
  }
}
