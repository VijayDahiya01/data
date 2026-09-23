import { describe, it, expect } from 'vitest';
import {
  assertOrgScope,
  assertPermission,
  assertBusinessVerified,
  assertNotSelfApproval,
  assertAgentScope,
  buildUserPermissions,
  canSeeListing,
  hasPermission,
  issueAgentAccessToken,
  verifyAgentAccessToken,
  verifyClientAssertion,
  defaultAgentScopes,
  mfaSatisfied,
  type UserPrincipal,
  type AgentPrincipal,
  type VerifiedIdentity,
} from './index.js';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import type { Role } from '@oolix/contracts';

function user(over: Partial<UserPrincipal> = {}): UserPrincipal {
  const roles: Role[] = over.roles ?? ['BUYER_ADMIN'];
  return {
    kind: 'user',
    userId: 'usr_1',
    authSubject: 'sub_1',
    email: 'a@example.test',
    orgId: 'org_buyer',
    roles,
    permissions: buildUserPermissions(roles),
    networkIds: ['net_1'],
    businessVerified: true,
    mfaSatisfied: true,
    ...over,
  };
}

function agent(over: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    kind: 'agent',
    agentId: 'agent_123',
    clientId: 'oolix_agent_123',
    partnerOrgId: 'org_partner_a',
    scopes: defaultAgentScopes(),
    agentVersion: '0.4.3',
    ...over,
  };
}

describe('§59 organization isolation', () => {
  it('denies access to another organization', () => {
    expect(() => assertOrgScope(user(), { orgId: 'org_other' })).toThrow(
      /Organization access denied/,
    );
  });

  it('allows access within the same organization', () => {
    expect(() => assertOrgScope(user(), { orgId: 'org_buyer' })).not.toThrow();
  });

  it('binds an Agent to its own Partner only', () => {
    expect(() => assertOrgScope(agent(), { orgId: 'org_partner_a' })).not.toThrow();
    expect(() => assertOrgScope(agent(), { orgId: 'org_partner_b' })).toThrow(/denied/);
  });

  it('lets OOLIX_ADMIN operate cross-org', () => {
    const admin = user({ roles: ['OOLIX_ADMIN'], orgId: 'org_oolix' });
    expect(() => assertOrgScope(admin, { orgId: 'org_partner_a' })).not.toThrow();
  });
});

describe('§66 permission boundaries', () => {
  it('stops OOLIX_ADMIN approving a Partner request', () => {
    // §66: platform operations must never bypass Partner approval.
    const admin = user({ roles: ['OOLIX_ADMIN'] });
    expect(hasPermission(admin, 'request:approve')).toBe(false);
    expect(() => assertPermission(admin, 'request:approve')).toThrow(/Missing permission/);
  });

  it('stops a BUYER_OPERATOR submitting a campaign', () => {
    const op = user({ roles: ['BUYER_OPERATOR'] });
    expect(() => assertPermission(op, 'campaign:submit')).toThrow();
    expect(() => assertPermission(op, 'campaign:draft')).not.toThrow();
  });

  it('rejects an Agent principal on user endpoints', () => {
    expect(() => assertPermission(agent(), 'campaign:read')).toThrow(/user principal/);
  });
});

describe('§66.3 verification gate', () => {
  it('blocks submission while verification is pending, but not drafting', () => {
    const pending = user({ businessVerified: false });
    expect(() => assertBusinessVerified(pending, 'Campaign submission')).toThrow(
      /verified business/,
    );
    expect(() => assertPermission(pending, 'campaign:draft')).not.toThrow();
  });
});

describe('§66.2 self-dealing', () => {
  it('prevents the request creator from approving their own request', () => {
    const approver = user({ userId: 'usr_same', roles: ['PARTNER_CAMPAIGN_APPROVER'] });
    expect(() => assertNotSelfApproval(approver, { createdByUserId: 'usr_same' })).toThrow(
      /cannot approve it/,
    );
  });

  it('allows a different approver in the same organization', () => {
    const approver = user({ userId: 'usr_a', roles: ['PARTNER_CAMPAIGN_APPROVER'] });
    expect(() => assertNotSelfApproval(approver, { createdByUserId: 'usr_b' })).not.toThrow();
  });
});

describe('§66.2 catalogue visibility', () => {
  const buyer = user({ orgId: 'org_buyer', networkIds: ['net_1'] });

  it('shows marketplace listings to anyone', () => {
    expect(
      canSeeListing(buyer, { ownerOrgId: 'org_p', visibility: 'MARKETPLACE', networkId: null }),
    ).toBe(true);
  });

  it('hides a private listing from a non-member', () => {
    expect(
      canSeeListing(buyer, {
        ownerOrgId: 'org_p',
        visibility: 'PRIVATE_NETWORK',
        networkId: 'net_2',
      }),
    ).toBe(false);
  });

  it('shows a private listing to a shared-network member', () => {
    expect(
      canSeeListing(buyer, {
        ownerOrgId: 'org_p',
        visibility: 'PRIVATE_NETWORK',
        networkId: 'net_1',
      }),
    ).toBe(true);
  });
});

