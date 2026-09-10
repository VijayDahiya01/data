/**
 * Segment metadata publication -- spec v5 §38, §72.
 *
 * The privacy-critical logic lives in {@link publishBucket}: an exact count
 * enters, a coarse bucket leaves, and the exact value is never written to the
 * database. Two §72 rules shape it:
 *
 *   - a cohort below the publishable minimum is SUPPRESSED, not shown small
 *   - bucket republication is rate-limited, so repeatedly refreshing cannot be
 *     differenced back into an exact count
 */
import { Injectable, Inject } from '@nestjs/common';
import {
  OolixError,
  bucketForExactReach,
  DEFAULT_MIN_PUBLISHABLE_REACH,
  type Channel,
  type ReachBucket,
} from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';
import type {
  CreateSegmentInput,
  SegmentFreshnessInput,
  UpdateSegmentInput,
} from './segment.schema.js';
import { BUCKET_FROM_DB, BUCKET_TO_DB } from '../../common/reach.js';

const FREQ_TO_DB: Record<string, string> = {
  '15m': 'FIFTEEN_MIN',
  hourly: 'HOURLY',
  '6h': 'SIX_HOURS',
  daily: 'DAILY',
  weekly: 'WEEKLY',
};
const DB_TO_FREQ: Record<string, string> = Object.fromEntries(
  Object.entries(FREQ_TO_DB).map(([k, v]) => [v, k]),
);

