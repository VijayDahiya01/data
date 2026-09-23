/**
 * Channel Eligibility Service -- spec v5 §47.5, §48.4.
 *
 * The gate between "a Partner approved this" and "customer data may be
 * prepared for an outside platform". §47.6 and §48.5 are both explicit that a
 * failure means NO upload happens at all -- not a degraded upload, not a
 * retry-later: the activation is blocked and the Buyer is offered owned media
 * instead.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 * 1. Default deny. Every condition must explicitly pass. A missing connection,
 *    an unreadable capability flag, an unknown provider -- all deny. The only
 *    way to become eligible is for every named check to return true, and
 *    `verdictFrom` additionally refuses an empty check list, so a future
 *    refactor that drops the checks fails closed rather than open.
 *
 * 2. It never sees a credential. §17 puts ingestion credentials in the Partner
 *    Agent and leaves Oolix holding account IDs, authorization state and
 *    capability flags. This service reads only the latter. It cannot verify a
 *    token by using it, and it must not try.
 *
 * 3. Eligibility is per Buyer/Partner RELATIONSHIP, not per platform. §15's
 *    warning is the whole reason this is not a boolean: "it must never assume
 *    universal eligibility". The same Partner can be eligible for one Buyer
 *    and not another.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not call Meta or Google. The live
 * account state those APIs report is recorded on ChannelConnection by the
 * connection health check, on its own schedule; an eligibility evaluation that
 * made a network call would fail open the first time a provider had an outage,
 * which is precisely when it should not.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import {
  verdictFrom,
  type EligibilityCheck,
  type EligibilityVerdict,
} from './eligibility.types.js';

type Provider = 'META' | 'GOOGLE';

interface ProviderRequirements {
  accountIds: string[];
  scopes: string[];
  capabilities: string[];
  /** Assets the ADVERTISER must have connected, checked on the Buyer's side. */
  advertiserAccountIds: string[];
}

/**
 * What each provider requires before any customer data may be prepared.
 *
 * Spelled out per provider rather than shared, because the two platforms
 * genuinely differ: Meta's constraint is authority to upload on an
 * advertiser's behalf (§15), Google's is first-party data policy plus account
 * standing (§16.2). Collapsing them into one list would mean loosening both to
 * whichever is weaker.
 */
const REQUIREMENTS: Record<Provider, ProviderRequirements> = {
  META: {
    // §47.2: the business relationship and the ad account are separate things
    // and both have to be recorded.
    accountIds: ['business_id', 'ad_account_id'],
    scopes: ['ads_management'],
    // §15: a Custom Audience built from a customer list is its own permission,
    // and holding an ad account does not imply it.
    capabilities: ['customer_list_audiences'],
    // §47.5 "advertiser identity/assets" -- the Buyer's side of the topology.
    advertiserAccountIds: ['page_id'],
  },
  GOOGLE: {
    // §48.8: the operating/login/linked path. These are distinct ids and using
    // the wrong one returns a 403 that reads like a permissions bug.
    accountIds: ['operating_customer_id', 'login_customer_id'],
    scopes: ['https://www.googleapis.com/auth/datamanager'],
    // §16.2: Customer Match availability depends on policy and payment
    // history, which is why these are discovered flags rather than assumptions.
    capabilities: ['customer_match', 'account_compliant', 'payment_ok'],
    advertiserAccountIds: [],
  },
};

export interface EligibilityInput {
  partnerOrgId: string;
  buyerOrgId: string;
  provider: Provider;
  segmentId?: string | null;
  /** Buyer brand/advertiser name, checked against the Partner's block list. */
  advertiserName?: string | null;
}

@Injectable()
export class ChannelEligibilityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  async evaluate(input: EligibilityInput): Promise<EligibilityVerdict> {
    const { provider } = input;
    const req: ProviderRequirements | undefined = REQUIREMENTS[provider];
    const checks: EligibilityCheck[] = [];

    // An unknown provider cannot be evaluated, so it cannot be eligible.
    // Returning early with no checks would read as "nothing failed" to a naive
    // implementation; verdictFrom refuses an empty list, and this check makes
    // the reason legible rather than mysterious.
    if (!req) {
      checks.push({
        id: 'provider_known',
        description: 'The channel provider has a documented eligibility model',
        passed: false,
        detail: `No eligibility requirements are defined for ${String(provider)}.`,
      });
      return verdictFrom(provider, checks);
    }

    checks.push(this.featureFlagCheck(provider));

