/**
 * Authenticated principals -- spec v5 §66, §92.4.
 *
 * Two kinds of caller reach Oolix Cloud, and they are never interchangeable:
 *
 *   UserPrincipal  -- a human via OIDC, acting inside ONE organization.
 *   AgentPrincipal -- a Partner Agent workload, via an ES256 client
 *                     assertion, acting only for its own Partner.
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
  mfaSatisfied: boolean;
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

export type Principal = UserPrincipal | AgentPrincipal;

/** §92.4: scopes required per Agent endpoint class. */
export const AGENT_SCOPES = [
  'config:read',
  'reporting:write',
  'channel_status:write',
  'heartbeat:write',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export function isUser(p: Principal): p is UserPrincipal {
  return p.kind === 'user';
}

export function isAgent(p: Principal): p is AgentPrincipal {
  return p.kind === 'agent';
}
