/**
 * Deterministic development seed -- spec v5 §95.
 *
 * §95 sets both the content and the hard limit:
 *
 *   development  one Buyer org, one Partner org, one private Network, at
 *                least three role-bearing users per org, three Partner
 *                segments, two placements, one READY creative, one draft
 *                campaign. U123 eligible, U456 ineligible.
 *   test/CI      deterministic fixture IDs so assertions do not depend on
 *                generated UUIDs.
 *   staging      synthetic organizations only; never copied production data.
 *   production    UNSUPPORTED. "the command must refuse".
 *
 * The refusal is enforced below and is not overridable by a flag.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { seedAttributeTaxonomy } from './attributes.js';
import { seedPartnerCapabilities } from './capabilities.js';

loadEnv({
  // oolix/packages/db -> the workspace root, where the one .env lives.
  path: [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '..', '..', '.env'),
  ],
  quiet: true,
});

// ---------------------------------------------------------------------------
// §95: deterministic IDs so integration and E2E assertions are stable.
// ---------------------------------------------------------------------------
const ID = {
  buyerOrg: '11111111-1111-4111-8111-111111111111',
  partnerAOrg: '22222222-2222-4222-8222-222222222222',
  partnerBOrg: '33333333-3333-4333-8333-333333333333',
  networkSponsorOrg: '44444444-4444-4444-8444-444444444444',
  network: '55555555-5555-4555-8555-555555555555',
  oolixOrg: '99999999-9999-4999-8999-999999999999',

  buyerAdmin: 'aaaaaaaa-0001-4001-8001-000000000001',
  buyerOperator: 'aaaaaaaa-0002-4002-8002-000000000002',
  buyerFinance: 'aaaaaaaa-0003-4003-8003-000000000003',
  partnerFinance: 'bbbbbbbb-0004-4004-8004-000000000004',
  partnerAdmin: 'bbbbbbbb-0001-4001-8001-000000000001',
  partnerSecurity: 'bbbbbbbb-0002-4002-8002-000000000002',
  partnerApprover: 'bbbbbbbb-0003-4003-8003-000000000003',
  partnerBAdmin: 'cccccccc-0001-4001-8001-000000000001',
  partnerBApprover: 'cccccccc-0002-4002-8002-000000000002',
  networkAdmin: 'dddddddd-0001-4001-8001-000000000001',
  analyst: 'eeeeeeee-0001-4001-8001-000000000001',
  oolixAdmin: 'ffffffff-0001-4001-8001-000000000001',
  /**
   * One login that can see every persona (§34).
   *
   * §34 requires that "role switching must not require a second account", and
   * this is the demonstration of it: one person, memberships in four
   * organizations, switching from the sidebar without signing out.
   *
   * Note what it does NOT get around. §66.2 still refuses to let this user
   * approve a campaign request they created themselves, even though they hold
   * both roles -- separation of duties is enforced per ACTION, not per account.
   */
  demoAllAccess: 'ffffffff-0002-4002-8002-000000000002',

  brand: '66666666-6666-4666-8666-666666666666',
  segTravel: '77777777-0001-4001-8001-000000000001',
  segPremium: '77777777-0002-4002-8002-000000000002',
  segShopper: '77777777-0003-4003-8003-000000000003',
  segPartnerB: '77777777-0004-4004-8004-000000000004',
  plBookingSuccess: '88888888-0001-4001-8001-000000000001',
  plRewardsHome: '88888888-0002-4002-8002-000000000002',
  plPartnerBWeb: '88888888-0003-4003-8003-000000000003',
} as const;

type Env = 'development' | 'test' | 'staging';

