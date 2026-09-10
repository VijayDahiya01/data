/**
 * Delivery ingest, aggregation and reconciliation -- spec v5 §18, §49, §57,
 * §77.3.
 *
 * The Agent counts locally and uploads AGGREGATES (§27: "Batch reporting
 * instead of one central event request per impression"). Oolix never receives
 * a per-impression event, which is both a scale decision and a privacy one --
 * a per-impression feed would be a behavioural stream about individuals even
 * without an identifier attached.
 *
 * §77.3 then reconciles what the Agent counted against what Oolix recorded,
 * and a difference beyond tolerance raises a review rather than silently
 * changing anyone's money.
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

/** §52.4 POST /agent/v1/reporting/batches. */
export const DeliveryBatchSchema = z.object({
  /** §22.3 idempotency: partner_id + batch_id. */
  batch_id: z.string().min(1).max(200),
  counters: z
    .array(
      z.object({
        activation_id: z.string().uuid(),
        /** Hour bucket the counts belong to (§18 time bucket). */
        bucket_start: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
        impressions: z.number().int().nonnegative(),
        clicks: z.number().int().nonnegative(),
        /** Agent-side estimated spend, reconciled centrally (§76.1). */
        spend_minor: z.number().int().nonnegative().default(0),
      }),
    )
    .min(1)
    // §103: "Accept/queue a 10,000-counter batch in <5s under pilot load."
    .max(10_000),
  /** §92.4 optional tamper evidence over the batch body. */
  payload_signature: z.string().optional(),
});
export type DeliveryBatchInput = z.infer<typeof DeliveryBatchSchema>;

