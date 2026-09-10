/**
 * The channel eligibility gate -- spec v5 §47.5, §48.4.
 *
 * These tests are shaped around one property: **breaking any single condition
 * must block the upload.** So there is one fully-satisfied fixture, and every
 * other test takes that fixture and breaks exactly one thing.
 *
 * That shape matters more than the individual cases. A suite that only asserts
 * "missing connection is blocked" passes just as happily against a service
 * that blocks everything, and a suite that only asserts the happy path passes
 * against one that allows everything. Pairing a positive control with
 * one-thing-at-a-time negatives is what makes the result meaningful.
 *
 * What is at stake is not an error message. Past this gate, a Partner's
 * customer list is hashed and sent to Meta or Google. §47.6 and §48.5 both say
 * a failure means no upload happens at all.
 */
import { ChannelEligibilityService } from './eligibility.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OolixConfig } from '../../config/configuration.js';

const PARTNER = 'partner-org';
const BUYER = 'buyer-org';

interface Fixture {
  partnerConn: Record<string, unknown> | null;
  buyerConn: Record<string, unknown> | null;
  segment: Record<string, unknown> | null;
  policy: Record<string, unknown> | null;
  metaEnabled: boolean;
  googleEnabled: boolean;
}

/** Everything §47.5 requires, all satisfied. Each test spoils one part. */
function eligibleFixture(): Fixture {
  return {
    partnerConn: {
      status: 'CONNECTED',
      scopes: ['ads_management'],
      accountIds: { business_id: 'bus-1', ad_account_id: 'act-1' },
      capabilityFlags: { customer_list_audiences: true },
      expiresAt: new Date(Date.now() + 86_400_000),
      statusReason: null,
    },
    buyerConn: {
      status: 'CONNECTED',
      scopes: ['ads_management'],
      accountIds: { page_id: 'page-1', business_id: 'bus-2', ad_account_id: 'act-2' },
      capabilityFlags: { customer_list_audiences: true },
      expiresAt: null,
      statusReason: null,
    },
    segment: { consentEligibility: 'ELIGIBLE', allowedChannels: ['META', 'GOOGLE'] },
    policy: { prohibitedUse: [], blockedAdvertisers: [] },
    metaEnabled: true,
    googleEnabled: true,
  };
}

function serviceFor(f: Fixture): ChannelEligibilityService {
  const prisma = {
    channelConnection: {
      findUnique: async ({
        where,
      }: {
        where: { partnerOrgId_provider: { partnerOrgId: string } };
      }) => (where.partnerOrgId_provider.partnerOrgId === PARTNER ? f.partnerConn : f.buyerConn),
    },
    segment: { findUnique: async () => f.segment },
    partnerPolicy: { findFirst: async () => f.policy },
  } as unknown as PrismaService;

  const config = {
    FEATURE_META_ENABLED: f.metaEnabled,
    FEATURE_GOOGLE_ENABLED: f.googleEnabled,
  } as unknown as OolixConfig;

  return new ChannelEligibilityService(prisma, config);
}

function evaluate(f: Fixture, provider: 'META' | 'GOOGLE' = 'META') {
  return serviceFor(f).evaluate({
    partnerOrgId: PARTNER,
    buyerOrgId: BUYER,
    provider,
    segmentId: 'seg-1',
    advertiserName: 'Acme',
  });
}

