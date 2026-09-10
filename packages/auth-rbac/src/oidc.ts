/**
 * OIDC user token verification -- spec v5 §4.2, §56, §64.
 *
 * Oolix delegates authentication entirely to an OIDC provider (Keycloak
 * locally, a managed provider in hosted environments -- §64). It stores only
 * the subject claim, so the provider can be swapped without touching
 * authorization.
 *
 * Critically, the token establishes only WHO the caller is. What they may do
 * comes from organization_members in the Oolix database, never from a claim in
 * the token: §4.2 requires organization and network IDs to participate in
 * every authorization check, and a self-asserted role claim would let an IdP
 * misconfiguration become a privilege escalation.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OolixError } from '@oolix/contracts';

export interface OidcConfig {
  issuerUrl: string;
  audience: string;
  /** How long the JWKS is cached before refetching. */
  jwksCacheMaxAgeMs?: number;
  clockToleranceSeconds?: number;
}

export interface VerifiedIdentity {
  authSubject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  /** Populated when the IdP reports the authentication methods used. */
  amr: string[];
  /** Authentication Context Class Reference, used for the MFA check. */
  acr?: string;
}

type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

/**
 * Caches one JWKS resolver per issuer. `createRemoteJWKSet` handles its own
 * refresh and cooldown; constructing a new one per request would hammer the
 * IdP and defeat that.
 */
const resolverCache = new Map<string, JwksResolver>();

function resolverFor(cfg: OidcConfig): JwksResolver {
  const jwksUri = new URL(`${cfg.issuerUrl.replace(/\/$/, '')}/protocol/openid-connect/certs`);
  const key = jwksUri.toString();
  let r = resolverCache.get(key);
  if (!r) {
    r = createRemoteJWKSet(jwksUri, {
      cacheMaxAge: cfg.jwksCacheMaxAgeMs ?? 10 * 60_000,
      cooldownDuration: 30_000,
    });
    resolverCache.set(key, r);
  }
  return r;
}

/** Replace the resolver for an issuer. Test seam only. */
export function __setJwksResolver(issuerUrl: string, resolver: JwksResolver): void {
  resolverCache.set(
    new URL(`${issuerUrl.replace(/\/$/, '')}/protocol/openid-connect/certs`).toString(),
    resolver,
  );
}

export async function verifyUserToken(token: string, cfg: OidcConfig): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, resolverFor(cfg), {
      issuer: cfg.issuerUrl,
      audience: cfg.audience,
      clockTolerance: cfg.clockToleranceSeconds ?? 5,
      // Pinned: an unpinned verifier accepts alg:none and HS256-with-public-key
      // confusion attacks.
      algorithms: ['RS256', 'ES256', 'PS256'],
    });
    payload = res.payload;
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Invalid or expired access token.', { cause });
  }

  const sub = payload.sub;
  if (!sub) throw new OolixError('AUTH_001', 'Token is missing the subject claim.');

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  if (!email) throw new OolixError('AUTH_001', 'Token is missing the email claim.');

  return {
    authSubject: sub,
    email,
    emailVerified: payload.email_verified === true,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    amr: Array.isArray(payload.amr) ? (payload.amr as string[]) : [],
    ...(typeof payload.acr === 'string' ? { acr: payload.acr } : {}),
  };
}

/**
 * §4.2 / §82: MFA is required for privileged roles.
 *
 * Interpreting the IdP's signal is provider-specific, so this stays a small,
 * explicit function rather than being scattered through guards. Keycloak
 * reports step-up as acr="mfa" or amr containing "mfa"/"otp".
 */
export function mfaSatisfied(identity: VerifiedIdentity): boolean {
  if (identity.acr && ['mfa', 'aal2', 'aal3'].includes(identity.acr.toLowerCase())) return true;
  return identity.amr.some((m) =>
    ['mfa', 'otp', 'hwk', 'swk', 'pwd+otp'].includes(m.toLowerCase()),
  );
}
