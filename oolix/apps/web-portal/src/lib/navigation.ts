/**
 * Role-aware navigation (§34).
 *
 * §34 gives each persona a primary navigation, and requires ONE responsive
 * application rather than four codebases: "An organization can be Buyer, Data
 * Partner, or both; role switching must not require a second account." So the
 * groups below are additive — a BUYER_AND_PARTNER organization gets both, in
 * one sidebar, with no re-login.
 *
 * Each item declares the permission that makes it useful. An item with no
 * permission is available to anyone who can see the organization at all.
 */
import type { Permission } from '@oolix/contracts';
import { canAny, isBuyer, isNetworkSponsor, isPartner, type MeContext } from './context';

export interface NavItem {
  label: string;
  href: string;
  /** Shown when the caller holds ANY of these. Empty means always shown. */
  permissions?: Permission[];
  /** Rendered but disabled, with this explanation (§66.3). */
  blockedWhen?: (ctx: MeContext) => string | null;
}

export interface NavGroup {
  persona: string;
  items: NavItem[];
}

const BUYER: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Campaigns', href: '/campaigns', permissions: ['campaign:read', 'campaign:draft'] },
  {
    // v6 §18.1: "Replace primary route with Audiences / Audience Groups."
    // A Buyer now describes who they want to reach and Oolix finds the Data
    // Partners who can evaluate it, rather than the Buyer browsing other
    // people's segments first.
    label: 'Audiences',
    href: '/audiences',
    permissions: ['campaign:read', 'campaign:draft'],
  },
  // No prebuilt-segment entry. §19's path still exists in the API and a
  // campaign already targeting a Partner's segment keeps running, but a Buyer
  // is not offered it as an alternative way to do the same job: describing the
  // audience is the way.
  { label: 'Creatives', href: '/creatives', permissions: ['creative:upload'] },
  { label: 'Leads', href: '/leads', permissions: ['crm:connect', 'report:read'] },
  { label: 'Reports', href: '/reports', permissions: ['report:read'] },
  // No Billing entry: invoices and payouts are hidden for the starter set
  // (FEATURE_BILLING_ENABLED on the API), and so is the page.
  { label: 'Connections', href: '/connections', permissions: ['crm:connect', 'channel:connect'] },
];

const PARTNER: NavItem[] = [
  { label: 'Dashboard', href: '/partner' },
  {
    // v6 §18.2: what this Partner can be ASKED about. It is listed above
    // prebuilt segments because it is now the primary way a Partner is
    // discovered — a Partner with no published capability matches no audience
    // and is invisible to Buyers (§7).
    label: 'Audience capabilities',
    href: '/partner/capabilities',
    permissions: ['segment:manage'],
  },
  { label: 'Prebuilt segments', href: '/partner/segments', permissions: ['segment:manage'] },
  { label: 'Placements', href: '/partner/placements', permissions: ['placement:manage'] },
  {
    label: 'Campaign requests',
    href: '/partner/requests',
    // Visible to anyone who can act on a request OR merely extend the clock,
    // because §101's extension is itself a decision the queue has to surface.
    permissions: ['request:approve', 'request:reject', 'request:change', 'request:extend'],
  },
  {
    label: 'Active activations',
    href: '/partner/activations',
    permissions: ['killswitch:operate', 'report:read'],
  },
  {
    label: 'Integrations',
    href: '/partner/integrations',
    permissions: ['agent:register', 'connector:manage'],
  },
  { label: 'Reports', href: '/partner/reports', permissions: ['report:read'] },
  // No Payouts entry: hidden with billing for the starter set.
  { label: 'Policies', href: '/partner/policies', permissions: ['partner:policy:manage'] },
];

const NETWORK: NavItem[] = [
  { label: 'Network dashboard', href: '/network' },
  { label: 'Member companies', href: '/network/members', permissions: ['network:invite'] },
  { label: 'Network reports', href: '/network/reports', permissions: ['network:report:read'] },
  { label: 'Network policy', href: '/network/policy', permissions: ['network:policy:manage'] },
];

const ADMIN: NavItem[] = [
  { label: 'Operations', href: '/admin', permissions: ['admin:operate'] },
  { label: 'Organizations', href: '/admin/organizations', permissions: ['admin:operate'] },
  { label: 'Audit', href: '/admin/audit', permissions: ['audit:read', 'admin:operate'] },
];

const SHARED: NavItem[] = [{ label: 'Team', href: '/team', permissions: ['org:member:manage'] }];

function visible(ctx: MeContext, items: NavItem[]): NavItem[] {
  return items.filter((item) => !item.permissions || canAny(ctx, ...item.permissions));
}

export function navigationFor(ctx: MeContext): NavGroup[] {
  const groups: NavGroup[] = [];

  if (isBuyer(ctx)) groups.push({ persona: 'Buyer', items: visible(ctx, BUYER) });
  if (isPartner(ctx)) groups.push({ persona: 'Data Partner', items: visible(ctx, PARTNER) });
  if (isNetworkSponsor(ctx)) groups.push({ persona: 'Network', items: visible(ctx, NETWORK) });

  const admin = visible(ctx, ADMIN);
  if (admin.length) groups.push({ persona: 'Oolix admin', items: admin });

  const shared = visible(ctx, SHARED);
  if (shared.length) groups.push({ persona: 'Organization', items: shared });

  return groups.filter((g) => g.items.length > 0);
}

/**
 * §66.3: a user may sign in and browse while verification is pending, but
 * cannot submit a campaign or publish supply. Saying so up front is kinder
 * than letting them build a campaign and fail at the last step.
 */
export function restrictionNotice(ctx: MeContext): string | null {
  const org = ctx.active_organization;
  if (!org) return 'You do not belong to an organization yet.';

  if (isBuyer(ctx) && !org.can_submit_campaigns) {
    return `${org.name} is ${org.verification_status.replaceAll('_', ' ').toLowerCase()}. You can build campaigns, but you cannot submit one until verification is complete.`;
  }
  if (isPartner(ctx) && !org.can_publish_supply) {
    return `${org.name} is ${org.verification_status.replaceAll('_', ' ').toLowerCase()}. You can prepare audiences and ad placements, but not publish them, until verification is complete.`;
  }
  return null;
}