describe('§92 agent workload authentication', () => {
  const ISSUER = 'https://api.oolix.example';
  const AUDIENCE = 'oolix-agent-api';

  it('issues and verifies an access token bound to X-Agent-Id', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pub = await exportJWK(publicKey);
    pub.kid = 'oolix-agent-signing-1';
    pub.alg = 'ES256';

    const issued = await issueAgentAccessToken(
      {
        sub: 'agent_123',
        client_id: 'oolix_agent_123',
        partner_org_id: 'org_partner_a',
        agent_version: '0.4.3',
        scope: 'config:read reporting:write',
      },
      privateKey,
      'oolix-agent-signing-1',
      { issuer: ISSUER, audience: AUDIENCE },
    );

    expect(issued.expires_in).toBe(900); // §92.3: 15 minutes

    const v = await verifyAgentAccessToken(
      issued.access_token,
      'agent_123',
      { keys: [pub] },
      {
        issuer: ISSUER,
        audience: AUDIENCE,
      },
    );
    expect(v.partnerOrgId).toBe('org_partner_a');
    expect(v.scopes).toEqual(['config:read', 'reporting:write']);

    // Replaying Agent A's token while claiming to be Agent B must fail.
    await expect(
      verifyAgentAccessToken(
        issued.access_token,
        'agent_999',
        { keys: [pub] },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
        },
      ),
    ).rejects.toThrow(/does not match X-Agent-Id/);
  });

  it('enforces scopes per endpoint class', () => {
    const a = agent({ scopes: ['config:read'] });
    expect(() => assertAgentScope(a, 'config:read')).not.toThrow();
    expect(() => assertAgentScope(a, 'reporting:write')).toThrow(/missing scope/);
  });

  it('verifies a client assertion against the registered public key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.alg = 'ES256';

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('oolix_agent_123')
      .setSubject('oolix_agent_123')
      .setAudience('https://api.oolix.example/agent/v1/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(crypto.randomUUID())
      .sign(privateKey);

    const v = await verifyClientAssertion(assertion, 'oolix_agent_123', async () => [pub], {
      issuer: ISSUER,
      audience: 'https://api.oolix.example/agent/v1/token',
    });
    expect(v.clientId).toBe('oolix_agent_123');
    expect(v.jti).toBeTruthy();
  });

  it('rejects a client assertion signed by a key that is not registered', async () => {
    const attacker = await generateKeyPair('ES256', { extractable: true });
    const registered = await generateKeyPair('ES256', { extractable: true });
    const registeredPub = (await exportJWK(registered.publicKey)) as JWK;
    registeredPub.alg = 'ES256';

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('oolix_agent_123')
      .setSubject('oolix_agent_123')
      .setAudience('https://api.oolix.example/agent/v1/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(crypto.randomUUID())
      .sign(attacker.privateKey);

    await expect(
      verifyClientAssertion(assertion, 'oolix_agent_123', async () => [registeredPub], {
        issuer: ISSUER,
        audience: 'https://api.oolix.example/agent/v1/token',
      }),
    ).rejects.toThrow(/verification failed/i);
  });

  it('rejects a long-lived client assertion', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.alg = 'ES256';

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('oolix_agent_123')
      .setSubject('oolix_agent_123')
      .setAudience('https://api.oolix.example/agent/v1/token')
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400) // a day -- far beyond the 5-minute cap
      .setJti(crypto.randomUUID())
      .sign(privateKey);

    await expect(
      verifyClientAssertion(assertion, 'oolix_agent_123', async () => [pub], {
        issuer: ISSUER,
        audience: 'https://api.oolix.example/agent/v1/token',
      }),
    ).rejects.toThrow(/lifetime exceeds/);
  });
});

/**
 * §4.2 / §82: what counts as "MFA happened".
 *
 * This predicate decides whether PARTNER_ADMIN, PARTNER_SECURITY_ADMIN,
 * PARTNER_CAMPAIGN_APPROVER, FINANCE, BUYER_ADMIN and OOLIX_ADMIN can use the
 * product at all on a production deployment -- and it had no tests. The claims
 * below are not invented: the first case is exactly what Keycloak 26 returned
 * before the realm grew a step-up flow, and the second is what it returns now.
 */
describe('§4.2 MFA evidence in a token', () => {
  const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
    authSubject: 'sub_1',
    email: 'person@example.test',
    emailVerified: true,
    amr: [],
    ...over,
  });

  it('refuses a password-only login', () => {
    // Keycloak's built-in browser flow, verbatim: acr is the Level of
    // Authentication and stays "1", and there is no amr claim at all.
    expect(mfaSatisfied(identity({ acr: '1' }))).toBe(false);
  });

  it('accepts the acr the realm step-up flow produces', () => {
    expect(mfaSatisfied(identity({ acr: 'mfa' }))).toBe(true);
  });

  it('accepts the NIST assurance levels', () => {
    expect(mfaSatisfied(identity({ acr: 'aal2' }))).toBe(true);
    expect(mfaSatisfied(identity({ acr: 'aal3' }))).toBe(true);
    expect(mfaSatisfied(identity({ acr: 'aal1' }))).toBe(false);
  });

  it('accepts an amr from an IdP that reports methods', () => {
    // Not every IdP is Keycloak. One that lists methods is just as good.
    expect(mfaSatisfied(identity({ amr: ['pwd', 'otp'] }))).toBe(true);
    expect(mfaSatisfied(identity({ amr: ['hwk'] }))).toBe(true);
    expect(mfaSatisfied(identity({ amr: ['pwd'] }))).toBe(false);
  });

  it('does not care about casing', () => {
    expect(mfaSatisfied(identity({ acr: 'MFA' }))).toBe(true);
    expect(mfaSatisfied(identity({ amr: ['OTP'] }))).toBe(true);
  });

  it('fails closed when the IdP says nothing', () => {
    // No acr, no amr: the absence of evidence is not evidence.
    expect(mfaSatisfied(identity())).toBe(false);
  });
});
