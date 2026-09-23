/**
 * Canonical RBAC role enum and permission boundaries -- spec v5 §66.1.
 *
 * §66 supersedes the earlier §4 / §35.3 role lists. Authorization is always
 * evaluated server-side against organization and network scope; UI-only role
 * filtering is never trusted (§4.2, §56).
 */
import { z } from 'zod';

export const ROLES = [
  'BUYER_ADMIN',
  'BUYER_OPERATOR',
  'PARTNER_ADMIN',
  'PARTNER_SECURITY_ADMIN',
  'PARTNER_CAMPAIGN_APPROVER',
  'NETWORK_ADMIN',
  'FINANCE',
  'ANALYST',
  'OOLIX_ADMIN',
] as const;

export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

/**
 * Fine-grained permissions. Roles map to sets of these; endpoints require a
 * permission, never a role name directly, so the mapping can change without
 * touching every guard.
 */
export const PERMISSIONS = [
  // Buyer
  'campaign:read',
  'campaign:draft',
  'campaign:submit',
  'creative:upload',
  'billing:manage',
  'crm:connect',
  // Partner supply
  'partner:policy:manage',
  'segment:manage',
  'segment:publish',
  'placement:manage',
  'payout:settings:manage',
  // Partner security
  'agent:register',
  'agent:revoke',
  'connector:manage',
  'channel:connect',
  'killswitch:operate',
  // Partner approval
  'request:approve',
  'request:reject',
  'request:change',
  'request:revoke',
  'request:extend',
  // Network
  'network:invite',
  'network:policy:manage',
  'network:report:read',
  // Finance
  'invoice:read',
  'payout:read',
  'payout:approve',
  'reconciliation:manage',
  // Shared
  'report:read',
  'org:member:manage',
  'audit:read',
  // Platform
  'admin:operate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const PermissionSchema = z.enum(PERMISSIONS);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  BUYER_ADMIN: [
    'campaign:read',
    'campaign:draft',
    'campaign:submit',
    'creative:upload',
    'billing:manage',
    'crm:connect',
    'channel:connect',
    'report:read',
    'org:member:manage',
    'audit:read',
  ],
  // §66: cannot change billing ownership.
  BUYER_OPERATOR: ['campaign:read', 'campaign:draft', 'creative:upload', 'report:read'],
  PARTNER_ADMIN: [
    'partner:policy:manage',
    'segment:manage',
    'segment:publish',
    'placement:manage',
    'payout:settings:manage',
    'killswitch:operate',
    'request:extend',
    'report:read',
    'org:member:manage',
    'audit:read',
    // §98.2 puts payout state on the Partner dashboard, and §83.1 lets
    // either side open a dispute. A Partner Admin must be able to see, and
    // contest, its own money. Approving a payout stays with FINANCE.
    'payout:read',
  ],
  PARTNER_SECURITY_ADMIN: [
    'agent:register',
    'agent:revoke',
    'connector:manage',
    'channel:connect',
    'killswitch:operate',
    'report:read',
    'audit:read',
  ],
  PARTNER_CAMPAIGN_APPROVER: [
    'request:approve',
    'request:reject',
    'request:change',
    'request:revoke',
    'report:read',
  ],
  NETWORK_ADMIN: ['network:invite', 'network:policy:manage', 'network:report:read', 'report:read'],
  FINANCE: [
    'invoice:read',
    'payout:read',
    'payout:approve',
    'reconciliation:manage',
    'report:read',
  ],
  ANALYST: ['report:read'],
  // §66: platform operations, but explicitly CANNOT bypass Partner approval or
  // reach a Partner's raw customer database. Note the absence of request:approve.
  OOLIX_ADMIN: ['admin:operate', 'report:read', 'audit:read', 'org:member:manage'],
});

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) out.add(p);
  return out;
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/** Roles that §4.2 / §82 require MFA for. */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  'PARTNER_ADMIN',
  'PARTNER_SECURITY_ADMIN',
  'PARTNER_CAMPAIGN_APPROVER',
  'FINANCE',
  'BUYER_ADMIN',
  'OOLIX_ADMIN',
];

export const ORGANIZATION_TYPES = [
  'BUYER',
  'DATA_PARTNER',
  'BUYER_AND_PARTNER',
  'NETWORK_SPONSOR',
  'AGENCY',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];
export const OrganizationTypeSchema = z.enum(ORGANIZATION_TYPES);

/** §35.2 verification state model. */
export const VERIFICATION_STATES = [
  'SIGNUP_STARTED',
  'EMAIL_VERIFIED',
  'ORGANIZATION_CREATED',
  'BUSINESS_VERIFICATION_PENDING',
  'BUSINESS_VERIFIED',
  'ROLE_ONBOARDING',
  'ACTIVE',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export const VerificationStateSchema = z.enum(VERIFICATION_STATES);

/**
 * §66.3: campaign submission and Partner publication require BUSINESS_VERIFIED.
 * Drafting and browsing are allowed while pending.
 */
export function canSubmitOrPublish(state: VerificationState): boolean {
  return state === 'BUSINESS_VERIFIED' || state === 'ROLE_ONBOARDING' || state === 'ACTIVE';
}

/** §66.2 network admission modes. */
export const NETWORK_MODES = ['PRIVATE', 'CURATED', 'MARKETPLACE'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
export const NetworkModeSchema = z.enum(NETWORK_MODES);
