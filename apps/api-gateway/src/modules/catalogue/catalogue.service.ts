/**
 * Audience discovery -- spec v5 §39, §67.5, §72, §86.
 *
 * What a Buyer searches here is METADATA, never membership (§39 figure 16:
 * "Buyer filters metadata, never customer membership"). Three rules shape the
 * whole module:
 *
 *   §39   "Do not allow a Buyer to send arbitrary SQL-like rules against a
 *          Partner database." Buyers pick from Partner-PUBLISHED segments.
 *   §72   Reach is a bucket. Filters that would expose a tiny cohort suppress
 *          the result instead.
 *   §66.2 A Buyer sees a segment only when listing visibility and shared
 *          network membership permit it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  CHANNELS,
  PRICING_MODELS,
  bucketMatchesFilter,
  isExternalChannel,
  type Channel,
  type ChannelAvailability,
  type ReachBucket,
} from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import {
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../common/pagination/cursor.js';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { BUCKET_FROM_DB } from '../../common/reach.js';

/** Repeated query values arrive as `a,b` or as repeated params. */
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export const CatalogueQuerySchema = z.object({
  query: z.string().max(200).optional(),
  industry: csv.optional(),
  category: csv.optional(),
  geo: csv.optional(),
  channel: csv.optional(),
  pricing_model: csv.optional(),
  placement_surface: csv.optional(),
  freshness_max_hours: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .optional(),
  reach_min: z.coerce.number().int().nonnegative().optional(),
  reach_max: z.coerce.number().int().positive().optional(),
  price_max_minor: z.coerce.number().int().nonnegative().optional(),
  network_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  sort: z
    .enum(['freshness_at:desc', 'freshness_at:asc', 'price:asc', 'price:desc'])
    .default('freshness_at:desc'),
});

export type CatalogueQuery = z.infer<typeof CatalogueQuerySchema>;

const FREQ_FROM_DB: Record<string, string> = {
  FIFTEEN_MIN: '15m',
  HOURLY: 'hourly',
  SIX_HOURS: '6h',
  DAILY: 'daily',
  WEEKLY: 'weekly',
};

