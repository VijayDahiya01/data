/**
 * Billing and payout endpoints -- spec v5 §19, §50, §83.1, §102.
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import {
  BillingService,
  CalculatePayoutSchema,
  DisputeSchema,
  ResolveDisputeSchema,
  type CalculatePayoutInput,
  type DisputeInput,
  type ResolveDisputeInput,
} from './billing.service.js';

@Controller('v1/billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  /**
   * §76 PENDING -> CALCULATED. Writes immutable FinancialEvents.
   *
   * Idempotent with financial retention (§99): a retried calculation must not
   * create a second accrual, and the record is kept far longer than the
   * default 24 hours because it underpins a settlement.
   */
  @Post('payouts/calculate')
  @RequirePermissions('payout:read')
  @Idempotent({ retentionHours: 24 * 30 })
  async calculate(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(CalculatePayoutSchema)) body: CalculatePayoutInput,
  ) {
    return this.billing.calculatePayout(p, body);
  }

  /**
   * §50: re-derive a settlement from its immutable inputs.
   *
   * The point of this endpoint is that a Partner does not have to take the
   * figure on trust -- it can be recomputed and compared.
   */
  @Get('payouts/:id/reproduce')
  @RequirePermissions('payout:read')
  async reproduce(@Param('id') id: string) {
    return this.billing.reproduceSettlement(id);
  }

  @Get('payouts')
  @RequirePermissions('payout:read')
  async payouts(@Principal() p: UserPrincipal) {
    return this.billing.payoutsForPartner(p.orgId);
  }

  /** §76: CALCULATED -> REVIEWED. */
  @Post('payouts/:id/review')
  @RequirePermissions('payout:approve')
  async review(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.billing.transition(p, id, 'REVIEWED');
  }

  /** §76: REVIEWED -> APPROVED. */
  @Post('payouts/:id/approve')
  @RequirePermissions('payout:approve')
  async approve(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.billing.transition(p, id, 'APPROVED');
  }

  /** §76: APPROVED -> PAID. */
  @Post('payouts/:id/mark-paid')
  @RequirePermissions('payout:approve')
  @Idempotent({ required: true, retentionHours: 24 * 30 })
  async markPaid(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.billing.transition(p, id, 'PAID');
  }

  /** §83.1: open a dispute. The payout is held until it resolves. */
  @Post('payouts/:id/dispute')
  @RequirePermissions('payout:read')
  async dispute(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DisputeSchema)) body: DisputeInput,
  ) {
    return this.billing.openDispute(p, id, body);
  }

  /** §83.1: resolve. An adjustment is APPENDED; history is never edited. */
  @Post('payouts/:id/resolve-dispute')
  @RequirePermissions('reconciliation:manage')
  async resolveDispute(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResolveDisputeSchema)) body: ResolveDisputeInput,
  ) {
    return this.billing.resolveDispute(p, id, body);
  }

  /** §19: Buyer invoice preview from immutable FinancialEvents. */
  @Get('invoices/preview/:campaignId')
  @RequirePermissions('invoice:read')
  async invoicePreview(@Principal() p: UserPrincipal, @Param('campaignId') campaignId: string) {
    return this.billing.invoicePreview(p.orgId, campaignId);
  }
}
