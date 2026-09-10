/**
 * Authorization decisions -- spec v5 §4.2, §56, §66, §82.
 *
 * Every rule here is server-side. §4.2: "never trust UI-only role filtering".
 * §82: "Server-side org/network scope on every endpoint".
 *
 * The functions are pure and take an explicit resource owner, so the same
 * logic is testable in isolation and reusable from HTTP guards, queue
 * consumers and scheduled jobs alike.
 */
import { OolixError, permissionsForRoles, type Permission, type Role } from '@oolix/contracts';
import type { AgentScope, Principal, UserPrincipal } from './principal.js';
import { isAgent, isUser } from './principal.js';

export interface ResourceScope {
  /** Organization that owns the resource. */
  orgId: string;
  /**
   * When set, access is also allowed to members of this network, subject to
   * the network's visibility mode (§66.2). Used for catalogue listings.
   */
  networkId?: string | null;
}

/**
 * Does the principal hold this permission at all?
 *
 * Note this answers "may they do X somewhere", not "may they do X here".
 * Always pair with {@link assertOrgScope}.
 */
export function hasPermission(p: Principal, permission: Permission): boolean {
  if (!isUser(p)) return false;
  return p.permissions.has(permission);
}

export function assertPermission(p: Principal, permission: Permission): asserts p is UserPrincipal {
  if (!isUser(p)) {
    throw new OolixError('PERM_001', 'This endpoint requires a user principal.');
  }
  if (!p.permissions.has(permission)) {
    throw new OolixError('PERM_001', `Missing permission: ${permission}`);
  }
}

/**
 * Organization isolation. This is the single most important check in the
 * platform: §59 requires that an "unauthorized role cannot access another
 * org", and a miss here leaks one Partner's commercial data to another.
 */
export function assertOrgScope(p: Principal, scope: ResourceScope): void {
  const principalOrg = isAgent(p) ? p.partnerOrgId : p.orgId;
  if (principalOrg === scope.orgId) return;

  // §66: OOLIX_ADMIN operates the platform across organizations. It still
  // cannot approve a Partner request or read a Partner's raw customer data --
  // those are enforced by the absence of the permission, not by this check.
  if (isUser(p) && p.permissions.has('admin:operate')) return;

  throw new OolixError('PERM_002', 'Organization access denied.');
}

/**
 * §66.2 catalogue visibility: a Buyer sees a segment only when listing
 * visibility and shared network membership permit it.
 */
export function canSeeListing(
  p: Principal,
  listing: {
    ownerOrgId: string;
    visibility: 'PRIVATE_NETWORK' | 'CURATED' | 'MARKETPLACE';
    networkId: string | null;
  },
): boolean {
  if (!isUser(p)) return false;
  if (p.orgId === listing.ownerOrgId) return true;
  if (p.permissions.has('admin:operate')) return true;

  // MARKETPLACE listings are discoverable outside private networks (§66.2).
  if (listing.visibility === 'MARKETPLACE') return true;

  if (!listing.networkId) return false;
  return p.networkIds.includes(listing.networkId);
}

/**
 * §66.3 / §36: drafting and browsing are allowed while verification is
 * pending; submitting a campaign or publishing supply is not.
 */
export function assertBusinessVerified(p: Principal, action: string): void {
  if (!isUser(p)) return;
  if (!p.businessVerified) {
    throw new OolixError(
      'PERM_001',
      `${action} requires a verified business (spec §66.3). Drafting and browsing remain available.`,
    );
  }
}

/**
 * §66.2: "A same organization may be both Buyer and Data Partner, but
 * self-dealing does not auto-approve. A different user with
 * PARTNER_CAMPAIGN_APPROVER permission must approve."
 *
 * The check is on the USER, not the organization: an org acting as both sides
 * is legitimate; the same human approving their own request is not.
 */
export function assertNotSelfApproval(
  approver: UserPrincipal,
  request: { createdByUserId: string },
): void {
  if (approver.userId === request.createdByUserId) {
    throw new OolixError(
      'PERM_001',
      'The user who created this campaign request cannot approve it (spec §66.2).',
    );
  }
}

/** §92.4: the Agent must carry the scope its endpoint class requires. */
export function assertAgentScope(p: Principal, scope: AgentScope): void {
  if (!isAgent(p)) {
    throw new OolixError('AUTH_001', 'This endpoint requires a Partner Agent principal.');
  }
  if (!p.scopes.includes(scope)) {
    throw new OolixError('PERM_001', `Agent is missing scope: ${scope}`);
  }
}

/** Build a user principal's permission set from its roles in one org. */
export function buildUserPermissions(roles: readonly Role[]): Set<Permission> {
  return permissionsForRoles(roles);
}