@Injectable()
export class ReportingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  /**
   * Ingest a delivery batch from a Partner Agent.
   *
   * §57: "Duplicate report batch -> deduplicate by partner_id + batch_id ->
   * No duplicate metric." The Agent retries with the same batch_id after a
   * network failure, so this MUST be idempotent or every retry inflates
   * delivery and, for CPM-style terms, the amount owed.
   */
  async ingestBatch(partnerOrgId: string, agentId: string, input: DeliveryBatchInput) {
    const existing = await this.prisma.deliveryBatch.findUnique({
      where: { partnerOrgId_batchId: { partnerOrgId, batchId: input.batch_id } },
    });
    if (existing) {
      return {
        accepted: true,
        duplicate: true,
        batch_id: input.batch_id,
        counters_applied: 0,
      };
    }

    // Only activations belonging to THIS Partner may be counted. Without the
    // check an Agent could inflate another Partner's delivery.
    const activationIds = [...new Set(input.counters.map((c) => c.activation_id))];
    const owned = await this.prisma.activation.findMany({
      where: { id: { in: activationIds }, request: { partnerOrgId } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));
    const foreign = activationIds.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      throw new OolixError('PERM_002', 'One or more activations do not belong to this Partner.');
    }

    let applied = 0;

    await this.prisma.$transaction(async (tx) => {
      // The batch row and the counters commit together: a batch recorded
      // without its counters would be permanently skipped as a duplicate.
      await tx.deliveryBatch.create({
        data: {
          partnerOrgId,
          agentId,
          batchId: input.batch_id,
          counterCount: input.counters.length,
        },
      });

      for (const counter of input.counters) {
        // §18 / §73: bucket to the hour. aggregate_metrics is keyed by
        // (activation_id, bucket_start), so re-ingesting the same hour ADDS
        // rather than replaces -- an Agent uploads deltas, not totals.
        const bucketStart = this.hourBucket(new Date(counter.bucket_start));

        await tx.aggregateMetric.upsert({
          where: { activationId_bucketStart: { activationId: counter.activation_id, bucketStart } },
          create: {
            activationId: counter.activation_id,
            bucketStart,
            impressions: BigInt(counter.impressions),
            clicks: BigInt(counter.clicks),
            spendMinor: BigInt(counter.spend_minor),
          },
          update: {
            impressions: { increment: BigInt(counter.impressions) },
            clicks: { increment: BigInt(counter.clicks) },
            spendMinor: { increment: BigInt(counter.spend_minor) },
          },
        });
        applied += 1;
      }

      // An activation that has delivered is LIVE (§76 state machine).
      await tx.activation.updateMany({
        where: { id: { in: activationIds }, status: 'READY' },
        data: { status: 'LIVE', startedAt: new Date() },
      });
    });

    await this.audit.record({
      action: 'DELIVERY_BATCH_ACCEPTED',
      entityType: 'delivery_batch',
      entityId: input.batch_id,
      orgId: partnerOrgId,
      actorType: 'AGENT',
      actor: agentId,
      metadata: { counters: applied, signed: Boolean(input.payload_signature) },
    });

    return {
      accepted: true,
      duplicate: false,
      batch_id: input.batch_id,
      counters_applied: applied,
    };
  }

  private hourBucket(d: Date): Date {
    const b = new Date(d);
    b.setUTCMinutes(0, 0, 0);
    return b;
  }

  // -------------------------------------------------------------------------
  // §49 reporting
  // -------------------------------------------------------------------------

  /**
   * §49 / §98.3 Buyer campaign report.
   *
   * Delivery comes from Agent aggregates; outcomes come from the CRM lead
   * states. §49 keeps them distinct because they are verified differently:
   * a Partner counts an impression, a BUYER confirms a qualified lead.
   */
  async campaignReport(buyerOrgId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId },
      include: {
        partnerRequests: {
          include: {
            organization: { select: { id: true, name: true } },
            segment: { select: { displayName: true } },
            // v6 §19: a request targets an Audience Group or a prebuilt
            // segment; the report names whichever it was.
            audienceGroup: { select: { name: true } },
            commercialTerms: true,
            activations: { include: { metrics: true } },
          },
        },
      },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');

    const perPartner = [];
    let totals = {
      impressions: 0,
      clicks: 0,
      spendMinor: 0,
      received: 0,
      valid: 0,
      qualified: 0,
      converted: 0,
      rejected: 0,
    };

    for (const request of campaign.partnerRequests) {
      for (const activation of request.activations) {
        const delivery = activation.metrics.reduce(
          (acc, m) => ({
            impressions: acc.impressions + Number(m.impressions),
            clicks: acc.clicks + Number(m.clicks),
            spendMinor: acc.spendMinor + Number(m.spendMinor),
          }),
          { impressions: 0, clicks: 0, spendMinor: 0 },
        );

        const outcomes = await this.outcomeCounts(activation.id);

        const unitPrice = request.commercialTerms
          ? Number(request.commercialTerms.unitPriceMinor)
          : 0;
        const pricingModel = request.commercialTerms?.pricingModel ?? null;

        // §102: for CPQL the payout basis is unit price x VERIFIED qualified
        // leads. Never derived from clicks (§50).
        const outcomeBasisMinor =
          pricingModel === 'CPQL'
            ? unitPrice * outcomes.qualified
            : pricingModel === 'CPL'
              ? unitPrice * (outcomes.valid + outcomes.qualified + outcomes.converted)
              : 0;

        perPartner.push({
          partner: { id: request.organization.id, name: request.organization.name },
          // v6 §19: whichever targeting model produced this activation.
          segment: request.segment?.displayName ?? null,
          audience: request.audienceGroup?.name ?? null,
          activation_id: activation.id,
          channel: activation.channel,
          status: activation.status,
          delivery: {
            impressions: delivery.impressions,
            clicks: delivery.clicks,
            ctr: delivery.impressions > 0 ? delivery.clicks / delivery.impressions : null,
          },
          outcomes,
          cost: {
            pricing_model: pricingModel,
            unit_price_minor: unitPrice,
            outcome_basis_minor: outcomeBasisMinor,
            currency: activation.currency,
          },
          quality: {
            // §49: CPQL and lead rate, but only where the sample supports it.
            // A CPQL computed from three leads is noise presented as insight.
            cpql_minor:
              outcomes.qualified > 0 ? Math.round(outcomeBasisMinor / outcomes.qualified) : null,
            lead_rate: delivery.clicks > 0 ? outcomes.received / delivery.clicks : null,
            qualified_rate: outcomes.received > 0 ? outcomes.qualified / outcomes.received : null,
            sufficient_sample: outcomes.received >= 30,
          },
        });

        totals = {
          impressions: totals.impressions + delivery.impressions,
          clicks: totals.clicks + delivery.clicks,
          spendMinor: totals.spendMinor + delivery.spendMinor,
          received: totals.received + outcomes.received,
          valid: totals.valid + outcomes.valid,
          qualified: totals.qualified + outcomes.qualified,
          converted: totals.converted + outcomes.converted,
          rejected: totals.rejected + outcomes.rejected,
        };
      }
    }

    return {
      campaign_id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      currency: campaign.currency,
      budget_minor: Number(campaign.budgetMinor),
      totals: {
        impressions: totals.impressions,
        clicks: totals.clicks,
        ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
        // §49 lead funnel.
        funnel: {
          received: totals.received,
          valid: totals.valid,
          qualified: totals.qualified,
          converted: totals.converted,
          rejected: totals.rejected,
        },
      },
      by_partner: perPartner,
      /**
       * §72 / §13: per-Partner figures are independent. Users may overlap
       * across Partners and the MVP has no cross-partner identity graph, so
       * these rows are not deduplicated people.
       */
      notice:
        'Per-Partner delivery is independent and NOT deduplicated across Partners ' +
        '(spec §13, §72, §104).',
    };
  }

  /** §98.2 Partner-facing report. Never exposes another Partner's figures. */
  async partnerReport(partnerOrgId: string) {
    const activations = await this.prisma.activation.findMany({
      where: { request: { partnerOrgId } },
      include: {
        metrics: true,
        request: {
          include: {
            campaign: { include: { organization: { select: { name: true } } } },
            commercialTerms: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const items = [];
    for (const a of activations) {
      const delivery = a.metrics.reduce(
        (acc, m) => ({
          impressions: acc.impressions + Number(m.impressions),
          clicks: acc.clicks + Number(m.clicks),
        }),
        { impressions: 0, clicks: 0 },
      );
      const outcomes = await this.outcomeCounts(a.id);
      const terms = a.request.commercialTerms;
      const unitPrice = terms ? Number(terms.unitPriceMinor) : 0;

      items.push({
        activation_id: a.id,
        buyer_name: a.request.campaign.organization.name,
        campaign_name: a.request.campaign.name,
        channel: a.channel,
        status: a.status,
        approved_allocation_minor: Number(a.budgetMinor),
        delivery,
        outcomes,
        revenue: {
          pricing_model: terms?.pricingModel ?? null,
          unit_price_minor: unitPrice,
          // §98.2: accrual, not a promise of payment. Settlement runs through
          // §83's dispute and reconciliation workflow.
          accrued_minor: terms?.pricingModel === 'CPQL' ? unitPrice * outcomes.qualified : 0,
          currency: a.currency,
        },
      });
    }

    return { items, next_cursor: null };
  }

  private async outcomeCounts(activationId: string) {
    const rows = await this.prisma.attributionToken.groupBy({
      by: ['leadState'],
      where: { activationId },
      _count: { _all: true },
    });
    const byState = Object.fromEntries(rows.map((r) => [r.leadState, r._count._all]));
    return {
      received: byState.RECEIVED ?? 0,
      valid: byState.VALID ?? 0,
      qualified: byState.QUALIFIED ?? 0,
      converted: byState.CONVERTED ?? 0,
      rejected: byState.REJECTED ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // §77.3 reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile Agent-reported counts against central figures.
   *
   * §77.3 sets the tolerance and, importantly, the consequence:
   *
   *   "Differences above threshold create RECONCILIATION_REVIEW; they do not
   *    automatically alter Partner payout."
   *
   * A discrepancy is a question for a human, not a licence for the system to
   * quietly pay less.
   */
  async reconcile(activationId: string, bucketDate: Date, agentCount: bigint) {
    const dayStart = new Date(bucketDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const metrics = await this.prisma.aggregateMetric.findMany({
      where: { activationId, bucketStart: { gte: dayStart, lt: dayEnd } },
      select: { impressions: true },
    });
    const centralCount = metrics.reduce((sum, m) => sum + m.impressions, 0n);

    const difference =
      agentCount > centralCount ? agentCount - centralCount : centralCount - agentCount;

    // §77.3: tolerance = max(10 events, 0.5% of the Agent's accepted count).
    const percentTolerance = BigInt(
      Math.floor((Number(agentCount) * this.config.RECONCILIATION_PERCENT) / 100),
    );
    const minEvents = BigInt(this.config.RECONCILIATION_MIN_EVENTS);
    const tolerance = percentTolerance > minEvents ? percentTolerance : minEvents;

    const status = difference <= tolerance ? 'PASS' : 'REVIEW_REQUIRED';

    await this.prisma.reconciliation.upsert({
      where: { activationId_bucketDate: { activationId, bucketDate: dayStart } },
      create: {
        activationId,
        bucketDate: dayStart,
        agentCount,
        centralCount,
        differenceAbs: difference,
        tolerance,
        status: status as never,
        reason: status === 'PASS' ? null : 'Difference exceeds the §77.3 tolerance.',
      },
      update: {
        agentCount,
        centralCount,
        differenceAbs: difference,
        tolerance,
        status: status as never,
      },
    });

    if (status === 'REVIEW_REQUIRED') {
      await this.audit.record({
        action: 'RECONCILIATION_REVIEW_REQUIRED',
        entityType: 'activation',
        entityId: activationId,
        metadata: {
          agent_count: agentCount.toString(),
          central_count: centralCount.toString(),
          difference: difference.toString(),
          tolerance: tolerance.toString(),
        },
      });
    }

    return {
      activation_id: activationId,
      bucket_date: dayStart.toISOString().slice(0, 10),
      agent_count: Number(agentCount),
      central_count: Number(centralCount),
      difference: Number(difference),
      tolerance: Number(tolerance),
      status,
      note:
        status === 'PASS'
          ? null
          : 'Flagged for review. Partner payout is NOT automatically adjusted (spec §77.3).',
    };
  }
}
