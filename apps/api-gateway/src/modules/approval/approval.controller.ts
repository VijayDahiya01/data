/**
 * Approval endpoints -- spec v5 §52.3, §67.3, §67.4.
 *
 * Two audiences on separate routes: the Buyer submits, the Partner decides.
 * §31 makes the split structural -- "Campaign approval: Oolix builds the
 * workflow, the Data Partner makes the final decision" -- so no Buyer
 * permission can reach a decision endpoint.
 */
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import type { UserPrincipal } from '@oolix/auth-rbac';
import type { PartnerRequestState } from '@oolix/contracts';
import { RequirePermissions, RequireVerifiedBusiness } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ApprovalService } from './approval.service.js';
import {
  ApproveSchema,
  ExtendSchema,
  RejectSchema,
  RequestChangeSchema,
  RevokeSchema,
  type ApproveInput,
  type ExtendInput,
  type RejectInput,
  type RequestChangeInput,
  type RevokeInput,
} from './approval.schema.js';

/** Buyer side: submit a draft for review (§67.3). */
@Controller('v1/campaigns')
export class CampaignSubmitController {
  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Post(':id/submit')
  @RequirePermissions('campaign:submit')
  @RequireVerifiedBusiness()
  // §53: required. A retried submit must not start a second review clock.
  @Idempotent({ required: true })
  async submit(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.approvals.submitCampaign(p, id);
  }
}

/** Partner side: the §41 approval centre. */
@Controller('v1/partner-requests')
export class PartnerRequestController {
  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Get()
  @RequirePermissions('report:read')
  async list(@Principal() p: UserPrincipal, @Query('status') status?: string) {
    return this.approvals.listForPartner(p, status as PartnerRequestState | undefined);
  }

  /** §41: everything the Partner needs before deciding, in one response. */
  @Get(':id')
  @RequirePermissions('report:read')
  async get(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.approvals.getForPartner(p, id);
  }

  @Post(':id/approve')
  @RequirePermissions('request:approve')
  // §53 / §22.3: required. A retried approval must not create a second
  // activation, and therefore a second manifest and a second payout basis.
  @Idempotent({ required: true })
  async approve(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApproveSchema)) body: ApproveInput,
  ) {
    return this.approvals.approve(p, id, body);
  }

  @Post(':id/request-change')
  @RequirePermissions('request:change')
  async requestChange(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequestChangeSchema)) body: RequestChangeInput,
  ) {
    return this.approvals.requestChange(p, id, body);
  }

  @Post(':id/reject')
  @RequirePermissions('request:reject')
  async reject(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectSchema)) body: RejectInput,
  ) {
    return this.approvals.reject(p, id, body);
  }

  /** §41 / §57: stop an approved or live activation. */
  @Post(':id/revoke')
  @RequirePermissions('request:revoke')
  async revoke(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RevokeSchema)) body: RevokeInput,
  ) {
    return this.approvals.revoke(p, id, body);
  }

  /** §101: extend the review window once. PARTNER_ADMIN, not the approver. */
  @Post(':id/extend')
  @RequirePermissions('request:extend')
  async extend(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExtendSchema)) body: ExtendInput,
  ) {
    return this.approvals.extend(p, id, body);
  }
}
