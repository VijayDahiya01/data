/**
 * Billing, payout and settlement -- spec v5 §19, §50, §76, §83.1, §102.
 *
 * §50 sets four rules that shape every method here:
 *
 *   1. "Create immutable FinancialEvent records separate from raw delivery
 *       event processing."
 *   2. "Do not calculate Partner payout directly from unverified client-side
 *       clicks."
 *   3. "Outcome-based payout should use Buyer CRM statuses and duplicate
 *       rules."
 *   4. "Every financial calculation should be reproducible from immutable
 *       settlement inputs."
 *
 * Rule 4 is the demanding one. It means a settlement figure must be derivable
 * months later from rows that never changed -- so nothing here recomputes from
 * live state, and a correction APPENDS an adjustment rather than editing
 * history (§83.1).
 */
import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import {
  OolixError,
  PAYOUT_TRANSITIONS,
  canTransition,
  isOutcomeBased,
  money,
  multiplyMoney,
  percentageOf,
  addMoney,
  type PayoutState,
  type PricingModel,
} from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';

export const CalculatePayoutSchema = z.object({
  activation_id: z.string().uuid(),
  period_start: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
  period_end: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 date-time'),
});
export type CalculatePayoutInput = z.infer<typeof CalculatePayoutSchema>;

export const DisputeSchema = z.object({
  reason_code: z.enum([
    'QUALIFIED_COUNT_DISPUTED',
    'DUPLICATE_LEADS',
    'DELIVERY_MISMATCH',
    'PRICING_DISAGREEMENT',
    'OTHER',
  ]),
  reason: z.string().min(10).max(1000),
  /** The count the disputing party believes is correct (§102.2). */
  claimed_qualified_count: z.number().int().nonnegative().optional(),
});
export type DisputeInput = z.infer<typeof DisputeSchema>;

export const ResolveDisputeSchema = z.object({
  outcome: z.enum(['ADJUSTED', 'REJECTED_DISPUTE']),
  /** Required when ADJUSTED: the corrected verified count. */
  corrected_qualified_count: z.number().int().nonnegative().optional(),
  resolution_note: z.string().min(10).max(1000),
});
export type ResolveDisputeInput = z.infer<typeof ResolveDisputeSchema>;

/**
 * The immutable inputs a settlement was computed from.
 *
 * §50 rule 4 in concrete form: capture WHAT was counted and WHAT rate applied,
 * so the figure can be re-derived without trusting today's database.
 */
export interface SettlementInputs {
  activation_id: string;
  period_start: string;
  period_end: string;
  pricing_model: PricingModel;
  unit_price_minor: number;
  currency: string;
  platform_fee_bps: number;
  qualified_count: number;
  converted_count: number;
  valid_count: number;
  /** Delivery, for CPM-style models and for the audit trail. */
  impressions: number;
  clicks: number;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // §102 calculation
  // -------------------------------------------------------------------------

