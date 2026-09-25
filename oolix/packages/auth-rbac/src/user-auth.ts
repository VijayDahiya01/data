/**
 * User access tokens, issued and verified by Oolix itself.
 *
 * Oolix used to delegate sign-in to an OIDC provider (Keycloak). It now checks
 * passwords itself and issues these tokens; docs/SECURITY-REVIEW.md records
 * that decision. What did NOT change is the rule the old module was built on:
 * a token establishes only WHO the caller is. What they may do still comes
 * from organization_members, never from a claim, because §4.2 requires
 * organization and network IDs in every authorization decision and a
 * self-asserted role would turn a signing mistake into privilege escalation.
 *
 * Same construction as the Agent tokens in agent-auth.ts -- ES256, a key from
 * the API's own key store, verified locally with the algorithm pinned -- but a
 * separate key AND a separate audience, so a user token can never be accepted
 * where an Agent token is expected, or the reverse.
 */
import { SignJWT, jwtVerify, createLocalJWKSet, type JWK } from 'jose';
import { OolixError } from '@oolix/contracts';

type SigningKey = Parameters<SignJWT['sign']>[0];

/**
 * Short, because nothing checks a live token against the session table on
 * every request. Signing out, a password reset or a disabled account stops
 * the REFRESH at once; an access token already handed out lives at most this
 * long. The portal holds it server-side, never in the browser.
 */
export const USER_ACCESS_TOKEN_TTL_SEC = 10 * 60;

export const USER_TOKEN_AUDIENCE = 'oolix-api';

export interface UserAccessTokenClaims {
  /** users.id */
  sub: string;
  email: string;
  /** The sign-in this token descends from: auth_sessions.family_id. */
  sid: string;
}

export interface IssueUserTokenOptions {
  issuer: string;
  audience?: string;
  ttlSeconds?: number;
  now?: Date;
}

export async function issueUserAccessToken(
  claims: UserAccessTokenClaims,
  signingKey: SigningKey,
  kid: string,
  opts: IssueUserTokenOptions,
): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
  const ttl = opts.ttlSeconds ?? USER_ACCESS_TOKEN_TTL_SEC;
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);

  const access_token = await new SignJWT({ email: claims.email, sid: claims.sid, amr: ['pwd'] })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience ?? USER_TOKEN_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ttl)
    .setJti(crypto.randomUUID())
    .sign(signingKey);

  return { access_token, token_type: 'Bearer', expires_in: ttl };
}

export interface VerifiedUserToken {
  userId: string;
  email: string;
  sessionFamilyId: string;
  /** Unix seconds. Lets a password change invalidate tokens issued before it. */
  issuedAt: number;
}

export async function verifyUserAccessToken(
  token: string,
  jwks: { keys: JWK[] },
  opts: { issuer: string; audience?: string; now?: Date },
): Promise<VerifiedUserToken> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: opts.issuer,
      audience: opts.audience ?? USER_TOKEN_AUDIENCE,
      // Pinned: an unpinned verifier accepts alg:none, and HS256 signed with
      // the PUBLIC key -- the classic key-confusion forgery.
      algorithms: ['ES256'],
      clockTolerance: 5,
      ...(opts.now ? { currentDate: opts.now } : {}),
    }));
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Invalid or expired access token.', { cause });
  }

  const { sub, email, sid, iat } = payload as {
    sub?: unknown;
    email?: unknown;
    sid?: unknown;
    iat?: unknown;
  };
  if (typeof sub !== 'string' || !sub) {
    throw new OolixError('AUTH_001', 'Token is missing the subject claim.');
  }
  if (typeof email !== 'string' || !email) {
    throw new OolixError('AUTH_001', 'Token is missing the email claim.');
  }
  if (typeof sid !== 'string' || !sid) {
    throw new OolixError('AUTH_001', 'Token is missing the session claim.');
  }
  if (typeof iat !== 'number') {
    throw new OolixError('AUTH_001', 'Token is missing the issued-at claim.');
  }

  return { userId: sub, email, sessionFamilyId: sid, issuedAt: iat };
}
