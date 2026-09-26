/**
 * Authenticated principals -- spec v5 §66, §92.4.
 *
 * Three kinds of caller reach Oolix Cloud, and they are never interchangeable:
 *
 *   UserPrincipal       -- a signed-in person acting inside ONE organization.
 *   OnboardingPrincipal -- a signed-in person who belongs to no organization
 *                          yet. Accepted only by routes that say so; it
 *                          carries no organization, roles or permissions.
 *   AgentPrincipal      -- a Partner Agent workload, via an ES256 client
 *                          assertion, acting only for its own Partner.
 *
 * §92.4 is emphatic: "never trust a partner_org_id supplied in the body". The
 * Agent's Partner comes from its registration record, and it is attached here
 * so no handler can be tricked into acting for a different Partner.
 */
import type { Permission, Role } from '@oolix/contracts';

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  authSubject: string;
  email: string;
  /** The organization this request acts within. */
  orgId: string;
  /** Roles held in THAT organization only (§66). */
  roles: Role[];
  permissions: Set<Permission>;
  /** Networks the organization belongs to, for §66.2 visibility scoping. */
  networkIds: string[];
  /** §66.3: gates campaign submission and Partner publication. */
  businessVerified: boolean;
}

/**
 * §35.1 → §35.2: someone who verified their email and signed in, but has not
 * created or joined an organization. It exists so that step is reachable at
 * all -- a principal REQUIRING an organization made "create your first
 * organization" impossible -- and it is deliberately a separate kind rather
 * than a UserPrincipal with an empty orgId, so no handler written for an
 * organization member can receive one by accident.
 */
export interface OnboardingPrincipal {
  kind: 'onboarding';
  userId: string;
  email: string;
}

export interface AgentPrincipal {
  kind: 'agent';
  agentId: string;
  clientId: string;
  /** Authoritative. Taken from the Agent record, never from the request. */
  partnerOrgId: string;
  scopes: AgentScope[];
  agentVersion: string;
}

export type Principal = UserPrincipal | OnboardingPrincipal | AgentPrincipal;

/** §92.4: scopes required per Agent endpoint class. */
export const AGENT_SCOPES = [
  'config:read',
  'reporting:write',
  'channel_status:write',
  'heartbeat:write',
  // A managed Agent publishing what its local copy can answer (Partner Connect).
  'capabilities:write',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export function isUser(p: Principal): p is UserPrincipal {
  return p.kind === 'user';
}

export function isAgent(p: Principal): p is AgentPrincipal {
  return p.kind === 'agent';
}