@Injectable()
export class SegmentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * Convert an exact local count into a publishable bucket.
   *
   * Returns null when the cohort is too small to publish. §72 requires
   * suppressing the listing entirely rather than revealing a tiny cohort,
   * because a small bucket plus a targeted filter is a re-identification path.
   */
  private publishBucket(exact: number, minPublishable: number): ReachBucket | null {
    return bucketForExactReach(exact, minPublishable);
  }

  private async partnerMinReach(partnerOrgId: string): Promise<number> {
    const profile = await this.prisma.partnerProfile.findUnique({
      where: { orgId: partnerOrgId },
      select: { minPublishableReach: true },
    });
    // A Partner may raise the floor above the platform default, never lower it.
    return Math.max(
      profile?.minPublishableReach ?? DEFAULT_MIN_PUBLISHABLE_REACH,
      this.config.CATALOG_MIN_REACH,
    );
  }

  async create(partnerOrgId: string, input: CreateSegmentInput) {
    const minReach = await this.partnerMinReach(partnerOrgId);
    const bucket = this.publishBucket(input.reach_exact_local, minReach);

    if (!bucket) {
      throw new OolixError(
        'PART_002',
        `Segment has fewer than the minimum ${minReach} eligible users and cannot be published (spec §72).`,
        { fieldErrors: [{ field: 'reach_exact_local', message: 'below minimum cohort size' }] },
      );
    }

    const existing = await this.prisma.segment.findUnique({
      where: {
        partnerOrgId_internalKey: { partnerOrgId, internalKey: input.internal_segment_id },
      },
      select: { id: true },
    });
    if (existing) {
      throw new OolixError('VAL_001', 'A segment with this internal id already exists.', {
        fieldErrors: [{ field: 'internal_segment_id', message: 'already in use' }],
      });
    }

    const segment = await this.prisma.segment.create({
      data: {
        partnerOrgId,
        internalKey: input.internal_segment_id,
        displayName: input.display_name,
        description: input.description,
        category: input.category,
        geographies: input.geographies,
        reachBucket: BUCKET_TO_DB[bucket] as never,
        reachBucketPublishedAt: new Date(),
        refreshFrequency: FREQ_TO_DB[input.refresh_frequency] as never,
        consentEligibility: input.consent_eligibility as never,
        allowedChannels: input.allowed_channels as never,
        allowedCategories: input.allowed_categories,
        blockedCategories: input.blocked_categories,
        status: 'DRAFT',
        // Buyer-visible metadata only. Note the absence of any count.
        safeMetadata: {
          source_event: input.source_event ?? null,
          active_user_window: input.active_user_window ?? null,
        } as never,
      },
    });

    if (input.pricing) {
      await this.prisma.segmentOffer.create({
        data: {
          segmentId: segment.id,
          networkId: input.pricing.network_id,
          pricingModel: input.pricing.model as never,
          unitPriceMinor: BigInt(input.pricing.unit_price_minor),
          currency: input.pricing.currency.toUpperCase(),
          visibility: input.pricing.visibility as never,
        },
      });
    }

    await this.audit.record({
      action: 'SEGMENT_CREATED',
      entityType: 'segment',
      entityId: segment.id,
      orgId: partnerOrgId,
      // The bucket is safe to audit; the exact count deliberately is not.
      metadata: { internal_key: input.internal_segment_id, reach_bucket: bucket },
    });

    return this.toWire(segment);
  }

  async update(partnerOrgId: string, segmentId: string, input: UpdateSegmentInput) {
    const segment = await this.requireOwned(partnerOrgId, segmentId);

    const data: Record<string, unknown> = {};
    if (input.display_name) data.displayName = input.display_name;
    if (input.description) data.description = input.description;
    if (input.category) data.category = input.category;
    if (input.geographies) data.geographies = input.geographies;
    if (input.refresh_frequency) data.refreshFrequency = FREQ_TO_DB[input.refresh_frequency];
    if (input.consent_eligibility) data.consentEligibility = input.consent_eligibility;
    if (input.allowed_channels) data.allowedChannels = input.allowed_channels;
    if (input.allowed_categories) data.allowedCategories = input.allowed_categories;
    if (input.blocked_categories) data.blockedCategories = input.blocked_categories;

    if (input.reach_exact_local !== undefined) {
      const minReach = await this.partnerMinReach(partnerOrgId);
      const bucket = this.publishBucket(input.reach_exact_local, minReach);
      if (!bucket) {
        // A published segment that shrinks below the floor is suspended rather
        // than left listed with a stale, over-stated bucket.
        data.reachBucket = BUCKET_TO_DB.UNDER_10K;
        data.status = 'SUSPENDED';
      } else if (this.mayRepublishBucket(segment.reachBucketPublishedAt)) {
        data.reachBucket = BUCKET_TO_DB[bucket];
        data.reachBucketPublishedAt = new Date();
      }
      // Otherwise the new bucket is withheld until the publication interval
      // elapses -- §72's anti-differencing rule.
    }

    data.version = { increment: 1 };

    const updated = await this.prisma.segment.update({
      where: { id: segmentId },
      data: data as never,
    });

    await this.audit.record({
      action: 'SEGMENT_UPDATED',
      entityType: 'segment',
      entityId: segmentId,
      orgId: partnerOrgId,
      metadata: { fields: Object.keys(data) },
    });

    return this.toWire(updated);
  }

  /**
   * §72: published bucket values are cached for a minimum publication
   * interval (default 24h) so repeated refreshes cannot be differenced.
   */
  private mayRepublishBucket(lastPublishedAt: Date | null): boolean {
    if (!lastPublishedAt) return true;
    const intervalMs = this.config.CATALOG_BUCKET_PUBLICATION_INTERVAL_HOURS * 3_600_000;
    return Date.now() - lastPublishedAt.getTime() >= intervalMs;
  }

  async publish(partnerOrgId: string, segmentId: string) {
    const segment = await this.requireOwned(partnerOrgId, segmentId);

    if (!segment.freshnessAt) {
      throw new OolixError(
        'PART_002',
        'Segment has never reported a successful refresh; publish is blocked (spec §38.1 freshness_at).',
      );
    }

    const updated = await this.prisma.segment.update({
      where: { id: segmentId },
      data: { status: 'PUBLISHED' },
    });

    await this.audit.record({
      action: 'SEGMENT_PUBLISHED',
      entityType: 'segment',
      entityId: segmentId,
      orgId: partnerOrgId,
      metadata: { internal_key: segment.internalKey },
    });

    return this.toWire(updated);
  }

  /** Record a refresh and re-bucket. Called after each segment materialization. */
  async reportFreshness(partnerOrgId: string, segmentId: string, input: SegmentFreshnessInput) {
    const segment = await this.requireOwned(partnerOrgId, segmentId);
    const minReach = await this.partnerMinReach(partnerOrgId);
    const bucket = this.publishBucket(input.reach_exact_local, minReach);

    const data: Record<string, unknown> = { freshnessAt: new Date(input.freshness_at) };

    if (!bucket) {
      data.status = 'SUSPENDED';
    } else if (this.mayRepublishBucket(segment.reachBucketPublishedAt)) {
      data.reachBucket = BUCKET_TO_DB[bucket];
      data.reachBucketPublishedAt = new Date();
    }

    const updated = await this.prisma.segment.update({
      where: { id: segmentId },
      data: data as never,
    });
    return this.toWire(updated);
  }

  async list(partnerOrgId: string) {
    const rows = await this.prisma.segment.findMany({
      where: { partnerOrgId },
      orderBy: { createdAt: 'desc' },
      include: { offers: true },
    });
    return rows.map((r) => this.toWire(r));
  }

  async get(partnerOrgId: string, segmentId: string) {
    return this.toWire(await this.requireOwned(partnerOrgId, segmentId));
  }

  private async requireOwned(partnerOrgId: string, segmentId: string) {
    const segment = await this.prisma.segment.findUnique({ where: { id: segmentId } });
    if (!segment) throw new OolixError('PART_001', 'Segment not found.');
    // Ownership, not just existence: returning 404 for another Partner's
    // segment also avoids confirming that it exists.
    if (segment.partnerOrgId !== partnerOrgId) {
      throw new OolixError('PART_001', 'Segment not found.');
    }
    return segment;
  }

  /**
   * Map to the wire shape.
   *
   * There is deliberately no exact-count field to omit here: the column does
   * not exist, so no future edit to this function can leak one.
   */
  private toWire(segment: {
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
    allowedCategories: string[];
    blockedCategories: string[];
    status: string;
    version: number;
    safeMetadata: unknown;
  }) {
    return {
      segment_id: segment.id,
      internal_segment_id: segment.internalKey,
      display_name: segment.displayName,
      description: segment.description,
      category: segment.category,
      geographies: segment.geographies,
      reach_bucket: BUCKET_FROM_DB[segment.reachBucket] ?? segment.reachBucket,
      freshness_at: segment.freshnessAt?.toISOString() ?? null,
      refresh_frequency: DB_TO_FREQ[segment.refreshFrequency] ?? segment.refreshFrequency,
      consent_eligibility: segment.consentEligibility,
      allowed_channels: segment.allowedChannels as Channel[],
      allowed_categories: segment.allowedCategories,
      blocked_categories: segment.blockedCategories,
      status: segment.status,
      version: segment.version,
      safe_metadata: segment.safeMetadata,
    };
  }
}