  /**
   * Gather the immutable settlement inputs for one activation and period.
   *
   * Outcome counts come from the CURRENT lead state of each attribution token
   * (§102: "the verified CRM-linked QUALIFIED state count"), never from the
   * event log -- a lead that moved RECEIVED -> VALID -> QUALIFIED is ONE
   * qualified lead, not three.
   */
  async gatherInputs(
    activationId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SettlementInputs> {
    const activation = await this.prisma.activation.findUnique({
      where: { id: activationId },
      include: { request: { include: { commercialTerms: true } } },
    });
    if (!activation) throw new OolixError('CAMP_001', 'Activation not found.');

    const terms = activation.request.commercialTerms;
    if (!terms) {
      // §50: without agreed terms there is no defensible basis to pay on.
      throw new OolixError(
        'CAMP_002',
        'This activation has no agreed commercial terms; settlement is not possible (spec §50).',
      );
    }

    const outcomes = await this.prisma.attributionToken.groupBy({
      by: ['leadState'],
      where: { activationId, issuedAt: { gte: periodStart, lt: periodEnd } },
      _count: { _all: true },
    });
    const byState = Object.fromEntries(outcomes.map((o) => [o.leadState, o._count._all]));

    const delivery = await this.prisma.aggregateMetric.aggregate({
      where: { activationId, bucketStart: { gte: periodStart, lt: periodEnd } },
      _sum: { impressions: true, clicks: true },
    });

    return {
      activation_id: activationId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      pricing_model: terms.pricingModel as PricingModel,
      unit_price_minor: Number(terms.unitPriceMinor),
      currency: terms.currency,
      platform_fee_bps: terms.platformFeeBps,
      qualified_count: byState.QUALIFIED ?? 0,
      converted_count: byState.CONVERTED ?? 0,
      valid_count: byState.VALID ?? 0,
      impressions: Number(delivery._sum.impressions ?? 0n),
      clicks: Number(delivery._sum.clicks ?? 0n),
    };
  }

  /**
   * Compute the §102 settlement from immutable inputs.
   *
   * PURE: no database, no clock, no randomness. Given the same inputs it
   * returns the same figures forever, which is exactly what §50 rule 4 asks
   * for and what makes a dispute resolvable rather than a matter of opinion.
   */
  computeSettlement(inputs: SettlementInputs) {
    const unit = money(inputs.unit_price_minor, inputs.currency);

    // §102: a CONVERTED lead passed through QUALIFIED, so it still earns the
    // qualified rate. Counting only leads currently sitting in QUALIFIED would
    // penalise a Partner for the Buyer's later success.
    const payableCount =
      inputs.pricing_model === 'CPQL'
        ? inputs.qualified_count + inputs.converted_count
        : inputs.pricing_model === 'CPL'
          ? inputs.valid_count + inputs.qualified_count + inputs.converted_count
          : inputs.pricing_model === 'CPM'
            ? Math.floor(inputs.impressions / 1000)
            : inputs.pricing_model === 'CPC'
              ? inputs.clicks
              : 0;

    const mediaAmount = multiplyMoney(unit, payableCount);
    const platformFee = percentageOf(mediaAmount, inputs.platform_fee_bps);
    const invoiceSubtotal = addMoney(mediaAmount, platformFee);

    return {
      // §102: "Partner payout basis = INR 450,000" -- the media amount, with
      // the platform fee charged to the Buyer ON TOP rather than deducted.
      payable_count: payableCount,
      media_amount_minor: mediaAmount.amount_minor,
      platform_fee_minor: platformFee.amount_minor,
      invoice_subtotal_minor: invoiceSubtotal.amount_minor,
      partner_payout_basis_minor: mediaAmount.amount_minor,
      currency: inputs.currency,
      /** §50: outcome models settle on CRM-verified outcomes only. */
      settles_on_verified_outcomes: isOutcomeBased(inputs.pricing_model),
    };
  }

  /**
   * §76 PENDING -> CALCULATED. Writes immutable FinancialEvents.
   */
  async calculatePayout(principal: UserPrincipal, input: CalculatePayoutInput) {
    const periodStart = new Date(input.period_start);
    const periodEnd = new Date(input.period_end);

    const activation = await this.prisma.activation.findFirst({
      where: {
        id: input.activation_id,
        OR: [
          { request: { partnerOrgId: principal.orgId } },
          { request: { campaign: { buyerOrgId: principal.orgId } } },
        ],
      },
      include: { request: { include: { campaign: true } } },
    });
    if (!activation) throw new OolixError('CAMP_001', 'Activation not found.');

    const inputs = await this.gatherInputs(input.activation_id, periodStart, periodEnd);
    const settlement = this.computeSettlement(inputs);

    const sourceRef = `settlement:${input.activation_id}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;

    const payout = await this.prisma.$transaction(async (tx) => {
      // §50 rule 1: FinancialEvents are immutable and separate from delivery
      // processing. The unique constraint on (activation, type, source_ref)
      // makes a re-run idempotent rather than duplicating the accrual.
      const events = [
        {
          eventType: 'OUTCOME_ACCRUAL' as const,
          quantity: BigInt(settlement.payable_count),
          amountMinor: BigInt(settlement.media_amount_minor),
        },
        {
          eventType: 'PLATFORM_FEE' as const,
          quantity: 0n,
          amountMinor: BigInt(settlement.platform_fee_minor),
        },
        {
          eventType: 'PARTNER_PAYOUT_BASIS' as const,
          quantity: BigInt(settlement.payable_count),
          amountMinor: BigInt(settlement.partner_payout_basis_minor),
        },
      ];

      for (const e of events) {
        await tx.financialEvent.upsert({
          where: {
            activationId_eventType_sourceRef: {
              activationId: input.activation_id,
              eventType: e.eventType,
              sourceRef,
            },
          },
          create: {
            activationId: input.activation_id,
            eventType: e.eventType,
            quantity: e.quantity,
            amountMinor: e.amountMinor,
            currency: inputs.currency,
            sourceRef,
            periodStart,
            periodEnd,
          },
          // §50 rule 1 / §83.1: an existing event is NEVER edited. A different
          // figure must arrive as an ADJUSTMENT so history stays intact.
          update: {},
        });
      }

      return tx.payout.upsert({
        where: {
          activationId_periodStart_periodEnd: {
            activationId: input.activation_id,
            periodStart,
            periodEnd,
          },
        },
        create: {
          partnerOrgId: activation.request.partnerOrgId,
          activationId: input.activation_id,
          eligibleAmountMinor: BigInt(settlement.partner_payout_basis_minor),
          currency: inputs.currency,
          status: 'CALCULATED',
          periodStart,
          periodEnd,
          calculatedAt: new Date(),
        },
        update: {},
      });
    });

    await this.audit.record({
      action: 'PARTNER_PAYOUT_CALCULATED',
      entityType: 'payout',
      entityId: payout.id,
      orgId: activation.request.partnerOrgId,
      metadata: { source_ref: sourceRef, ...settlement, inputs },
    });

    return {
      payout_id: payout.id,
      status: payout.status,
      // Returned in full so the figure is auditable without a second call --
      // and so a Partner can reproduce the arithmetic themselves.
      settlement_inputs: inputs,
      settlement,
      source_ref: sourceRef,
    };
  }

  /**
   * Recompute a settlement from its stored immutable inputs.
   *
   * This is §50 rule 4 made testable: it re-derives the figure from the
   * audited inputs and reports whether it matches what was recorded. A
   * mismatch means the calculation changed under a Partner's feet, which is
   * exactly the class of bug that destroys trust in a payout.
   */
  async reproduceSettlement(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new OolixError('CAMP_001', 'Payout not found.');

    const audit = await this.prisma.auditEvent.findFirst({
      where: { entityType: 'payout', entityId: payoutId, action: 'PARTNER_PAYOUT_CALCULATED' },
      orderBy: { timestamp: 'asc' },
    });
    if (!audit) throw new OolixError('CAMP_001', 'No recorded settlement inputs for this payout.');

    const recorded = audit.metadata as unknown as {
      inputs: SettlementInputs;
      partner_payout_basis_minor: number;
      platform_fee_minor: number;
      invoice_subtotal_minor: number;
    };

    const recomputed = this.computeSettlement(recorded.inputs);

    const matches =
      recomputed.partner_payout_basis_minor === recorded.partner_payout_basis_minor &&
      recomputed.platform_fee_minor === recorded.platform_fee_minor &&
      recomputed.invoice_subtotal_minor === recorded.invoice_subtotal_minor &&
      recomputed.partner_payout_basis_minor === Number(payout.eligibleAmountMinor);

    return {
      payout_id: payoutId,
      reproducible: matches,
      original: {
        partner_payout_basis_minor: recorded.partner_payout_basis_minor,
        platform_fee_minor: recorded.platform_fee_minor,
        invoice_subtotal_minor: recorded.invoice_subtotal_minor,
      },
      recomputed: {
        partner_payout_basis_minor: recomputed.partner_payout_basis_minor,
        platform_fee_minor: recomputed.platform_fee_minor,
        invoice_subtotal_minor: recomputed.invoice_subtotal_minor,
      },
      inputs: recorded.inputs,
      note: matches
        ? 'Recomputed from the immutable settlement inputs and matched (spec §50).'
        : 'MISMATCH: the recorded figure cannot be reproduced from its inputs.',
    };
  }

  // -------------------------------------------------------------------------
  // §76 / §83.1 payout state machine
  // -------------------------------------------------------------------------

  async transition(
    principal: UserPrincipal,
    payoutId: string,
    to: PayoutState,
    metadata: Record<string, unknown> = {},
  ) {
    const payout = await this.prisma.payout.findFirst({
      where: {
        id: payoutId,
        OR: [
          { partnerOrgId: principal.orgId },
          { activation: { request: { campaign: { buyerOrgId: principal.orgId } } } },
        ],
      },
    });
    if (!payout) throw new OolixError('CAMP_001', 'Payout not found.');

    const from = payout.status as PayoutState;
    if (!canTransition(PAYOUT_TRANSITIONS, from, to)) {
      throw new OolixError(
        'CAMP_002',
        `Cannot move a payout from ${from} to ${to} (spec §76, §83.1).`,
      );
    }

    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: to as never,
        ...(to === 'PAID' ? { paidAt: new Date() } : {}),
      },
    });

    await this.audit.record({
      action: `PAYOUT_${to}`,
      entityType: 'payout',
      entityId: payoutId,
      orgId: payout.partnerOrgId,
      metadata: { from, to, ...metadata },
    });

    return { payout_id: payoutId, status: updated.status, previous_status: from };
  }

  /**
   * §83.1: open a dispute.
   *
   * "Payout remains on hold while DISPUTED." The state change itself is the
   * hold: nothing can reach PAID from DISPUTED without passing through
   * ADJUSTED or REJECTED_DISPUTE and then APPROVED.
   */
  async openDispute(principal: UserPrincipal, payoutId: string, input: DisputeInput) {
    const result = await this.transition(principal, payoutId, 'DISPUTED', {
      reason_code: input.reason_code,
      reason: input.reason,
      claimed_qualified_count: input.claimed_qualified_count ?? null,
    });

    await this.prisma.payout.update({
      where: { id: payoutId },
      data: { disputeReason: `${input.reason_code}: ${input.reason}` },
    });

    return {
      ...result,
      on_hold: true,
      note: 'Payout is on hold until the dispute is resolved (spec §83.1).',
    };
  }

  /**
   * §83.1: resolve a dispute.
   *
   * A validated correction creates an ADJUSTMENT FinancialEvent. §83.1 is
   * explicit: "Corrections create adjustment FinancialEvents; never mutate
   * historical FinancialEvents." The original accrual stays exactly as it was,
   * so the trail shows what was claimed, what was corrected, and by how much.
   */
  async resolveDispute(principal: UserPrincipal, payoutId: string, input: ResolveDisputeInput) {
    // §83.1: "Buyer/Partner dispute opens DISPUTED payout state." Resolution
    // is therefore reachable from either side of the arrangement -- scoping it
    // to the Partner alone would leave a Buyer-raised dispute unresolvable by
    // the party that raised it.
    const payout = await this.prisma.payout.findFirst({
      where: {
        id: payoutId,
        OR: [
          { partnerOrgId: principal.orgId },
          { activation: { request: { campaign: { buyerOrgId: principal.orgId } } } },
        ],
      },
      include: { activation: { include: { request: { include: { commercialTerms: true } } } } },
    });
    if (!payout) throw new OolixError('CAMP_001', 'Payout not found.');
    if (payout.status !== 'DISPUTED') {
      throw new OolixError('CAMP_002', 'Only a DISPUTED payout can be resolved.');
    }

    if (input.outcome === 'REJECTED_DISPUTE') {
      const result = await this.transition(principal, payoutId, 'REJECTED_DISPUTE', {
        resolution_note: input.resolution_note,
      });
      return {
        ...result,
        adjustment_minor: 0,
        note: 'Dispute rejected; the original figure stands.',
      };
    }

    if (input.corrected_qualified_count === undefined) {
      throw new OolixError('VAL_001', 'An adjusted resolution requires the corrected count.', {
        fieldErrors: [{ field: 'corrected_qualified_count', message: 'required for ADJUSTED' }],
      });
    }

    const terms = payout.activation.request.commercialTerms;
    if (!terms) throw new OolixError('CAMP_002', 'Activation has no commercial terms.');

    // §102.2 worked example: 100 -> 98 qualified = 98 x 4,500 = INR 441,000.
    const unit = money(Number(terms.unitPriceMinor), terms.currency);
    const correctedBasis = multiplyMoney(unit, input.corrected_qualified_count);
    const originalBasis = Number(payout.eligibleAmountMinor);
    const delta = correctedBasis.amount_minor - originalBasis;

    const sourceRef = `dispute-adjustment:${payoutId}:${Date.now()}`;

    await this.prisma.$transaction(async (tx) => {
      // The ORIGINAL accrual is untouched. This is a new, additional row.
      await tx.financialEvent.create({
        data: {
          activationId: payout.activationId,
          eventType: 'ADJUSTMENT',
          quantity: BigInt(input.corrected_qualified_count!),
          amountMinor: BigInt(delta),
          currency: terms.currency,
          sourceRef,
          periodStart: payout.periodStart,
          periodEnd: payout.periodEnd,
        },
      });

      await tx.payout.update({
        where: { id: payoutId },
        data: {
          status: 'ADJUSTED',
          adjustmentMinor: BigInt(delta),
          disputeReason: `${payout.disputeReason ?? ''} | RESOLVED: ${input.resolution_note}`,
        },
      });
    });

    await this.audit.record({
      action: 'PAYOUT_ADJUSTED',
      entityType: 'payout',
      entityId: payoutId,
      orgId: payout.partnerOrgId,
      metadata: {
        original_basis_minor: originalBasis,
        corrected_basis_minor: correctedBasis.amount_minor,
        adjustment_minor: delta,
        corrected_count: input.corrected_qualified_count,
        resolution_note: input.resolution_note,
      },
    });

    return {
      payout_id: payoutId,
      status: 'ADJUSTED',
      original_basis_minor: originalBasis,
      corrected_basis_minor: correctedBasis.amount_minor,
      adjustment_minor: delta,
      note: 'An ADJUSTMENT event was appended; the original accrual is unchanged (spec §83.1).',
    };
  }

  // -------------------------------------------------------------------------
  // §19 invoice and payout views
  // -------------------------------------------------------------------------

  /** §19: the Buyer invoice preview -- media/outcome spend + platform fee. */
  async invoicePreview(buyerOrgId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, buyerOrgId },
      include: {
        partnerRequests: {
          include: {
            organization: { select: { name: true } },
            activations: { include: { financialEvents: true } },
          },
        },
      },
    });
    if (!campaign) throw new OolixError('CAMP_001', 'Campaign not found.');

    const lines = [];
    let mediaTotal = 0;
    let feeTotal = 0;
    let adjustmentTotal = 0;

    for (const request of campaign.partnerRequests) {
      for (const activation of request.activations) {
        const media = activation.financialEvents
          .filter((e) => e.eventType === 'OUTCOME_ACCRUAL' || e.eventType === 'MEDIA_ACCRUAL')
          .reduce((s, e) => s + Number(e.amountMinor), 0);
        const fee = activation.financialEvents
          .filter((e) => e.eventType === 'PLATFORM_FEE')
          .reduce((s, e) => s + Number(e.amountMinor), 0);
        const adjustments = activation.financialEvents
          .filter((e) => e.eventType === 'ADJUSTMENT')
          .reduce((s, e) => s + Number(e.amountMinor), 0);

        if (media === 0 && fee === 0 && adjustments === 0) continue;

        lines.push({
          partner: request.organization.name,
          activation_id: activation.id,
          channel: activation.channel,
          media_minor: media,
          platform_fee_minor: fee,
          adjustments_minor: adjustments,
        });

        mediaTotal += media;
        feeTotal += fee;
        adjustmentTotal += adjustments;
      }
    }

    return {
      campaign_id: campaignId,
      currency: campaign.currency,
      lines,
      totals: {
        media_minor: mediaTotal,
        platform_fee_minor: feeTotal,
        adjustments_minor: adjustmentTotal,
        // §19: taxes are configured per jurisdiction. §81 warns against
        // hard-coding one, so the field is present and explicitly unset.
        tax_minor: 0,
        subtotal_minor: mediaTotal + feeTotal + adjustmentTotal,
      },
      budget_minor: Number(campaign.budgetMinor),
      remaining_headroom_minor:
        Number(campaign.budgetMinor) - (mediaTotal + feeTotal + adjustmentTotal),
      note:
        'Preview computed from immutable FinancialEvents. Tax treatment is ' +
        'configured per jurisdiction and is not assumed here (spec §19, §81).',
    };
  }

  /** §98.2: the Partner's payout view. */
  async payoutsForPartner(partnerOrgId: string) {
    const payouts = await this.prisma.payout.findMany({
      where: { partnerOrgId },
      include: {
        activation: {
          include: {
            request: {
              include: { campaign: { include: { organization: { select: { name: true } } } } },
            },
            financialEvents: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      items: payouts.map((p) => ({
        payout_id: p.id,
        activation_id: p.activationId,
        buyer: p.activation.request.campaign.organization.name,
        campaign: p.activation.request.campaign.name,
        status: p.status,
        eligible_amount_minor: Number(p.eligibleAmountMinor),
        adjustment_minor: Number(p.adjustmentMinor),
        net_payable_minor: Number(p.eligibleAmountMinor) + Number(p.adjustmentMinor),
        currency: p.currency,
        period: { start: p.periodStart.toISOString(), end: p.periodEnd.toISOString() },
        dispute_reason: p.disputeReason,
        // Every event that contributed, so a Partner can audit the figure.
        financial_events: p.activation.financialEvents.map((e) => ({
          type: e.eventType,
          quantity: Number(e.quantity),
          amount_minor: Number(e.amountMinor),
          source_ref: e.sourceRef,
          created_at: e.createdAt.toISOString(),
        })),
      })),
      next_cursor: null,
    };
  }
}