function resolveEnv(): Env {
  const raw =
    process.argv.find((a) => a.startsWith('--env='))?.split('=')[1] ??
    process.env.SEED_ENV ??
    process.env.APP_ENV ??
    'development';

  const normalised = raw === 'local' ? 'development' : raw;

  // §95: production seeding is refused outright. This is a data-integrity
  // guard, not a convenience check -- seeding production would create
  // synthetic organizations that look real in billing and reporting.
  if (normalised === 'production' || normalised === 'prod') {
    console.error(
      '\n[seed] REFUSED: seeding production is not supported (spec §95).\n' +
        '       All production organizations are created through controlled\n' +
        '       onboarding and admin workflows.\n',
    );
    process.exit(1);
  }

  if (!['development', 'test', 'staging'].includes(normalised)) {
    console.error(`[seed] unknown environment "${raw}"`);
    process.exit(1);
  }
  return normalised as Env;
}

const env = resolveEnv();

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * Keycloak subject for a seeded user.
 *
 * The local realm authenticates by email, and the Oolix user row is matched to
 * the OIDC subject on first login (see IdentityOrgService.linkAuthSubject).
 * Until then the placeholder marks the row as unbound.
 */
const pendingSubject = (email: string) => `pending:${email}`;

async function main(): Promise<void> {
  console.log(`[seed] environment: ${env}`);

  // -------------------------------------------------------------------------
  // Attribute taxonomy (v6 §4, Appendix A)
  //
  // Installed before anything else because audiences and Partner capabilities
  // both reference it. This is PLATFORM data rather than a fixture -- every
  // environment needs it, and it is idempotent by (key, version).
  // -------------------------------------------------------------------------
  const attributeCount = await seedAttributeTaxonomy(prisma);
  console.log(`[seed] ${attributeCount} attribute definitions (v6 taxonomy)`);

  // -------------------------------------------------------------------------
  // Users (§65 seed identities)
  // -------------------------------------------------------------------------
  const users: Array<{ id: string; email: string; name: string }> = [
    { id: ID.buyerAdmin, email: 'buyer.admin@example.test', name: 'Bala Buyer' },
    { id: ID.buyerOperator, email: 'buyer.operator@example.test', name: 'Omar Operator' },
    { id: ID.buyerFinance, email: 'finance@example.test', name: 'Fiona Finance' },
    { id: ID.partnerAdmin, email: 'partner.admin@example.test', name: 'Priya Partner' },
    { id: ID.partnerSecurity, email: 'partner.security@example.test', name: 'Sam Security' },
    { id: ID.partnerApprover, email: 'partner.approver@example.test', name: 'Arun Approver' },
    { id: ID.partnerFinance, email: 'partner.finance@example.test', name: 'Farah Finance' },
    { id: ID.partnerBAdmin, email: 'partnerb.admin@example.test', name: 'Bea Partner' },
    { id: ID.partnerBApprover, email: 'partnerb.approver@example.test', name: 'Ben Approver' },
    { id: ID.networkAdmin, email: 'network.admin@example.test', name: 'Nadia Network' },
    { id: ID.analyst, email: 'analyst@example.test', name: 'Alex Analyst' },
    { id: ID.oolixAdmin, email: 'oolix.admin@example.test', name: 'Ola Admin' },
    { id: ID.demoAllAccess, email: 'demo@example.test', name: 'Dev Demo' },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        email: u.email,
        name: u.name,
        authSubject: pendingSubject(u.email),
        status: 'ACTIVE',
        country: 'IN',
        termsVersion: 'T-1',
        acceptedAt: new Date('2026-08-01T00:00:00Z'),
      },
      update: {
        name: u.name,
        status: 'ACTIVE',
        // Reset the identity binding on every local seed.
        //
        // Recreating the local Keycloak container issues NEW subject ids for
        // the same emails, and the API rightly refuses to rebind an email to a
        // different identity -- that check is a real defence, not a nuisance.
        // Unbinding here lets the next login re-establish the link cleanly.
        // Deliberately development/test only: in staging a tester's binding is
        // real and must not be silently reset.
        ...(env === 'development' || env === 'test'
          ? { authSubject: pendingSubject(u.email) }
          : {}),
      },
    });
  }
  console.log(`[seed] ${users.length} users`);

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------
  const orgs = [
    {
      id: ID.buyerOrg,
      name: 'ABC Insurance',
      domain: 'insurance.example',
      type: 'BUYER' as const,
      industry: 'insurance',
    },
    {
      id: ID.partnerAOrg,
      name: 'Travel A',
      domain: 'travel-a.example',
      type: 'DATA_PARTNER' as const,
      industry: 'travel',
    },
    {
      id: ID.partnerBOrg,
      name: 'Rewards B',
      domain: 'rewards-b.example',
      type: 'DATA_PARTNER' as const,
      industry: 'loyalty',
    },
    {
      id: ID.networkSponsorOrg,
      name: 'Meridian Ventures',
      domain: 'meridian.example',
      type: 'NETWORK_SPONSOR' as const,
      industry: 'venture_capital',
    },
    {
      // The platform operator itself. §66 gives OOLIX_ADMIN an organization
      // like anyone else -- there is no ambient super-user, and every
      // authorization check still runs against a real membership.
      id: ID.oolixOrg,
      name: 'Oolix Platform Operations',
      domain: 'oolix.example',
      type: 'AGENCY' as const,
      industry: 'adtech',
    },
  ];

  for (const o of orgs) {
    await prisma.organization.upsert({
      where: { id: o.id },
      create: {
        id: o.id,
        name: o.name,
        domain: o.domain,
        type: o.type,
        country: 'IN',
        industry: o.industry,
        // Seeded organizations are pre-verified so a developer can exercise
        // submit/publish immediately; real orgs go through §66.3 review.
        verificationStatus: 'BUSINESS_VERIFIED',
      },
      update: { verificationStatus: 'BUSINESS_VERIFIED' },
    });
  }
  console.log(`[seed] ${orgs.length} organizations`);

  // -------------------------------------------------------------------------
  // Memberships -- §95 requires at least three role-bearing users per org
  // -------------------------------------------------------------------------
  const memberships: Array<{ orgId: string; userId: string; role: string }> = [
    { orgId: ID.buyerOrg, userId: ID.buyerAdmin, role: 'BUYER_ADMIN' },
    { orgId: ID.buyerOrg, userId: ID.buyerOperator, role: 'BUYER_OPERATOR' },
    { orgId: ID.buyerOrg, userId: ID.buyerFinance, role: 'FINANCE' },
    { orgId: ID.buyerOrg, userId: ID.analyst, role: 'ANALYST' },

    { orgId: ID.partnerAOrg, userId: ID.partnerAdmin, role: 'PARTNER_ADMIN' },
    { orgId: ID.partnerAOrg, userId: ID.partnerSecurity, role: 'PARTNER_SECURITY_ADMIN' },
    { orgId: ID.partnerAOrg, userId: ID.partnerApprover, role: 'PARTNER_CAMPAIGN_APPROVER' },
    { orgId: ID.partnerAOrg, userId: ID.partnerFinance, role: 'FINANCE' },
    { orgId: ID.partnerAOrg, userId: ID.analyst, role: 'ANALYST' },

    { orgId: ID.partnerBOrg, userId: ID.partnerBAdmin, role: 'PARTNER_ADMIN' },
    { orgId: ID.partnerBOrg, userId: ID.partnerBAdmin, role: 'PARTNER_SECURITY_ADMIN' },
    { orgId: ID.partnerBOrg, userId: ID.partnerBApprover, role: 'PARTNER_CAMPAIGN_APPROVER' },

    { orgId: ID.networkSponsorOrg, userId: ID.networkAdmin, role: 'NETWORK_ADMIN' },
    { orgId: ID.networkSponsorOrg, userId: ID.analyst, role: 'ANALYST' },

    // §66: OOLIX_ADMIN operates the platform but cannot approve a Partner
    // request or reach a Partner's customer data -- the role simply does not
    // carry those permissions.
    { orgId: ID.oolixOrg, userId: ID.oolixAdmin, role: 'OOLIX_ADMIN' },

    // §34: one account, every persona. Roles are granted per ORGANIZATION,
    // which is what keeps this legitimate -- the same person is a Buyer admin
    // at ABC Insurance and a Partner admin at Travel A, exactly as a real
    // agency employee might be. Granting every role inside ONE organization
    // would collapse the separation of duties §66 depends on.
    { orgId: ID.buyerOrg, userId: ID.demoAllAccess, role: 'BUYER_ADMIN' },
    { orgId: ID.buyerOrg, userId: ID.demoAllAccess, role: 'FINANCE' },
    { orgId: ID.buyerOrg, userId: ID.demoAllAccess, role: 'ANALYST' },

    { orgId: ID.partnerAOrg, userId: ID.demoAllAccess, role: 'PARTNER_ADMIN' },
    { orgId: ID.partnerAOrg, userId: ID.demoAllAccess, role: 'PARTNER_SECURITY_ADMIN' },
    { orgId: ID.partnerAOrg, userId: ID.demoAllAccess, role: 'PARTNER_CAMPAIGN_APPROVER' },
    { orgId: ID.partnerAOrg, userId: ID.demoAllAccess, role: 'FINANCE' },

    { orgId: ID.networkSponsorOrg, userId: ID.demoAllAccess, role: 'NETWORK_ADMIN' },
    { orgId: ID.oolixOrg, userId: ID.demoAllAccess, role: 'OOLIX_ADMIN' },
  ];

  for (const m of memberships) {
    await prisma.organizationMember.upsert({
      where: {
        orgId_userId_role: { orgId: m.orgId, userId: m.userId, role: m.role as never },
      },
      create: { orgId: m.orgId, userId: m.userId, role: m.role as never, status: 'ACTIVE' },
      update: { status: 'ACTIVE' },
    });
  }
  console.log(`[seed] ${memberships.length} memberships`);

  // -------------------------------------------------------------------------
  // Private network (§66.2)
  // -------------------------------------------------------------------------
  await prisma.network.upsert({
    where: { id: ID.network },
    create: {
      id: ID.network,
      sponsorOrgId: ID.networkSponsorOrg,
      name: 'Meridian Portfolio Network',
      mode: 'PRIVATE',
      policyVersion: 'N-1',
    },
    update: {},
  });

  for (const orgId of [ID.buyerOrg, ID.partnerAOrg, ID.partnerBOrg]) {
    await prisma.networkMembership.upsert({
      where: { networkId_orgId: { networkId: ID.network, orgId } },
      create: {
        networkId: ID.network,
        orgId,
        status: 'ACTIVE',
        joinedAt: new Date('2026-08-01T00:00:00Z'),
        roleFlags: { buyer: orgId === ID.buyerOrg, partner: orgId !== ID.buyerOrg },
      },
      update: { status: 'ACTIVE' },
    });
  }
  console.log('[seed] 1 private network with 3 members');

  // -------------------------------------------------------------------------
  // Buyer profile and brand
  // -------------------------------------------------------------------------
  await prisma.buyerProfile.upsert({
    where: { orgId: ID.buyerOrg },
    create: { orgId: ID.buyerOrg, onboardingStatus: 'READY', defaultBrandId: ID.brand },
    update: { onboardingStatus: 'READY', defaultBrandId: ID.brand },
  });

  await prisma.brand.upsert({
    where: { id: ID.brand },
    create: {
      id: ID.brand,
      buyerOrgId: ID.buyerOrg,
      name: 'ABC Travel Insurance',
      category: 'insurance',
      website: 'https://insurance.example',
      landingDomain: 'insurance.example',
    },
    update: {},
  });

  // -------------------------------------------------------------------------
  // Partner profiles and policies (§37)
  // -------------------------------------------------------------------------
  for (const [orgId, allowed] of [
    [ID.partnerAOrg, ['insurance', 'hotel', 'forex']],
    [ID.partnerBOrg, ['insurance', 'retail']],
  ] as const) {
    await prisma.partnerProfile.upsert({
      where: { orgId },
      create: { orgId, approvalSlaDays: 7, minPublishableReach: 1000 },
      update: {},
    });

    const policy = await prisma.partnerPolicy.upsert({
      where: { partnerOrgId_version: { partnerOrgId: orgId, version: 1 } },
      create: {
        partnerOrgId: orgId,
        version: 1,
        allowedCategories: [...allowed],
        // §41: a Partner blocks direct competitors by category and by name.
        blockedCategories: ['gambling', 'tobacco', 'direct_travel_competitor'],
        blockedAdvertisers: ['CompetitorTravel Ltd'],
        geographies: ['IN'],
        prohibitedUse: ['audience_expansion_without_approval', 'resale_of_audience'],
        commercialPolicy: { default_pricing_model: 'CPQL', min_unit_price_minor: 400000 },
      },
      update: {},
    });

    await prisma.partnerProfile.update({
      where: { orgId },
      data: { activePolicyId: policy.id },
    });
  }
  console.log('[seed] 2 partner profiles + policies');

  // v6 §5.1: what each Partner declares it can answer questions about. Seeded
  // right after the profiles because §7 cannot match anyone without it -- a
  // Partner with no published capability is invisible to the Audience Builder.
  await seedPartnerCapabilities(prisma);

  // -------------------------------------------------------------------------
  // Segments (§38, §72) -- §95 asks for three Partner segments.
  //
  // reach_bucket is stored; the exact count NEVER is. The numbers in the
  // comments below exist only to show which bucket each maps to.
  // -------------------------------------------------------------------------
  const segments = [
    {
      id: ID.segTravel,
      orgId: ID.partnerAOrg,
      key: 'RECENT_TRAVELLER_60D', // §91 fixture segment
      name: 'Recent Travellers',
      description: 'Completed a booking in the previous 60 days',
      category: 'travel_intent',
      bucket: 'HUNDRED_K_250K', // 213,418 local
      freq: 'DAILY',
      channels: ['PARTNER_WEB', 'PARTNER_APP'],
    },
    {
      id: ID.segPremium,
      orgId: ID.partnerAOrg,
      key: 'PREMIUM_USER', // §91 fixture segment
      name: 'Premium Members',
      description: 'Active premium tier membership',
      category: 'affluence',
      bucket: 'FIFTY_K_100K', // 64,207 local
      freq: 'HOURLY',
      channels: ['PARTNER_WEB', 'PARTNER_APP'],
    },
    {
      id: ID.segShopper,
      orgId: ID.partnerAOrg,
      key: 'TRAVEL_SHOPPER_30D',
      name: 'Travel Shoppers',
      description: 'Browsed travel products in the previous 30 days without booking',
      category: 'travel_intent',
      bucket: 'TWOFIFTY_K_500K',
      freq: 'SIX_HOURS',
      channels: ['PARTNER_WEB'],
    },
    {
      id: ID.segPartnerB,
      orgId: ID.partnerBOrg,
      key: 'TRAVEL_REWARDS',
      name: 'Travel Rewards Members',
      description: 'Redeemed a travel reward in the previous 90 days',
      category: 'travel_intent',
      bucket: 'HUNDRED_K_250K',
      freq: 'DAILY',
      // META is listed as an allowed channel so the §84 feature-flag gate is
      // genuinely exercised. Listing it does NOT make it usable: the flag is
      // off by default and the eligibility service must still clear it (§15,
      // §47.5). A segment permitting a channel and a campaign being allowed to
      // run on it are deliberately different questions.
      channels: ['PARTNER_WEB', 'META'],
    },
  ] as const;

  for (const s of segments) {
    await prisma.segment.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        partnerOrgId: s.orgId,
        internalKey: s.key,
        displayName: s.name,
        description: s.description,
        category: s.category,
        geographies: ['IN'],
        reachBucket: s.bucket as never,
        reachBucketPublishedAt: new Date('2026-08-22T04:00:00Z'),
        freshnessAt: new Date('2026-08-22T04:00:00Z'),
        refreshFrequency: s.freq as never,
        consentEligibility: 'ELIGIBLE',
        allowedChannels: s.channels as never,
        allowedCategories: ['insurance', 'hotel', 'forex'],
        blockedCategories: ['direct_travel_competitor'],
        status: 'PUBLISHED',
        safeMetadata: {
          source_event: 'confirmed_booking_transaction',
          active_user_window: 'P30D',
        },
      },
      // A seed must be idempotent in substance, not just in existence: a
      // re-run has to converge an existing row on the declared state, or the
      // database silently keeps whatever an earlier version of this file set.
      update: {
        displayName: s.name,
        description: s.description,
        category: s.category,
        reachBucket: s.bucket as never,
        refreshFrequency: s.freq as never,
        allowedChannels: s.channels as never,
        freshnessAt: new Date('2026-08-22T04:00:00Z'),
        status: 'PUBLISHED',
      },
    });

    await prisma.segmentOffer.upsert({
      where: { segmentId_networkId: { segmentId: s.id, networkId: ID.network } },
      create: {
        segmentId: s.id,
        networkId: ID.network,
        pricingModel: 'CPQL',
        unitPriceMinor: 450_000n, // INR 4,500 -- the §102 worked example
        currency: 'INR',
        visibility: 'PRIVATE_NETWORK',
      },
      update: {},
    });
  }
  console.log(`[seed] ${segments.length} published segments (bucketed, no exact counts stored)`);

  // -------------------------------------------------------------------------
  // Placements (§43) -- §95 asks for two.
  // -------------------------------------------------------------------------
  const placements = [
    {
      id: ID.plBookingSuccess,
      orgId: ID.partnerAOrg,
      key: 'booking_success_offer', // §91 fixture placement
      name: 'Booking Success Offer',
      surface: 'web',
      format: 'native_card',
      tags: ['booking_success'],
    },
    {
      id: ID.plRewardsHome,
      orgId: ID.partnerAOrg,
      key: 'rewards_home_banner',
      name: 'Rewards Home Banner',
      surface: 'web',
      format: 'banner',
      tags: ['home', 'rewards'],
    },
    {
      id: ID.plPartnerBWeb,
      orgId: ID.partnerBOrg,
      key: 'rewards_checkout_offer',
      name: 'Rewards Checkout Offer',
      surface: 'web',
      format: 'native_card',
      tags: ['checkout'],
    },
  ] as const;

  for (const p of placements) {
    await prisma.placement.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        partnerOrgId: p.orgId,
        placementKey: p.key,
        displayName: p.name,
        surface: p.surface as never,
        format: p.format as never,
        width: p.format === 'banner' ? 728 : null,
        height: p.format === 'banner' ? 90 : null,
        contextTags: [...p.tags],
        allowedCategories: ['insurance', 'hotel', 'forex'],
        blockedCategories: ['direct_travel_competitor'],
        maxFrequencyDefault: 2,
        fallback: 'HOUSE_CONTENT',
        status: 'ACTIVE',
      },
      update: { status: 'ACTIVE' },
    });
  }
  console.log(`[seed] ${placements.length} active placements`);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n[seed] complete.');
  console.log('  Buyer      ABC Insurance      buyer.admin@example.test');
  console.log('  Partner A  Travel A           partner.admin@example.test');
  console.log('  Partner B  Rewards B          partnerb.admin@example.test');
  console.log('  Network    Meridian Ventures  network.admin@example.test');
  console.log('  All local passwords: "password" (Keycloak realm "oolix")');
  console.log('\n  Ad-decision fixtures (§91): U123 eligible, U456 ineligible.');
  console.log('  Partner A still needs an Agent registered to reach READY_FOR_CAMPAIGNS.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