    const [partnerConn, buyerConn, segment, policy] = await Promise.all([
      this.prisma.channelConnection.findUnique({
        where: { partnerOrgId_provider: { partnerOrgId: input.partnerOrgId, provider } },
      }),
      this.prisma.channelConnection.findUnique({
        where: { partnerOrgId_provider: { partnerOrgId: input.buyerOrgId, provider } },
      }),
      input.segmentId
        ? this.prisma.segment.findUnique({ where: { id: input.segmentId } })
        : Promise.resolve(null),
      this.prisma.partnerPolicy.findFirst({
        where: { partnerOrgId: input.partnerOrgId },
        orderBy: { version: 'desc' },
      }),
    ]);

    checks.push(...this.connectionChecks('partner', partnerConn, req));
    checks.push(...this.advertiserChecks(buyerConn, req));
    checks.push(this.consentCheck(segment, provider));
    checks.push(this.segmentChannelCheck(segment, provider));
    checks.push(this.policyCheck(policy, input.advertiserName ?? null));

    return verdictFrom(provider, checks);
  }

  /**
   * §84: a channel behind a disabled flag is not merely unavailable, it is
   * unrequestable. Checked here as well as at request time, so that a flag
   * turned off after approval also blocks the upload.
   */
  private featureFlagCheck(provider: Provider): EligibilityCheck {
    const enabled =
      provider === 'META' ? this.config.FEATURE_META_ENABLED : this.config.FEATURE_GOOGLE_ENABLED;
    return {
      id: 'channel_enabled',
      description: 'The channel is enabled on this deployment',
      passed: enabled,
      detail: enabled
        ? `${provider} is enabled.`
        : `${provider} is disabled on this deployment (spec §84).`,
    };
  }

  private connectionChecks(
    side: 'partner' | 'buyer',
    conn: {
      status: string;
      scopes: unknown;
      accountIds: unknown;
      capabilityFlags: unknown;
      expiresAt: Date | null;
      statusReason: string | null;
    } | null,
    req: ProviderRequirements,
  ): EligibilityCheck[] {
    if (!conn) {
      return [
        {
          id: `${side}_connection_present`,
          description: 'The account relationship has been connected',
          passed: false,
          detail: `No ${side} channel connection exists. §47.1 / §48.1 require one before any activation.`,
        },
      ];
    }

    const out: EligibilityCheck[] = [
      {
        id: `${side}_connection_healthy`,
        description: 'The connection is live rather than expired or revoked',
        passed: conn.status === 'CONNECTED',
        detail:
          conn.status === 'CONNECTED'
            ? 'Connection is CONNECTED.'
            : `Connection status is ${conn.status}${
                conn.statusReason ? `: ${conn.statusReason}` : ''
              }.`,
      },
    ];

    // An expiry in the past is a revocation nobody has noticed yet. Treating
    // it as healthy only moves the discovery to the middle of an upload.
    const expired = conn.expiresAt !== null && conn.expiresAt.getTime() <= Date.now();
    out.push({
      id: `${side}_connection_unexpired`,
      description: 'The authorization has not expired',
      passed: !expired,
      detail: expired
        ? `Authorization expired at ${conn.expiresAt?.toISOString()}.`
        : 'Authorization is current.',
    });

    const ids = asRecord(conn.accountIds);
    const missingIds = req.accountIds.filter((k) => !nonEmpty(ids[k]));
    out.push({
      id: `${side}_account_ids_present`,
      description: 'Every required account identifier is recorded',
      passed: missingIds.length === 0,
      detail:
        missingIds.length === 0
          ? `Recorded: ${req.accountIds.join(', ')}.`
          : `Missing account identifiers: ${missingIds.join(', ')}.`,
    });

    const scopes = asStringArray(conn.scopes);
    const missingScopes = req.scopes.filter((s) => !scopes.includes(s));
    out.push({
      id: `${side}_scopes_granted`,
      description: 'Every required authorization scope was granted',
      passed: missingScopes.length === 0,
      detail:
        missingScopes.length === 0
          ? 'All required scopes granted.'
          : `Missing scopes: ${missingScopes.join(', ')}.`,
    });

    // Capability flags are DISCOVERED from the provider, never assumed. A flag
    // that is absent is treated exactly like one that is false: §15 warns
    // against assuming universal eligibility, and "we never checked" is not
    // evidence of permission.
    const caps = asRecord(conn.capabilityFlags);
    const missingCaps = req.capabilities.filter((c) => caps[c] !== true);
    out.push({
      id: `${side}_capabilities_confirmed`,
      description: 'The provider confirmed the capabilities this activation needs',
      passed: missingCaps.length === 0,
      detail:
        missingCaps.length === 0
          ? `Confirmed: ${req.capabilities.join(', ')}.`
          : `Not confirmed by the provider: ${missingCaps.join(', ')}.`,
    });

    return out;
  }

  /**
   * §47.5 "advertiser identity/assets".
   *
   * Only Meta needs this today: uploading a customer list on an advertiser's
   * behalf requires that advertiser to exist as a party with assets, which is
   * a different question from whether the Partner may upload at all. Google's
   * equivalent is folded into destination access on the operating account.
   */
  private advertiserChecks(
    buyerConn: { accountIds: unknown; status: string } | null,
    req: ProviderRequirements,
  ): EligibilityCheck[] {
    if (req.advertiserAccountIds.length === 0) return [];

    if (!buyerConn) {
      return [
        {
          id: 'advertiser_identity_present',
          description: 'The advertiser has connected the assets the upload runs against',
          passed: false,
          detail:
            'The Buyer has no channel connection, so advertiser identity and assets cannot be established (§47.5).',
        },
      ];
    }

    const ids = asRecord(buyerConn.accountIds);
    const missing = req.advertiserAccountIds.filter((k) => !nonEmpty(ids[k]));
    const connected = buyerConn.status === 'CONNECTED';
    return [
      {
        id: 'advertiser_identity_present',
        description: 'The advertiser has connected the assets the upload runs against',
        passed: missing.length === 0 && connected,
        detail:
          missing.length > 0
            ? `Advertiser is missing: ${missing.join(', ')}.`
            : connected
              ? 'Advertiser identity and assets are recorded.'
              : `Advertiser connection status is ${buyerConn.status}.`,
      },
    ];
  }

  /**
   * §47.5 / §48.4 consent.
   *
   * MIXED fails as firmly as UNAVAILABLE. A segment where only some members
   * carry a lawful basis cannot be uploaded in part, because Oolix cannot see
   * which members those are -- only the Agent can. Splitting such a segment is
   * the Partner's decision to make deliberately, not one to infer here.
   */
  private consentCheck(
    segment: { consentEligibility: string } | null,
    provider: Provider,
  ): EligibilityCheck {
    if (!segment) {
      return {
        id: 'consent_basis',
        description: 'The segment carries a lawful basis for this channel',
        passed: false,
        detail: 'No segment resolved, so consent eligibility cannot be established.',
      };
    }
    const ok = segment.consentEligibility === 'ELIGIBLE';
    return {
      id: 'consent_basis',
      description: 'The segment carries a lawful basis for this channel',
      passed: ok,
      detail: ok
        ? 'Segment consent eligibility is ELIGIBLE.'
        : `Segment consent eligibility is ${segment.consentEligibility}; ${provider} upload requires ELIGIBLE (§47.5, §48.4).`,
    };
  }

  /** §76.2: the Partner decides which channels a segment may leave on. */
  private segmentChannelCheck(
    segment: { allowedChannels: string[] } | null,
    provider: Provider,
  ): EligibilityCheck {
    const allowed = segment?.allowedChannels ?? [];
    const ok = allowed.includes(provider);
    return {
      id: 'segment_permits_channel',
      description: 'The Partner published this segment for this channel',
      passed: ok,
      detail: ok
        ? `Segment permits ${provider}.`
        : `Segment does not list ${provider} among its allowed channels.`,
    };
  }

  /**
   * §47.5 / §48.4 Partner policy.
   *
   * A `prohibitedUse` entry naming external activation is how a Partner says
   * "our data does not leave our property" once, rather than having to decline
   * every request individually.
   */
  private policyCheck(
    policy: { prohibitedUse: string[]; blockedAdvertisers: string[] } | null,
    advertiserName: string | null,
  ): EligibilityCheck {
    if (!policy) {
      return {
        id: 'partner_policy_permits',
        description: 'The Partner policy permits external activation for this advertiser',
        passed: false,
        detail: 'No Partner policy version found; external activation requires an explicit policy.',
      };
    }

    const prohibits = policy.prohibitedUse.some(
      (u) => u.toUpperCase() === 'EXTERNAL_CHANNEL' || u.toUpperCase() === 'EXTERNAL_ACTIVATION',
    );
    const blocked =
      advertiserName !== null &&
      policy.blockedAdvertisers.some((a) => a.toLowerCase() === advertiserName.toLowerCase());

    return {
      id: 'partner_policy_permits',
      description: 'The Partner policy permits external activation for this advertiser',
      passed: !prohibits && !blocked,
      detail: prohibits
        ? 'Partner policy prohibits external-channel use.'
        : blocked
          ? `Partner policy blocks advertiser "${advertiserName}".`
          : 'Partner policy permits this activation.',
    };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined;
}
