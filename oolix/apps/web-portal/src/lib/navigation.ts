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
 *
 * The rail names jobs, not pages: a persona gets at most six items, and pages
 * that serve one job are a single item whose pages show as tabs (SectionTabs).
 * Twelve entries in the rail was most of what made the portal feel crowded.
 */
import type { Permission } from '@oolix/contracts';
import { canAny, isBuyer, isNetworkSponsor, isPartner, type MeContext } from './context';

export interface NavTab {
  label: string;
  href: string;
  /** Shown when the caller holds ANY of these. Empty means always shown. */
  permissions?: Permission[];
}

export interface NavItem {
  label: string;
  /** Where the item leads: its first visible tab, when it has tabs. */
  href: string;
  /** Shown when the caller holds ANY of these. Empty means always shown. */
  permissions?: Permission[];
  /** Pages that belong to this item. The item stays current on any of them,
   *  and they are offered as tabs at the top of each. */
  tabs?: NavTab[];
}

export interface NavGroup {
  /** Shown above the group only when the rail has more than one persona. */
  persona: string;
  items: NavItem[];
}

const BUYER: NavItem[] = [
  { label: 'Home', href: '/dashboard' },
  {
    label: 'Campaigns',
    href: '/campaigns',
    tabs: [
      { label: 'Campaigns', href: '/campaigns', permissions: ['campaign:read', 'campaign:draft'] },
      { label: 'Ads', href: '/creatives', permissions: ['creative:upload'] },
    ],
  },
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
  {
    label: 'Results',
    href: '/reports',
    tabs: [
      { label: 'Reports', href: '/reports', permissions: ['report:read'] },
      { label: 'Leads', href: '/leads', permissions: ['crm:connect', 'report:read'] },
    ],
  },
  // No Billing entry: invoices and payouts are hidden for the starter set
  // (FEATURE_BILLING_ENABLED on the API), and so is the page.
];

const PARTNER: NavItem[] = [
  { label: 'Home', href: '/partner' },
  {
    label: 'Campaigns',
    href: '/partner/requests',
    tabs: [
      {
        label: 'To review',
        href: '/partner/requests',
        // Visible to anyone who can act on a request OR merely extend the
        // clock, because §101's extension is itself a decision the queue has
        // to surface.
        permissions: ['request:approve', 'request:reject', 'request:change', 'request:extend'],
      },
      {
        label: 'Running',
        href: '/partner/activations',
        permissions: ['killswitch:operate', 'report:read'],
      },
    ],
  },
  {
    // v6 §18.2: what this Partner can be ASKED about leads, because it is now
    // the primary way a Partner is discovered — a Partner with no published
    // capability matches no audience and is invisible to Buyers (§7).
    label: 'Your data',
    href: '/partner/capabilities',
    tabs: [
      {
        label: 'What Buyers can ask',
        href: '/partner/capabilities',
        permissions: ['segment:manage'],
      },
      {
        label: 'Connection',
        href: '/partner/integrations',
        permissions: ['agent:register', 'connector:manage'],
      },
      { label: 'Segments', href: '/partner/segments', permissions: ['segment:manage'] },
      // Phase 7: overlap counts and joint audiences with other Partners.
      { label: 'Other Partners', href: '/partner/cleanroom', permissions: ['report:read'] },
    ],
  },
  {
    label: 'Ad slots',
    href: '/partner/placements',
    tabs: [
      { label: 'Placements', href: '/partner/placements', permissions: ['placement:manage'] },
      { label: 'Rules', href: '/partner/policies', permissions: ['partner:policy:manage'] },
    ],
  },
  // No Payouts entry: hidden with billing for the starter set.
  { label: 'Results', href: '/partner/reports', permissions: ['report:read'] },
];

const NETWORK: NavItem[] = [
  { label: 'Network dashboard', href: '/network' },
  { label: 'Member companies', href: '/network/members', permissions: ['network:invite'] },
  { label: 'Network reports', href: '/network/reports', permissions: ['network:report:read'] },
  { label: 'Network policy', href: '/network/policy', permissions: ['network:policy:manage'] },
];

// Oolix's own operators only. An organization's own audit log is under
// Settings: listing it here put an "Oolix admin" heading in every Buyer
// admin's rail.
const ADMIN: NavItem[] = [
  { label: 'Operations', href: '/admin', permissions: ['admin:operate'] },
  { label: 'Organizations', href: '/admin/organizations', permissions: ['admin:operate'] },
  { label: 'Shared synonyms', href: '/admin/synonyms', permissions: ['admin:operate'] },
  { label: 'Audit', href: '/admin/audit', permissions: ['admin:operate'] },
];

const SETTINGS: NavItem = {
  label: 'Settings',
  href: '/account',
  tabs: [
    { label: 'Team', href: '/team', permissions: ['org:member:manage'] },
    {
      label: 'Brands & connections',
      href: '/connections',
      permissions: ['crm:connect', 'channel:connect'],
    },
    { label: 'Audit log', href: '/admin/audit', permissions: ['audit:read'] },
    { label: 'Password', href: '/account' },
  ],
};

function allowed(ctx: MeContext, permissions?: Permission[]): boolean {
  return !permissions || canAny(ctx, ...permissions);
}

function visible(ctx: MeContext, items: NavItem[]): NavItem[] {
  return items.flatMap((item) => {
    if (!item.tabs) return allowed(ctx, item.permissions) ? [item] : [];
    const tabs = item.tabs.filter((t) => allowed(ctx, t.permissions));
    const first = tabs[0];
    if (!first || !allowed(ctx, item.permissions)) return [];
    return [{ ...item, href: first.href, tabs }];
  });
}

export function navigationFor(ctx: MeContext): NavGroup[] {
  const groups: NavGroup[] = [];

  if (isBuyer(ctx)) groups.push({ persona: 'Buyer', items: visible(ctx, BUYER) });
  if (isPartner(ctx)) groups.push({ persona: 'Data Partner', items: visible(ctx, PARTNER) });
  if (isNetworkSponsor(ctx)) groups.push({ persona: 'Network', items: visible(ctx, NETWORK) });

  const admin = visible(ctx, ADMIN);
  if (admin.length) groups.push({ persona: 'Oolix admin', items: admin });

  // Last and unlabelled. An Oolix admin already has the audit log above.
  const settings = admin.length
    ? { ...SETTINGS, tabs: SETTINGS.tabs?.filter((t) => t.href !== '/admin/audit') }
    : SETTINGS;
  groups.push({ persona: '', items: visible(ctx, [settings]) });

  return groups.filter((g) => g.items.length > 0);
}

/** The item a path belongs to: its own page or one of its tabs. */
export function itemPaths(item: NavItem): string[] {
  return item.tabs ? item.tabs.map((t) => t.href) : [item.href];
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
