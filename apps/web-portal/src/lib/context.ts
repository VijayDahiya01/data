/**
 * The caller's identity, organizations and permissions (§34, §52.1).
 *
 * §4.2: "never trust UI-only role filtering". The portal renders navigation
 * from the PERMISSION LIST the API returns, not from a role name it recognises
 * — and the API in turn reads those from the database for the active
 * organization rather than from a token claim. So a nav item disappearing and
 * a request being refused are driven by the same fact, and they cannot drift
 * apart.
 *
 * Hiding a link is a courtesy, never a control. Every route is enforced
 * server-side regardless of what the portal chose to draw.
 */
import 'server-only';
import { api } from './api';
import type { Permission } from '@oolix/contracts';

export type OrgType = 'BUYER' | 'DATA_PARTNER' | 'BUYER_AND_PARTNER' | 'NETWORK_SPONSOR' | 'AGENCY';

export interface OrgSummary {
  id: string;
  name: string;
  type: OrgType;
  verification_status: string;
  roles: string[];
}

export interface ActiveOrg extends OrgSummary {
  /** §66.3: gates campaign submission until verification completes. */
  can_submit_campaigns: boolean;
  can_publish_supply: boolean;
  /** §37: derived, never declared. Null for a Buyer-only organization. */
  partner_readiness: string | null;
}

export interface MeContext {
  user: { id: string; email: string; name: string; status: string };
  active_organization: ActiveOrg | null;
  organizations: OrgSummary[];
  permissions: Permission[];
  networks: { id: string; name: string; mode: string }[];
}

export function meContext(orgId?: string): Promise<MeContext> {
  return api<MeContext>('/v1/me/context', orgId ? { orgId } : {});
}

export function can(ctx: MeContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}

export function canAny(ctx: MeContext, ...permissions: Permission[]): boolean {
  return permissions.some((p) => ctx.permissions.includes(p));
}

export function isBuyer(ctx: MeContext): boolean {
  const t = ctx.active_organization?.type;
  return t === 'BUYER' || t === 'BUYER_AND_PARTNER' || t === 'AGENCY';
}

export function isPartner(ctx: MeContext): boolean {
  const t = ctx.active_organization?.type;
  return t === 'DATA_PARTNER' || t === 'BUYER_AND_PARTNER';
}

export function isNetworkSponsor(ctx: MeContext): boolean {
  return ctx.active_organization?.type === 'NETWORK_SPONSOR';
}
