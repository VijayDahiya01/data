import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import {
  issueUserAccessToken,
  verifyUserAccessToken,
  issueAgentAccessToken,
  USER_TOKEN_AUDIENCE,
} from './index.js';

const ISSUER = 'https://api.oolix.example';
const KID = 'user-session-2026-09-24-1';
const CLAIMS = {
  sub: '3f1c2d4e-0000-4000-8000-000000000001',
  email: 'priya@example.test',
  sid: '9a8b7c6d-0000-4000-8000-000000000002',
};

let privateKey: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }] };
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('user access tokens', () => {
  it('round-trips: the verifier returns who the token is for', async () => {
    const { access_token, expires_in } = await issueUserAccessToken(CLAIMS, privateKey, KID, {
      issuer: ISSUER,
    });
    expect(expires_in).toBe(600);
    await expect(verifyUserAccessToken(access_token, jwks, { issuer: ISSUER })).resolves.toEqual({
      userId: CLAIMS.sub,
      email: CLAIMS.email,
      sessionFamilyId: CLAIMS.sid,
      issuedAt: expect.any(Number),
    });
  });

  it('refuses a token from another issuer', async () => {
    const { access_token } = await issueUserAccessToken(CLAIMS, privateKey, KID, {
      issuer: 'https://evil.example',
    });
    await expect(verifyUserAccessToken(access_token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses a token meant for another audience', async () => {
    const { access_token } = await issueUserAccessToken(CLAIMS, privateKey, KID, {
      issuer: ISSUER,
      audience: 'oolix-agent-api',
    });
    await expect(verifyUserAccessToken(access_token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses an expired token', async () => {
    const { access_token } = await issueUserAccessToken(CLAIMS, privateKey, KID, {
      issuer: ISSUER,
    });
    const later = new Date(Date.now() + 11 * 60_000);
    await expect(
      verifyUserAccessToken(access_token, jwks, { issuer: ISSUER, now: later }),
    ).rejects.toThrow(/Invalid or expired/);
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const { access_token } = await issueUserAccessToken(CLAIMS, privateKey, KID, {
      issuer: ISSUER,
    });
    const [header, , signature] = access_token.split('.');
    const forged = [
      header,
      b64({ ...CLAIMS, sub: 'someone-else', iss: ISSUER, aud: USER_TOKEN_AUDIENCE, exp: 9e9 }),
      signature,
    ].join('.');
    await expect(verifyUserAccessToken(forged, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses alg:none', async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      ...CLAIMS,
      iss: ISSUER,
      aud: USER_TOKEN_AUDIENCE,
      iat: now,
      exp: now + 600,
    })}.`;
    await expect(verifyUserAccessToken(unsigned, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses HS256 signed with the public key (key confusion)', async () => {
    const publicKeyBytes = new TextEncoder().encode(JSON.stringify(jwks.keys[0]));
    const forged = await new SignJWT({ email: CLAIMS.email, sid: CLAIMS.sid })
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(USER_TOKEN_AUDIENCE)
      .setSubject(CLAIMS.sub)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(publicKeyBytes);
    await expect(verifyUserAccessToken(forged, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses a token signed by a key it does not know', async () => {
    const stranger = await generateKeyPair('ES256');
    const { access_token } = await issueUserAccessToken(CLAIMS, stranger.privateKey, KID, {
      issuer: ISSUER,
    });
    await expect(verifyUserAccessToken(access_token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });

  it('refuses a correctly signed token that lacks the session claim', async () => {
    const token = await new SignJWT({ email: CLAIMS.email })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(USER_TOKEN_AUDIENCE)
      .setSubject(CLAIMS.sub)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    await expect(verifyUserAccessToken(token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /missing the session claim/,
    );
  });

  it('never accepts an Agent token as a user token', async () => {
    // Signed by a different key AND addressed to a different audience -- the
    // two barriers between the kinds of caller.
    const agentKeys = await generateKeyPair('ES256');
    const { access_token } = await issueAgentAccessToken(
      {
        sub: 'oolix_agent_1',
        client_id: 'oolix_agent_1',
        partner_org_id: 'org_partner',
        agent_version: '1.0.0',
        scope: 'config:read',
      },
      agentKeys.privateKey,
      'agent-token-1',
      { issuer: ISSUER, audience: 'oolix-agent-api' },
    );
    await expect(verifyUserAccessToken(access_token, jwks, { issuer: ISSUER })).rejects.toThrow(
      /Invalid or expired/,
    );
  });
});