describe('ChannelEligibilityService', () => {
  // The positive control. Without it, every test below would also pass
  // against a service that blocked unconditionally.
  it('clears an activation when every condition is satisfied', async () => {
    const v = await evaluate(eligibleFixture());
    expect(v.eligible).toBe(true);
    expect(v.blocking).toHaveLength(0);
    expect(v.checks.length).toBeGreaterThan(5);
  });

  describe('the connection itself', () => {
    it('blocks when the Partner has never connected the account', async () => {
      const f = eligibleFixture();
      f.partnerConn = null;
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_connection_present');
    });

    it.each(['EXPIRED', 'REVOKED', 'ERROR', 'PENDING', 'NOT_CONNECTED'])(
      'blocks when the connection status is %s',
      async (status) => {
        const f = eligibleFixture();
        f.partnerConn = { ...f.partnerConn, status };
        const v = await evaluate(f);
        expect(v.eligible).toBe(false);
        expect(v.blocking.map((c) => c.id)).toContain('partner_connection_healthy');
      },
    );

    it('blocks on an authorization whose expiry has passed', async () => {
      // A stale expiry is a revocation nobody has noticed. Discovering it
      // mid-upload is worse than discovering it here.
      const f = eligibleFixture();
      f.partnerConn = { ...f.partnerConn, expiresAt: new Date(Date.now() - 1000) };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_connection_unexpired');
    });

    it('blocks when a required account identifier is missing', async () => {
      const f = eligibleFixture();
      f.partnerConn = { ...f.partnerConn, accountIds: { business_id: 'bus-1' } };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      const check = v.blocking.find((c) => c.id === 'partner_account_ids_present');
      // The operator has to know WHICH id, or the message costs a round trip.
      expect(check?.detail).toContain('ad_account_id');
    });

    it('blocks when a required scope was not granted', async () => {
      const f = eligibleFixture();
      f.partnerConn = { ...f.partnerConn, scopes: ['public_profile'] };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_scopes_granted');
    });
  });

  describe('capability flags are evidence, not assumptions', () => {
    it('blocks when the provider explicitly denied the capability', async () => {
      const f = eligibleFixture();
      f.partnerConn = { ...f.partnerConn, capabilityFlags: { customer_list_audiences: false } };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_capabilities_confirmed');
    });

    it('blocks when the capability was never checked at all', async () => {
      // The important half of §15's "never assume universal eligibility":
      // absent must be treated exactly like false. Anything else makes a
      // forgotten health check look like permission.
      const f = eligibleFixture();
      f.partnerConn = { ...f.partnerConn, capabilityFlags: {} };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_capabilities_confirmed');
    });

    it.each([null, 'true', 1, [], 'yes'])(
      'blocks on a truthy-but-not-true capability value (%p)',
      async (value) => {
        // A string "true" from a sloppy provider response must not read as
        // confirmation; only a real boolean true counts.
        const f = eligibleFixture();
        f.partnerConn = {
          ...f.partnerConn,
          capabilityFlags: { customer_list_audiences: value },
        };
        const v = await evaluate(f);
        expect(v.eligible).toBe(false);
      },
    );
  });

  describe('consent', () => {
    it.each(['MIXED', 'UNAVAILABLE'])('blocks a segment whose consent is %s', async (state) => {
      // MIXED fails as firmly as UNAVAILABLE: Oolix cannot see which members
      // carry a basis, so it cannot upload "the eligible part".
      const f = eligibleFixture();
      f.segment = { ...f.segment, consentEligibility: state };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('consent_basis');
    });

    it('blocks when no segment could be resolved', async () => {
      const f = eligibleFixture();
      f.segment = null;
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('consent_basis');
    });
  });

  describe('the Partner stays in control', () => {
    it('blocks a channel the segment was not published for', async () => {
      const f = eligibleFixture();
      f.segment = { ...f.segment, allowedChannels: ['PARTNER_WEB'] };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('segment_permits_channel');
    });

    it('blocks when Partner policy prohibits external activation', async () => {
      const f = eligibleFixture();
      f.policy = { prohibitedUse: ['EXTERNAL_CHANNEL'], blockedAdvertisers: [] };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_policy_permits');
    });

    it('blocks an advertiser the Partner has blocked, whatever the casing', async () => {
      const f = eligibleFixture();
      f.policy = { prohibitedUse: [], blockedAdvertisers: ['ACME'] };
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_policy_permits');
    });

    it('blocks when the Partner has no policy at all', async () => {
      const f = eligibleFixture();
      f.policy = null;
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('partner_policy_permits');
    });
  });

  describe('deployment and advertiser', () => {
    it('blocks when the channel is disabled on this deployment', async () => {
      // §84 again at upload time, not only at request time: a flag turned off
      // after approval must still stop the upload.
      const f = eligibleFixture();
      f.metaEnabled = false;
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('channel_enabled');
    });

    it('blocks a Meta upload when the advertiser has no connected assets', async () => {
      const f = eligibleFixture();
      f.buyerConn = null;
      const v = await evaluate(f);
      expect(v.eligible).toBe(false);
      expect(v.blocking.map((c) => c.id)).toContain('advertiser_identity_present');
    });

    it('does not require Meta page assets for a Google activation', async () => {
      // Google's equivalent lives in destination access on the operating
      // account; demanding a Meta asset would block Google for no reason.
      const f = eligibleFixture();
      f.partnerConn = {
        ...f.partnerConn,
        scopes: ['https://www.googleapis.com/auth/datamanager'],
        accountIds: { operating_customer_id: '111', login_customer_id: '222' },
        capabilityFlags: { customer_match: true, account_compliant: true, payment_ok: true },
      };
      f.buyerConn = null;
      const v = await evaluate(f, 'GOOGLE');
      expect(v.blocking.map((c) => c.id)).not.toContain('advertiser_identity_present');
      expect(v.eligible).toBe(true);
    });

    it('requires all three Google capability flags', async () => {
      const f = eligibleFixture();
      f.partnerConn = {
        ...f.partnerConn,
        scopes: ['https://www.googleapis.com/auth/datamanager'],
        accountIds: { operating_customer_id: '111', login_customer_id: '222' },
        // §16.2: good policy AND payment history, not just the feature.
        capabilityFlags: { customer_match: true, account_compliant: true },
      };
      const v = await evaluate(f, 'GOOGLE');
      expect(v.eligible).toBe(false);
      const check = v.blocking.find((c) => c.id === 'partner_capabilities_confirmed');
      expect(check?.detail).toContain('payment_ok');
    });
  });

  it('reports every failing condition, not merely the first', async () => {
    // Connecting an ad account is slow. Surfacing one missing scope at a time
    // sends an operator round the loop once per problem.
    const f = eligibleFixture();
    f.partnerConn = null;
    f.segment = { consentEligibility: 'UNAVAILABLE', allowedChannels: [] };
    f.policy = { prohibitedUse: ['EXTERNAL_CHANNEL'], blockedAdvertisers: [] };
    const v = await evaluate(f);

    expect(v.eligible).toBe(false);
    expect(v.blocking.length).toBeGreaterThanOrEqual(4);
    expect(v.summary).toContain('not eligible');
  });

  it('never leaks a credential into a verdict', async () => {
    // Verdicts reach audit events, the portal and Activation.statusReason.
    const f = eligibleFixture();
    f.partnerConn = {
      ...f.partnerConn,
      status: 'ERROR',
      statusReason: 'token refresh failed',
    };
    const v = await evaluate(f);
    const serialized = JSON.stringify(v).toLowerCase();
    for (const forbidden of ['access_token', 'refresh_token', 'client_secret', 'bearer ']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