@Injectable()
export class CatalogueService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * Search published segments visible to this Buyer.
   *
   * Filtering happens in two places on purpose. Anything the database can
   * express (status, geography, category, freshness) is a WHERE clause;
   * bucket-overlap and channel-availability are applied in memory because
   * they are policy decisions, not storage facts, and pushing them into SQL
   * would scatter §72 across query builders.
   */
  async search(principal: UserPrincipal, q: CatalogueQuery) {
    const limit = clampLimit(q.limit);
    const cursor = decodeCursor(q.cursor);

    // §66.2 visibility: the Buyer's own networks, plus open marketplace
    // listings. A Partner's private listing is invisible to a non-member.
    const visibleNetworkIds = q.network_id
      ? principal.networkIds.filter((n) => n === q.network_id)
      : principal.networkIds;

    const where: Record<string, unknown> = {
      // §39: only Partner-PUBLISHED supply is discoverable.
      status: 'PUBLISHED',
      organization: {
        verificationStatus: { in: ['BUSINESS_VERIFIED', 'ROLE_ONBOARDING', 'ACTIVE'] },
      },
      offers: {
        some: {
          OR: [
            { visibility: 'MARKETPLACE' },
            ...(visibleNetworkIds.length > 0 ? [{ networkId: { in: visibleNetworkIds } }] : []),
          ],
        },
      },
    };

    if (q.category?.length) where.category = { in: q.category };
    if (q.geo?.length) where.geographies = { hasSome: q.geo };
    if (q.industry?.length) {
      where.organization = {
        ...(where.organization as object),
        industry: { in: q.industry },
      };
    }

    // §39: "refreshed within 24h; daily-or-better".
    if (q.freshness_max_hours) {
      where.freshnessAt = { gte: new Date(Date.now() - q.freshness_max_hours * 3_600_000) };
    }

    // Keyword search across SAFE metadata only (§39.1). Note the absence of
    // any field that could describe an individual.
    if (q.query) {
      where.OR = [
        { displayName: { contains: q.query, mode: 'insensitive' } },
        { description: { contains: q.query, mode: 'insensitive' } },
        { category: { contains: q.query, mode: 'insensitive' } },
      ];
    }

    if (q.channel?.length) {
      const channels = q.channel.filter((c): c is Channel =>
        (CHANNELS as readonly string[]).includes(c),
      );
      if (channels.length > 0) where.allowedChannels = { hasSome: channels };
    }

    // Cursor is (sortKey, id) so equal sort keys still yield a total order.
    const desc = q.sort.endsWith(':desc');
    if (cursor) {
      where.AND = [
        {
          OR: [
            { freshnessAt: desc ? { lt: new Date(cursor.k) } : { gt: new Date(cursor.k) } },
            { freshnessAt: new Date(cursor.k), id: desc ? { lt: cursor.i } : { gt: cursor.i } },
          ],
        },
      ];
    }

    const rows = await this.prisma.segment.findMany({
      where: where as never,
      include: {
        organization: {
          select: { id: true, name: true, industry: true, verificationStatus: true },
        },
        offers: { include: { network: { select: { id: true, name: true } } } },
      },
      orderBy: [{ freshnessAt: desc ? 'desc' : 'asc' }, { id: desc ? 'desc' : 'asc' }],
      // Over-fetch: in-memory filters below may drop rows, and buildPage needs
      // one extra to know whether a next page exists.
      take: limit * 3 + 1,
    });

    const items = rows
      .map((r) => this.toCard(r, principal))
      .filter((card) => {
        // §72: bucket overlap, never an exact comparison.
        if (
          (q.reach_min !== undefined || q.reach_max !== undefined) &&
          !bucketMatchesFilter(card.reach_bucket, {
            ...(q.reach_min !== undefined ? { reachMin: q.reach_min } : {}),
            ...(q.reach_max !== undefined ? { reachMax: q.reach_max } : {}),
          })
        ) {
          return false;
        }
        if (q.pricing_model?.length && !q.pricing_model.includes(card.pricing.model)) return false;
        if (
          q.price_max_minor !== undefined &&
          card.pricing.indicative_unit_price_minor > q.price_max_minor
        ) {
          return false;
        }
        return true;
      });

    const page = buildPage(items, limit, (card) => ({
      k: card.freshness_at ?? new Date(0).toISOString(),
      i: card.segment_id,
    }));

    return {
      items: page.items,
      next_cursor: page.next_cursor,
      /**
       * §72: a reminder carried in the response itself, because summing these
       * buckets is the single most tempting mistake a Buyer UI can make.
       */
      notice:
        'Reach is a planning bucket, not a count, and must not be summed across ' +
        'Partners as unique reach (spec §72).',
    };
  }

  async get(principal: UserPrincipal, segmentId: string) {
    const row = await this.prisma.segment.findFirst({
      where: { id: segmentId, status: 'PUBLISHED' },
      include: {
        organization: {
          select: { id: true, name: true, industry: true, verificationStatus: true },
        },
        offers: { include: { network: { select: { id: true, name: true } } } },
      },
    });
    if (!row) return null;

    const card = this.toCard(row, principal);
    if (!card.visible) return null;

    const placements = await this.prisma.placement.findMany({
      where: { partnerOrgId: row.partnerOrgId, status: 'ACTIVE' },
      select: { id: true, placementKey: true, displayName: true, surface: true, format: true },
    });

    return {
      ...card,
      // §39.2: only public/approved placement categories are exposed.
      placements: placements.map((p) => ({
        placement_id: p.id,
        placement_key: p.placementKey,
        display_name: p.displayName,
        surface: p.surface,
        format: p.format,
      })),
    };
  }

  /**
   * v6 §9 step 6: a Partner's placements, without going through a segment.
   *
   * The v5 flow reached placements through a segment card. An audience-targeted
   * campaign has no segment, so this exists to answer the same question
   * directly — but only for a Partner the Buyer is actually entitled to
   * transact with.
   *
   * §66.2 visibility is enforced by requiring an ACTIVE published capability:
   * a Partner who has not published one is not offering audience supply, and
   * enumerating their placements would leak that they exist at all.
   */
  async partnerPlacements(principal: UserPrincipal, partnerOrgId: string) {
    const visible = await this.prisma.partnerCapability.findFirst({
      where: { partnerOrgId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!visible) return null;

    // The Buyer must share a network with this Partner, or the Partner must
    // offer marketplace supply. Same rule the segment catalogue applies —
    // stated here rather than inherited, because this route does not pass
    // through a SegmentOffer.
    const reachable = await this.prisma.networkMembership.findFirst({
      where: {
        orgId: partnerOrgId,
        status: 'ACTIVE',
        networkId: { in: principal.networkIds },
      },
      select: { orgId: true },
    });
    const marketplace = await this.prisma.segmentOffer.findFirst({
      where: { segment: { partnerOrgId }, visibility: 'MARKETPLACE' },
      select: { id: true },
    });
    if (!reachable && !marketplace) return null;

    const placements = await this.prisma.placement.findMany({
      where: { partnerOrgId, status: 'ACTIVE' },
      select: { id: true, placementKey: true, displayName: true, surface: true, format: true },
      orderBy: { displayName: 'asc' },
    });

    return {
      items: placements.map((p) => ({
        placement_id: p.id,
        placement_key: p.placementKey,
        display_name: p.displayName,
        surface: p.surface,
        format: p.format,
      })),
    };
  }

  /**
   * Build the §39.2 search result card.
   *
   * Everything here is safe to show a Buyer. There is no exact count, no
   * member sample and no Partner-internal identifier unless the Partner chose
   * to expose its segment key.
   */
  private toCard(
    row: {
      id: string;
      internalKey: string;
      displayName: string;
      description: string;
      category: string;
      geographies: string[];
      reachBucket: string;
      freshnessAt: Date | null;
      refreshFrequency: string;
      consentEligibility: string;
      allowedChannels: string[];
      partnerOrgId: string;
      organization: {
        id: string;
        name: string;
        industry: string | null;
        verificationStatus: string;
      };
      offers: Array<{
        networkId: string | null;
        pricingModel: string;
        unitPriceMinor: bigint;
        currency: string;
        visibility: string;
        network: { id: string; name: string } | null;
      }>;
    },
    principal: UserPrincipal,
  ) {
    // Pick the offer this Buyer is actually entitled to: a network-specific
    // price overrides the base listing (§66.2 SegmentOffer).
    const networkOffer = row.offers.find(
      (o) => o.networkId && principal.networkIds.includes(o.networkId),
    );
    const marketplaceOffer = row.offers.find((o) => o.visibility === 'MARKETPLACE');
    const offer = networkOffer ?? marketplaceOffer ?? row.offers[0];

    const visible = Boolean(networkOffer ?? marketplaceOffer);

    return {
      visible,
      segment_id: row.id,
      partner: {
        id: row.organization.id,
        display_name: row.organization.name,
        industry: row.organization.industry,
        trust_status:
          row.organization.verificationStatus === 'BUSINESS_VERIFIED' ? 'VERIFIED' : 'PENDING',
      },
      display_name: row.displayName,
      description: row.description,
      category: row.category,
      geographies: row.geographies,
      /** §72: a bucket. There is no exact-count field to omit. */
      reach_bucket: (BUCKET_FROM_DB[row.reachBucket] ?? row.reachBucket) as ReachBucket,
      freshness_at: row.freshnessAt?.toISOString() ?? null,
      refresh_frequency: FREQ_FROM_DB[row.refreshFrequency] ?? row.refreshFrequency,
      consent_eligibility: row.consentEligibility,
      channels: this.channelAvailability(row.allowedChannels as Channel[]),
      pricing: {
        model: (offer?.pricingModel ?? 'CPQL') as (typeof PRICING_MODELS)[number],
        indicative_unit_price_minor: Number(offer?.unitPriceMinor ?? 0n),
        currency: offer?.currency ?? 'INR',
      },
      network: offer?.network ? { id: offer.network.id, name: offer.network.name } : null,
    };
  }

  /**
   * §40.5 / §67.5 channel badges.
   *
   * A Partner-owned channel the Partner published is AVAILABLE. An external
   * channel is never more than CONDITIONAL here, however healthy the account
   * looks: §15, §16 and §47.5 require a per-campaign eligibility check at
   * approval time, and §32 warns against showing Google as selectable before
   * that passes. Feature flags off (§84) make it NOT_OFFERED instead.
   */
  private channelAvailability(
    allowed: Channel[],
  ): Array<{ type: Channel; status: ChannelAvailability }> {
    return allowed.map((type) => {
      if (!isExternalChannel(type)) return { type, status: 'AVAILABLE' as ChannelAvailability };

      const enabled =
        type === 'META' ? this.config.FEATURE_META_ENABLED : this.config.FEATURE_GOOGLE_ENABLED;

      return {
        type,
        status: (enabled ? 'CONDITIONAL' : 'NOT_OFFERED') as ChannelAvailability,
      };
    });
  }

  /** Exposed for tests: the cursor encoding used by search(). */
  static cursorFor(freshnessAt: string, id: string): string {
    return encodeCursor({ k: freshnessAt, i: id });
  }
}
