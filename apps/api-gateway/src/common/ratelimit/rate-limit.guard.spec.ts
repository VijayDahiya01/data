/**
 * §86 assigns a different budget to each API class. The guard derives that
 * class from the route rather than requiring every handler to declare it, so
 * the derivation itself is the thing that has to be right -- a route that
 * lands in the wrong class is silently over- or under-protected.
 */
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { deriveClass, derivePrincipalKey, orgOf } from './rate-limit.guard.js';

const req = (url: string, method = 'GET', extra: Partial<AuthenticatedRequest> = {}) =>
  ({ url, method, headers: {}, ip: '203.0.113.1', ...extra }) as unknown as AuthenticatedRequest;

const userPrincipal = {
  kind: 'user' as const,
  userId: 'u-1',
  orgId: 'org-1',
} as AuthenticatedRequest['principal'];

const agentPrincipal = {
  kind: 'agent' as const,
  agentId: 'agent-1',
  partnerOrgId: 'org-partner',
} as AuthenticatedRequest['principal'];

describe('deriveClass (§86)', () => {
  it('separates Agent control from Agent reporting', () => {
    // §86 gives control 120/min and reporting 60/min: a config poll every 30s
    // is routine, while a reporting batch carries thousands of counters.
    expect(deriveClass(req('/agent/v1/config/pull'))).toBe('agentControl');
    expect(deriveClass(req('/agent/v1/heartbeat', 'POST'))).toBe('agentControl');
    expect(deriveClass(req('/agent/v1/reporting/batches', 'POST'))).toBe('agentReporting');
    expect(deriveClass(req('/agent/v1/attribution/tokens', 'POST'))).toBe('agentReporting');
  });

  it('puts every outcome-reporting path on the CRM budget', () => {
    // These are the endpoints that move money: an inflated lead count becomes
    // an inflated payout (§50).
    expect(deriveClass(req('/v1/leads/events', 'POST'))).toBe('crmLeadEvents');
    expect(deriveClass(req('/v1/leads/events/batch', 'POST'))).toBe('crmLeadEvents');
    expect(deriveClass(req('/v1/conversions/events', 'POST'))).toBe('crmLeadEvents');
    expect(deriveClass(req('/v1/attribution/click/abc', 'POST'))).toBe('crmLeadEvents');
  });

  it('gives organization creation the signup budget (§86: 5/min/IP)', () => {
    expect(deriveClass(req('/v1/organizations', 'POST'))).toBe('signup');
    // Reading the member list is an ordinary authenticated read, not a signup.
    expect(deriveClass(req('/v1/organizations/members'))).toBe('userRead');
  });

  it('separates catalogue search from ordinary reads', () => {
    expect(deriveClass(req('/v1/catalogue/segments?query=travel'))).toBe('catalogueSearch');
    expect(deriveClass(req('/v1/campaigns'))).toBe('userRead');
  });

  it('defaults writes to the campaign write budget', () => {
    expect(deriveClass(req('/v1/campaigns', 'POST'))).toBe('campaignWrite');
    expect(deriveClass(req('/v1/partner/segments/x', 'PATCH'))).toBe('campaignWrite');
  });

  it('ignores the query string when classifying', () => {
    expect(deriveClass(req('/v1/organizations?foo=/v1/catalogue/', 'POST'))).toBe('signup');
  });
});

describe('derivePrincipalKey (§94)', () => {
  it('keys an Agent by its registered identity, never by anything it sends', () => {
    expect(
      derivePrincipalKey(req('/agent/v1/heartbeat', 'POST', { principal: agentPrincipal })),
    ).toBe('agent:agent-1');
  });

  it('keys a user by organization and user (§94 example)', () => {
    expect(derivePrincipalKey(req('/v1/campaigns', 'GET', { principal: userPrincipal }))).toBe(
      'user:org-1:u-1',
    );
  });

  it('keys a CRM caller by the presented key, not the shared IP', () => {
    // A Buyer's CRM sits behind one egress IP; keying by IP would make every
    // integration on that host share a window.
    const a = derivePrincipalKey(
      req('/v1/leads/events', 'POST', {
        headers: { authorization: 'Bearer oolix_crm_aaa' },
      } as Partial<AuthenticatedRequest>),
    );
    const b = derivePrincipalKey(
      req('/v1/leads/events', 'POST', {
        headers: { authorization: 'Bearer oolix_crm_bbb' },
      } as Partial<AuthenticatedRequest>),
    );
    expect(a).toMatch(/^crm:[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    // The key itself must never appear in the window key, which is logged.
    expect(a).not.toContain('oolix_crm_aaa');
  });

  it('falls back to the client IP when there is no credential at all', () => {
    expect(derivePrincipalKey(req('/v1/attribution/click/x', 'POST'))).toBe('ip:203.0.113.1');
  });
});

describe('orgOf', () => {
  it('reads the Partner organization from an Agent principal, not a header', () => {
    expect(orgOf(req('/agent/v1/heartbeat', 'POST', { principal: agentPrincipal }))).toBe(
      'org-partner',
    );
  });

  it('is undefined for an unauthenticated caller', () => {
    expect(orgOf(req('/healthz'))).toBeUndefined();
  });
});
