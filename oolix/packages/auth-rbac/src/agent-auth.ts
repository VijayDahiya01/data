/**
 * Partner Agent workload authentication -- spec v5 §69.3, §92.
 *
 * The flow, and why each step exists:
 *
 *   1. PARTNER_SECURITY_ADMIN mints a bootstrap token. 32 random bytes,
 *      single-use, 15 minutes. Only SHA-256(token) is stored (§92.1), so a
 *      database read cannot reveal a usable credential.
 *   2. The Agent generates a P-256 keypair locally. The private key NEVER
 *      leaves Partner infrastructure (§92.2) -- Oolix therefore cannot forge
 *      an Agent's signature, which is what makes signed report batches
 *      meaningful as tamper evidence.
 *   3. The Agent registers with the bootstrap token + public key. Oolix
 *      revokes the bootstrap token in the SAME transaction (§92.2).
 *   4. Thereafter the Agent proves possession of the private key with an
 *      ES256 client assertion and receives a 15-minute access token (§92.3).
 */
import { SignJWT, jwtVerify, createLocalJWKSet, decodeProtectedHeader, type JWK } from 'jose';
import { OolixError } from '@oolix/contracts';
import { AGENT_SCOPES, type AgentScope } from './principal.js';

/**
 * The key material jose accepts for signing. Derived from jose's own signature
 * rather than naming CryptoKey/KeyObject directly: those types come from
 * different lib sets (DOM vs @types/node), and deriving keeps this correct
 * across both without widening the package's lib configuration.
 */
type SigningKey = Parameters<SignJWT['sign']>[0];

/** §92.1: bootstrap token lifetime. */
export const BOOTSTRAP_TOKEN_TTL_SEC = 15 * 60;

/** §92.3 / §69.3: access token lifetime. */
export const AGENT_ACCESS_TOKEN_TTL_SEC = 15 * 60;

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** Client assertions are single-use within this window (replay defence). */
export const CLIENT_ASSERTION_MAX_AGE_SEC = 300;

export interface AgentAccessTokenClaims {
  sub: string;
  client_id: string;
  partner_org_id: string;
  agent_version: string;
  scope: string;
}

export interface IssueTokenOptions {
  issuer: string;
  audience: string;
  ttlSeconds?: number;
  now?: Date;
}

/**
 * Mint the short-lived access token the Agent presents on /agent/v1/* calls.
 *
 * Signed with the Oolix key, not the Agent key: this is Oolix asserting who
 * the Agent is, having already verified the Agent's client assertion.
 */
export async function issueAgentAccessToken(
  claims: AgentAccessTokenClaims,
  signingKey: SigningKey,
  kid: string,
  opts: IssueTokenOptions,
): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
  const ttl = opts.ttlSeconds ?? AGENT_ACCESS_TOKEN_TTL_SEC;
  const now = opts.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);

  const access_token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(iat + ttl)
    .setJti(crypto.randomUUID())
    .sign(signingKey);

  return { access_token, token_type: 'Bearer', expires_in: ttl };
}

export interface VerifiedAgentToken {
  agentId: string;
  clientId: string;
  partnerOrgId: string;
  agentVersion: string;
  scopes: AgentScope[];
}

/**
 * §92.4 steps 1-3: verify the Oolix-issued access token and bind it to the
 * X-Agent-Id header.
 *
 * The header check is not redundant. Without it, a valid token for Agent A
 * could be replayed while claiming to be Agent B, and per-Agent rate limits
 * and audit trails would attribute the call to the wrong Partner.
 */
export async function verifyAgentAccessToken(
  token: string,
  headerAgentId: string,
  jwks: { keys: JWK[] },
  opts: { issuer: string; audience: string; now?: Date },
): Promise<VerifiedAgentToken> {
  const keySet = createLocalJWKSet(jwks);

  let verified;
  try {
    verified = await jwtVerify(token, keySet, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['ES256'],
      ...(opts.now ? { currentDate: opts.now } : {}),
    });
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Invalid or expired agent access token.', { cause });
  }

  const p = verified.payload as unknown as AgentAccessTokenClaims & { sub: string };

  if (!p.sub || p.sub !== headerAgentId) {
    throw new OolixError('AUTH_001', 'Access token subject does not match X-Agent-Id.');
  }
  if (!p.partner_org_id) {
    throw new OolixError('AUTH_001', 'Access token is missing partner binding.');
  }

  const scopes = String(p.scope ?? '')
    .split(' ')
    .filter((s): s is AgentScope => (AGENT_SCOPES as readonly string[]).includes(s));

  return {
    agentId: p.sub,
    clientId: p.client_id,
    partnerOrgId: p.partner_org_id,
    agentVersion: p.agent_version,
    scopes,
  };
}

export interface VerifiedClientAssertion {
  clientId: string;
  jti: string;
  expiresAt: Date;
}

/**
 * §92.3: verify the Agent's ES256 client assertion against its REGISTERED
 * public key.
 *
 * `lookupAgentPublicKeys` returns the current key plus, during a rotation, the
 * previous one -- §69.3 allows at most a 24-hour dual-key overlap so an Agent
 * mid-rollout is never locked out.
 */
export async function verifyClientAssertion(
  assertion: string,
  expectedClientId: string,
  lookupAgentPublicKeys: (clientId: string) => Promise<JWK[]>,
  opts: { issuer: string; audience: string; now?: Date },
): Promise<VerifiedClientAssertion> {
  let header;
  try {
    header = decodeProtectedHeader(assertion);
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Malformed client assertion.', { cause });
  }
  if (header.alg !== 'ES256') {
    throw new OolixError('AUTH_001', `Unsupported client assertion algorithm: ${header.alg}`);
  }

  const keys = await lookupAgentPublicKeys(expectedClientId);
  if (keys.length === 0) {
    throw new OolixError('AUTH_001', 'Unknown agent client_id.');
  }

  let verified;
  try {
    verified = await jwtVerify(assertion, createLocalJWKSet({ keys }), {
      // RFC 7523: the client is both issuer and subject of its own assertion.
      issuer: expectedClientId,
      subject: expectedClientId,
      audience: opts.audience,
      algorithms: ['ES256'],
      ...(opts.now ? { currentDate: opts.now } : {}),
    });
  } catch (cause) {
    throw new OolixError('AUTH_001', 'Client assertion verification failed.', { cause });
  }

  const { payload } = verified;

  if (!payload.jti) {
    // Without a jti the assertion cannot be single-used, so a captured one
    // could be replayed until it expires.
    throw new OolixError('AUTH_001', 'Client assertion must carry a jti.');
  }
  if (!payload.exp) {
    throw new OolixError('AUTH_001', 'Client assertion must carry an exp.');
  }

  const now = (opts.now ?? new Date()).getTime() / 1000;
  const iat = payload.iat ?? now;
  if (now - iat > CLIENT_ASSERTION_MAX_AGE_SEC) {
    throw new OolixError('AUTH_001', 'Client assertion is too old.');
  }
  if (payload.exp - iat > CLIENT_ASSERTION_MAX_AGE_SEC) {
    throw new OolixError('AUTH_001', 'Client assertion lifetime exceeds the permitted maximum.');
  }

  return {
    clientId: expectedClientId,
    jti: String(payload.jti),
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** Scopes granted to a freshly registered Agent. */
export function defaultAgentScopes(): AgentScope[] {
  return [
    'config:read',
    'reporting:write',
    'channel_status:write',
    'heartbeat:write',
    'capabilities:write',
  ];
}
